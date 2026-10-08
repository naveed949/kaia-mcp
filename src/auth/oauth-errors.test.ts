/**
 * OAuth error responses never leak internals (file paths, raw exception text), and a
 * revocation that cannot be persisted is a retryable 503 on every route that revokes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runKaiaMcpServerHttp, type KaiaHttpServerHandle } from "../server.js";
import { resetConfigCache } from "../config.js";
import { createDemoOAuthProvider } from "./provider.js";
import { FileRevocationStore, RevocationStoreError } from "./revocation-store.js";
import { AUTH_ERRORS, DEMO_CLIENT_ID, SCOPES } from "./constants.js";

const SECRET = "test-only-introspection-secret";
const INTERNAL = "/srv/kaia-internal/secret-path/state.json is on fire";
const NOT_PERSISTED = {
  error: "server_error",
  error_description: "revocation could not be persisted",
};

function form(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    redirect: "manual",
  };
}

describe("OAuth error hygiene", () => {
  let handle: KaiaHttpServerHandle | undefined;
  let dir: string;
  let sub: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kaia-oauth-err-"));
    sub = join(dir, "state");
    process.env.LOG_LEVEL = "error";
    process.env.KAIA_AUTH_MODE = "required";
    process.env.KAIA_INTROSPECTION_CLIENT_SECRET = SECRET;
    process.env.KAIA_OAUTH_REVOCATION_FILE = join(sub, "denylist.json");
    resetConfigCache();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (handle) await handle.close();
    handle = undefined;
    for (const k of [
      "LOG_LEVEL",
      "KAIA_AUTH_MODE",
      "KAIA_INTROSPECTION_CLIENT_SECRET",
      "KAIA_OAUTH_REVOCATION_FILE",
    ]) {
      delete process.env[k];
    }
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Make the denylist directory unwritable by replacing it with a regular file. */
  function breakStore(): void {
    rmSync(sub, { recursive: true, force: true });
    writeFileSync(sub, "not a directory");
  }

  function healStore(): void {
    rmSync(sub, { force: true });
    mkdirSync(sub, { mode: 0o700 });
  }

  it("refresh rotation whose revocation cannot be persisted answers 503 with no path, and the refresh token survives for a retry", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const t = handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] });
    breakStore();
    const refresh = form({
      grant_type: "refresh_token",
      client_id: DEMO_CLIENT_ID,
      refresh_token: t.refresh_token,
    });
    const res = await fetch(`${handle.issuer}/oauth/token`, refresh);
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toEqual(NOT_PERSISTED);
    expect(text).not.toContain(dir);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // Fail closed: the access token the rotation would have retired is denied in-process.
    expect(handle.oauth.verifyAccessToken(t.access_token)).toMatchObject({
      ok: false,
      error: "invalid_token",
    });

    // Storage recovers: the same refresh token rotates, because nothing was consumed.
    healStore();
    const retry = await fetch(`${handle.issuer}/oauth/token`, refresh);
    expect(retry.status).toBe(200);
    const rotated = (await retry.json()) as { access_token: string };
    expect(handle.oauth.verifyAccessToken(rotated.access_token).ok).toBe(true);
  });

  it("refresh-token revocation that cannot be persisted answers 503 and can be retried", async () => {
    handle = await runKaiaMcpServerHttp(0);
    const t = handle.oauth.issueAccessToken({ scopes: [SCOPES.READ] });
    breakStore();
    const logged: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      logged.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let res: Response;
    try {
      res = await fetch(`${handle.issuer}/oauth/revoke`, form({ token: t.refresh_token }));
    } finally {
      process.stderr.write = orig;
    }
    // The operator gets the jti and the errno; the client gets neither.
    const line = logged
      .join("")
      .split("\n")
      .find((l) => l.includes("revocation not persisted"));
    const accessJti = JSON.parse(
      Buffer.from(t.access_token.split(".")[1], "base64url").toString()
    ).jti;
    expect(line).toContain(`jti=${accessJti}`);
    expect(line).toMatch(/errno=E[A-Z]+/);
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toEqual(NOT_PERSISTED);
    expect(text).not.toContain(dir);
    healStore();
    const retry = await fetch(`${handle.issuer}/oauth/revoke`, form({ token: t.refresh_token }));
    expect(retry.status).toBe(200);
    // The retry made it durable: a fresh store loaded from the file denies the access jti.
    const jti = JSON.parse(Buffer.from(t.access_token.split(".")[1], "base64url").toString()).jti;
    expect(FileRevocationStore.open(join(sub, "denylist.json")).has(jti)).toBe(true);
  });

  it.each([
    [
      "token (authorization_code)",
      "exchangeAuthorizationCode",
      "/oauth/token",
      { grant_type: "authorization_code" },
    ],
    [
      "token (refresh_token)",
      "exchangeRefreshToken",
      "/oauth/token",
      { grant_type: "refresh_token" },
    ],
    [
      "token (device_code)",
      "exchangeDeviceCode",
      "/oauth/token",
      { grant_type: "urn:ietf:params:oauth:grant-type:device_code" },
    ],
    ["device", "startDeviceAuthorization", "/oauth/device", { client_id: DEMO_CLIENT_ID }],
    ["consent", "consent", "/oauth/consent", { request_id: "x" }],
    ["device verify", "consentDevice", "/oauth/device/verify", { user_code: "ABCD-EFGH" }],
    ["revoke", "revoke", "/oauth/revoke", { token: "x" }],
    ["introspect", "introspect", "/oauth/introspect", { token: "x" }],
  ] as const)(
    "%s: an unexpected internal error is a generic server_error, never the exception text",
    async (_name, method, path, fields) => {
      handle = await runKaiaMcpServerHttp(0);
      vi.spyOn(handle.oauth, method).mockImplementation(() => {
        throw new Error(INTERNAL);
      });
      const init = form(fields);
      init.headers = {
        ...(init.headers as Record<string, string>),
        Authorization: `Basic ${Buffer.from(`kaia-mcp-gateway:${SECRET}`).toString("base64")}`,
      };
      const res = await fetch(`${handle.issuer}${path}`, init);
      const text = await res.text();
      expect(text).not.toContain("secret-path");
      expect(res.status).toBe(500);
      expect(JSON.parse(text)).toEqual({
        error: "server_error",
        error_description: "internal error",
      });
    }
  );

  it("authorize: an unexpected internal error is not reflected into the redirect or the page", async () => {
    handle = await runKaiaMcpServerHttp(0);
    vi.spyOn(handle.oauth, "createAuthorizationRequest").mockImplementation(() => {
      throw new Error(INTERNAL);
    });
    const url = new URL(`${handle.issuer}/oauth/authorize`);
    url.searchParams.set("client_id", DEMO_CLIENT_ID);
    url.searchParams.set("redirect_uri", "http://127.0.0.1/callback");
    url.searchParams.set("state", "s");
    const res = await fetch(url, { redirect: "manual" });
    const location = res.headers.get("location") ?? "";
    expect(decodeURIComponent(location)).not.toContain("secret-path");
    expect(await res.text()).not.toContain("secret-path");
    expect(new URL(location).searchParams.get("error")).toBe("server_error");
  });

  it("provider: a failed rotation consumes nothing and denies the old access token in-process", () => {
    const path = join(sub, "denylist.json");
    const provider = createDemoOAuthProvider({
      issuer: "http://127.0.0.1:3999",
      revocationStore: FileRevocationStore.open(path),
    });
    const t = provider.issueAccessToken({ scopes: [SCOPES.READ] });
    breakStore();
    expect(() =>
      provider.exchangeRefreshToken({ clientId: DEMO_CLIENT_ID, refreshToken: t.refresh_token })
    ).toThrow(RevocationStoreError);
    expect(provider.introspect(t.refresh_token, "refresh_token")).toMatchObject({ active: true });
    expect(provider.verifyAccessToken(t.access_token)).toEqual({
      ok: false,
      status: 401,
      ...AUTH_ERRORS.INVALID_TOKEN,
    });
  });
});
