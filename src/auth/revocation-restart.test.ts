/**
 * Revoked access tokens must stay rejected after a restart.
 *
 * - Default (in-memory signing key): a restart mints a new key, so every token from
 *   the previous process, revoked or not, fails signature verification.
 * - KAIA_OAUTH_SIGNING_KEY_FILE: the key survives, so the jti denylist must survive
 *   too. It is persisted to revoked-jti.json next to the key (or KAIA_OAUTH_REVOCATION_FILE).
 *   An unreadable or corrupt denylist refuses startup instead of starting empty.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runKaiaMcpServerHttp, type KaiaHttpServerHandle } from "../server.js";
import { resetConfigCache } from "../config.js";
import { AUTH_ERRORS, SCOPES } from "./constants.js";

const SECRET = "test-only-introspection-secret";

/** The issuer embeds the port, so a restart must reuse it for old tokens to keep their iss. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * fetch with one retry when undici hands back a pooled keep-alive socket that the
 * previous (now closed) server instance already hung up.
 */
async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const code = (err as { cause?: { code?: string } }).cause?.code;
    if (code !== "UND_ERR_SOCKET") throw err;
    return fetch(url, init);
  }
}

async function mcpInitialize(
  base: string,
  token: string
): Promise<{ status: number; body: unknown }> {
  const res = await send(base, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "restart-test", version: "1.0.0" },
      },
    }),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // SSE answer for a successful initialize
  }
  return { status: res.status, body };
}

async function revokeOverHttp(base: string, token: string): Promise<number> {
  const res = await send(`${base}/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  return res.status;
}

async function introspect(base: string, token: string): Promise<Record<string, unknown>> {
  const res = await send(`${base}/oauth/introspect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`kaia-mcp-gateway:${SECRET}`).toString("base64")}`,
    },
    body: new URLSearchParams({ token }),
  });
  return (await res.json()) as Record<string, unknown>;
}

const INVALID = {
  jsonrpc: "2.0",
  error: {
    code: AUTH_ERRORS.INVALID_TOKEN.code,
    message: AUTH_ERRORS.INVALID_TOKEN.message,
    data: { error: "invalid_token" },
  },
  id: null,
};

describe("revocation across restart", () => {
  let handle: KaiaHttpServerHandle | undefined;
  let dir: string;
  let port: number;

  beforeEach(async () => {
    port = await freePort();
    dir = mkdtempSync(join(tmpdir(), "kaia-revoke-"));
    process.env.LOG_LEVEL = "error";
    process.env.KAIA_AUTH_MODE = "required";
    process.env.KAIA_INTROSPECTION_CLIENT_SECRET = SECRET;
    resetConfigCache();
  });

  afterEach(async () => {
    if (handle) await handle.close();
    handle = undefined;
    for (const k of [
      "LOG_LEVEL",
      "KAIA_AUTH_MODE",
      "KAIA_INTROSPECTION_CLIENT_SECRET",
      "KAIA_OAUTH_SIGNING_KEY_FILE",
      "KAIA_OAUTH_REVOCATION_FILE",
    ]) {
      delete process.env[k];
    }
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  async function restart(): Promise<KaiaHttpServerHandle> {
    if (handle) await handle.close();
    handle = undefined;
    resetConfigCache();
    handle = await runKaiaMcpServerHttp(port);
    return handle;
  }

  it("in-memory key: a restart invalidates every earlier token, revoked or not", async () => {
    const a = await restart();
    const revoked = a.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    const kept = a.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    expect(await revokeOverHttp(a.issuer, revoked)).toBe(200);
    const kidA = a.oauth.signingKey.kid;

    const b = await restart();
    expect(b.issuer).toBe(a.issuer);
    expect(b.oauth.signingKey.kid).not.toBe(kidA);
    for (const token of [revoked, kept]) {
      const res = await mcpInitialize(b.issuer, token);
      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID);
    }
  });

  it("persisted key: a revoked token stays rejected after restart while others still work", async () => {
    const keyFile = join(dir, "signing-key.pem");
    process.env.KAIA_OAUTH_SIGNING_KEY_FILE = keyFile;
    const a = await restart();
    const revoked = a.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    const kept = a.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    expect(await revokeOverHttp(a.issuer, revoked)).toBe(200);
    expect((await mcpInitialize(a.issuer, revoked)).status).toBe(401);

    const denylist = join(dir, "revoked-jti.json");
    expect(statSync(denylist).mode & 0o777).toBe(0o600);
    const onDisk = readFileSync(denylist, "utf8");
    expect(onDisk).not.toContain(revoked);
    const jti = JSON.parse(Buffer.from(revoked.split(".")[1], "base64url").toString()).jti;
    expect(JSON.parse(onDisk)).toMatchObject({ version: 1, entries: [{ id: jti }] });

    const b = await restart();
    expect(b.issuer).toBe(a.issuer);
    expect(b.oauth.signingKey.kid).toBe(a.oauth.signingKey.kid);
    // Same key: the unrevoked token still verifies, so the rejection below is the denylist.
    expect((await mcpInitialize(b.issuer, kept)).status).toBe(200);
    const res = await mcpInitialize(b.issuer, revoked);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(INVALID);
    expect(await introspect(b.issuer, revoked)).toEqual({ active: false });
    expect(await introspect(b.issuer, kept)).toMatchObject({ active: true });
  });

  it("persisted key: revoking a refresh token keeps its access token rejected after restart", async () => {
    process.env.KAIA_OAUTH_SIGNING_KEY_FILE = join(dir, "signing-key.pem");
    const a = await restart();
    const t = a.oauth.issueAccessToken({ scopes: [SCOPES.READ] });
    expect(await revokeOverHttp(a.issuer, t.refresh_token)).toBe(200);
    const fresh = a.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    const b = await restart();
    expect((await mcpInitialize(b.issuer, fresh)).status).toBe(200);
    expect((await mcpInitialize(b.issuer, t.access_token)).body).toEqual(INVALID);
  });

  it("KAIA_OAUTH_REVOCATION_FILE overrides the denylist location", async () => {
    const custom = join(dir, "state", "denylist.json");
    process.env.KAIA_OAUTH_SIGNING_KEY_FILE = join(dir, "signing-key.pem");
    process.env.KAIA_OAUTH_REVOCATION_FILE = custom;
    const a = await restart();
    const token = a.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    await revokeOverHttp(a.issuer, token);
    expect(statSync(custom).isFile()).toBe(true);
    const fresh = a.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    const b = await restart();
    expect((await mcpInitialize(b.issuer, fresh)).status).toBe(200);
    expect((await mcpInitialize(b.issuer, token)).body).toEqual(INVALID);
  });

  it("answers 503 server_error when a revocation cannot be persisted, and still rejects the token", async () => {
    const sub = join(dir, "sub");
    process.env.KAIA_OAUTH_REVOCATION_FILE = join(sub, "denylist.json");
    const a = await restart();
    const token = a.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    writeFileSync(sub, "not a directory");
    const res = await send(`${a.issuer}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "server_error",
      error_description: "revocation could not be persisted",
    });
    expect((await mcpInitialize(a.issuer, token)).body).toEqual(INVALID);
  });

  it.each([
    ["not JSON", "{not json"],
    ["empty file", ""],
    ["wrong version", JSON.stringify({ version: 2, entries: [] })],
    ["bad entry", JSON.stringify({ version: 1, entries: [{ id: 7, expMs: "x" }] })],
  ])("refuses to start on a corrupt denylist (%s)", async (_name, content) => {
    process.env.KAIA_OAUTH_SIGNING_KEY_FILE = join(dir, "signing-key.pem");
    writeFileSync(join(dir, "revoked-jti.json"), content);
    resetConfigCache();
    await expect(runKaiaMcpServerHttp(port)).rejects.toThrow(/revocation store/i);
    // Nothing is left listening: the port is still free.
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  it("refuses to start when the denylist path is unreadable", async () => {
    process.env.KAIA_OAUTH_SIGNING_KEY_FILE = join(dir, "signing-key.pem");
    mkdirSync(join(dir, "revoked-jti.json"));
    resetConfigCache();
    await expect(runKaiaMcpServerHttp(port)).rejects.toThrow(/revocation store/i);
    // Nothing is left listening: the port is still free.
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});
