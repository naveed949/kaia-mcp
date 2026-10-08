/**
 * KAIA_PUBLIC_URL is the issuer and the canonical resource URI. RFC 8707: `resource` is
 * accepted at authorize, device and token, a mismatch is invalid_target, access tokens
 * carry aud = canonical URI, and the resource server rejects any other audience.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runKaiaMcpServerHttp, type KaiaHttpServerHandle } from "../server.js";
import { getConfig, resetConfigCache } from "../config.js";
import { createDemoOAuthProvider } from "./provider.js";
import { generatePkcePair } from "./pkce.js";
import { SCOPES } from "./constants.js";
import {
  REDIRECT_URI,
  approve,
  authorize,
  deviceApproved,
  form,
  jwtPayload,
  mcpPost,
} from "../test-support/mcp-http.js";

vi.mock("../clients/rpc.js", () => ({
  createRpcClient: vi.fn(() => ({ getChainId: vi.fn().mockResolvedValue(8217) })),
}));

const ENV = [
  "KAIA_PUBLIC_URL",
  "KAIA_OAUTH_LEGACY_AUDIENCE",
  "KAIA_OAUTH_AUDIENCE",
  "KAIA_OAUTH_REQUIRE_RESOURCE",
  "KAIA_OAUTH_SIGNING_KEY_FILE",
  "KAIA_OAUTH_REVOCATION_FILE",
  "KAIA_AUTH_MODE",
  "LOG_LEVEL",
];

const LIST = { jsonrpc: "2.0" as const, id: 1, method: "tools/list" };

describe("KAIA_PUBLIC_URL config", () => {
  afterEach(() => {
    for (const k of ENV) delete process.env[k];
    resetConfigCache();
  });

  it("normalizes to scheme://host[:port] with lowercase host and no trailing slash", () => {
    process.env.KAIA_PUBLIC_URL = "https://MCP.Example.COM:8443/";
    resetConfigCache();
    expect(getConfig().publicUrl).toBe("https://mcp.example.com:8443");
  });

  it("is unset by default (issuer falls back to http://127.0.0.1:<port>)", () => {
    resetConfigCache();
    expect(getConfig().publicUrl).toBeUndefined();
  });

  it.each([
    ["a path", "https://mcp.example.com/mcp"],
    ["a query", "https://mcp.example.com/?a=1"],
    ["a fragment", "https://mcp.example.com/#x"],
    ["userinfo", "https://u:p@mcp.example.com"],
    ["a non-http scheme", "ftp://mcp.example.com"],
    ["no scheme", "mcp.example.com"],
  ])("rejects %s", (_label, value) => {
    process.env.KAIA_PUBLIC_URL = value;
    resetConfigCache();
    expect(() => getConfig()).toThrow(/KAIA_PUBLIC_URL/);
  });
});

describe("RFC 8707 resource indicators over HTTP", () => {
  let handles: KaiaHttpServerHandle[] = [];
  const dirs: string[] = [];

  beforeEach(() => {
    process.env.LOG_LEVEL = "error";
    process.env.KAIA_AUTH_MODE = "required";
    resetConfigCache();
  });

  afterEach(async () => {
    for (const h of handles) await h.close();
    handles = [];
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    for (const k of ENV) delete process.env[k];
    resetConfigCache();
  });

  async function start(): Promise<KaiaHttpServerHandle> {
    const h = await runKaiaMcpServerHttp(0);
    handles.push(h);
    return h;
  }

  async function codeFor(
    h: KaiaHttpServerHandle,
    extra: [string, string][] = []
  ): Promise<{ code: string; verifier: string }> {
    const pkce = generatePkcePair();
    const page = await authorize(h.localUrl, { challenge: pkce.challenge, extra });
    expect(page.status).toBe(200);
    const loc = await approve(h.localUrl, await page.text());
    return { code: loc.searchParams.get("code")!, verifier: pkce.verifier };
  }

  function exchange(
    h: KaiaHttpServerHandle,
    c: { code: string; verifier: string },
    extra: Record<string, string | string[]> = {}
  ): Promise<Response> {
    return form(`${h.localUrl}/oauth/token`, {
      grant_type: "authorization_code",
      client_id: "kaia-mcp-demo",
      code: c.code,
      code_verifier: c.verifier,
      redirect_uri: REDIRECT_URI,
      ...extra,
    });
  }

  it("default canonical resource is http://127.0.0.1:<port>; tokens carry it as aud", async () => {
    const h = await start();
    expect(h.issuer).toBe(`http://127.0.0.1:${h.port}`);
    const res = await exchange(h, await codeFor(h, [["resource", h.issuer]]), {
      resource: h.issuer,
    });
    expect(res.status).toBe(200);
    const { access_token } = (await res.json()) as { access_token: string };
    expect(jwtPayload(access_token)).toMatchObject({ iss: h.issuer, aud: h.issuer });
    expect((await mcpPost(h.localUrl, LIST, { token: access_token })).res.status).toBe(200);
  });

  it("KAIA_PUBLIC_URL drives issuer, discovery, PRM resource and token aud", async () => {
    process.env.KAIA_PUBLIC_URL = "https://kaia.example.test";
    resetConfigCache();
    const h = await start();
    expect(h.issuer).toBe("https://kaia.example.test");
    const disc = (await (
      await fetch(`${h.localUrl}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(disc.issuer).toBe("https://kaia.example.test");
    expect(disc.token_endpoint).toBe("https://kaia.example.test/oauth/token");
    const prm = (await (
      await fetch(`${h.localUrl}/.well-known/oauth-protected-resource`)
    ).json()) as Record<string, unknown>;
    expect(prm.resource).toBe("https://kaia.example.test");
    expect(prm.authorization_servers).toEqual(["https://kaia.example.test"]);
    const t = h.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    expect(jwtPayload(t)).toMatchObject({
      iss: "https://kaia.example.test",
      aud: "https://kaia.example.test",
    });
    expect((await mcpPost(h.localUrl, LIST, { token: t })).res.status).toBe(200);
  });

  it("authorize accepts an uppercase-host resource and rejects a mismatch with invalid_target (+state)", async () => {
    const h = await start();
    const pkce = generatePkcePair();
    const upper = h.issuer.replace("http://", "HTTP://");
    expect(
      (await authorize(h.localUrl, { challenge: pkce.challenge, extra: [["resource", upper]] }))
        .status
    ).toBe(200);
    const bad = await authorize(h.localUrl, {
      challenge: pkce.challenge,
      state: "st-1",
      extra: [["resource", "https://other.example.test"]],
    });
    expect(bad.status).toBe(302);
    const loc = new URL(bad.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("invalid_target");
    expect(loc.searchParams.get("state")).toBe("st-1");
    expect(loc.searchParams.get("code")).toBeNull();
  });

  it("authorize rejects two resource values and a resource with a fragment", async () => {
    const h = await start();
    const pkce = generatePkcePair();
    for (const extra of [
      [
        ["resource", h.issuer],
        ["resource", h.issuer],
      ],
      [["resource", `${h.issuer}#frag`]],
    ] as [string, string][][]) {
      const res = await authorize(h.localUrl, { challenge: pkce.challenge, extra });
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe(
        "invalid_target"
      );
    }
  });

  it("token endpoint: mismatched resource is 400 invalid_target and does not mint", async () => {
    const h = await start();
    const res = await exchange(h, await codeFor(h), { resource: "https://other.example.test" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_target" });
  });

  it("token endpoint: two resource values are invalid_target", async () => {
    const h = await start();
    const res = await exchange(h, await codeFor(h), { resource: [h.issuer, h.issuer] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_target" });
  });

  it("device flow: start and token both validate resource; omitted resource defaults to canonical", async () => {
    const h = await start();
    const badStart = await form(`${h.localUrl}/oauth/device`, {
      client_id: "kaia-mcp-demo",
      scope: "kaia:read",
      resource: "https://other.example.test",
    });
    expect(badStart.status).toBe(400);
    expect(await badStart.json()).toMatchObject({ error: "invalid_target" });

    const dc = await deviceApproved(h.localUrl);
    const badTok = await form(`${h.localUrl}/oauth/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "kaia-mcp-demo",
      device_code: dc,
      resource: "https://other.example.test",
    });
    expect(badTok.status).toBe(400);
    expect(await badTok.json()).toMatchObject({ error: "invalid_target" });

    const ok = await form(`${h.localUrl}/oauth/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "kaia-mcp-demo",
      device_code: dc,
    });
    expect(ok.status).toBe(200);
    const { access_token } = (await ok.json()) as { access_token: string };
    expect(jwtPayload(access_token).aud).toBe(h.issuer);
  });

  it("refresh grant validates resource", async () => {
    const h = await start();
    const { refresh_token } = h.oauth.issueAccessToken({ scopes: [SCOPES.READ] });
    const bad = await form(`${h.localUrl}/oauth/token`, {
      grant_type: "refresh_token",
      client_id: "kaia-mcp-demo",
      refresh_token,
      resource: "https://other.example.test",
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_target" });
    const ok = await form(`${h.localUrl}/oauth/token`, {
      grant_type: "refresh_token",
      client_id: "kaia-mcp-demo",
      refresh_token,
      resource: h.issuer,
    });
    expect(ok.status).toBe(200);
  });

  it("KAIA_OAUTH_REQUIRE_RESOURCE=1 rejects a missing resource at authorize, device and token", async () => {
    process.env.KAIA_OAUTH_REQUIRE_RESOURCE = "1";
    resetConfigCache();
    const h = await start();
    const pkce = generatePkcePair();
    const a = await authorize(h.localUrl, { challenge: pkce.challenge });
    expect(a.status).toBe(302);
    expect(new URL(a.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
    const d = await form(`${h.localUrl}/oauth/device`, {
      client_id: "kaia-mcp-demo",
      scope: "kaia:read",
    });
    expect(d.status).toBe(400);
    expect(await d.json()).toMatchObject({ error: "invalid_target" });
    const c = await codeFor(h, [["resource", h.issuer]]);
    const t = await exchange(h, c);
    expect(t.status).toBe(400);
    expect(await t.json()).toMatchObject({ error: "invalid_target" });
    expect((await exchange(h, c, { resource: h.issuer })).status).toBe(200);
  });

  it("resource server rejects a real-key token whose aud is not this server (incl. legacy kaia-mcp)", async () => {
    const h = await start();
    for (const resource of ["kaia-mcp", "https://other.example.test"]) {
      const other = createDemoOAuthProvider({
        issuer: h.issuer,
        resource,
        signingKey: h.oauth.signingKey,
      });
      const t = other.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
      const { res, body } = await mcpPost(h.localUrl, LIST, { token: t });
      expect(res.status).toBe(401);
      expect(body).toMatchObject({ error: { code: -32043 } });
    }
  });

  it("KAIA_OAUTH_LEGACY_AUDIENCE adds a second aud; the canonical URI stays mandatory", async () => {
    process.env.KAIA_OAUTH_LEGACY_AUDIENCE = "kaia-mcp";
    resetConfigCache();
    const h = await start();
    const t = h.oauth.issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    expect(jwtPayload(t).aud).toEqual([h.issuer, "kaia-mcp"]);
    expect((await mcpPost(h.localUrl, LIST, { token: t })).res.status).toBe(200);
    const legacyOnly = createDemoOAuthProvider({
      issuer: h.issuer,
      resource: "kaia-mcp",
      signingKey: h.oauth.signingKey,
    }).issueAccessToken({ scopes: [SCOPES.READ] }).access_token;
    expect((await mcpPost(h.localUrl, LIST, { token: legacyOnly })).res.status).toBe(401);
  });

  it("KAIA_OAUTH_AUDIENCE is a deprecated alias for KAIA_OAUTH_LEGACY_AUDIENCE", () => {
    process.env.KAIA_OAUTH_AUDIENCE = "kaia-mcp";
    resetConfigCache();
    expect(getConfig().oauthLegacyAudience).toBe("kaia-mcp");
  });

  it("stateless across instances: a token minted on A is accepted by B (shared key + public URL)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaia-p1-"));
    dirs.push(dir);
    process.env.KAIA_OAUTH_SIGNING_KEY_FILE = join(dir, "signing-key.pem");
    process.env.KAIA_PUBLIC_URL = "https://kaia.example.test";
    resetConfigCache();
    const a = await start();
    const b = await start();
    expect(a.port).not.toBe(b.port);
    const dc = await deviceApproved(a.localUrl);
    const tok = await form(`${a.localUrl}/oauth/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "kaia-mcp-demo",
      device_code: dc,
      resource: "https://kaia.example.test",
    });
    const { access_token } = (await tok.json()) as { access_token: string };
    const onB = await mcpPost(b.localUrl, LIST, { token: access_token });
    expect(onB.res.status).toBe(200);
    expect(onB.res.headers.get("mcp-session-id")).toBeNull();
    expect((onB.body as { result: { tools: unknown[] } }).result.tools.length).toBe(24);
  });
});
