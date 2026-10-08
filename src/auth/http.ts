import type { IncomingMessage, ServerResponse } from "node:http";
import { AUTH_ERRORS, WWW_AUTHENTICATE_REALM } from "./constants.js";
import type { DemoOAuthProvider } from "./provider.js";
import { bearerFromHeader } from "./provider.js";
import { TOOL_SCOPES } from "./scopes.js";
import { logger } from "../utils/logger.js";
import { MCP_ERROR_CODES } from "../utils/errors.js";
import { RevocationStoreError } from "./revocation-store.js";
import type { AuthContext, VerifyResult } from "./types.js";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export async function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) {
      throw Object.assign(new Error("payload too large"), { oauthError: "invalid_request" });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type ParsedForm = {
  /** Last value of each field. */
  fields: Record<string, string>;
  /** Every value of `key`, in order (RFC 8707 `resource` may repeat). */
  all: (key: string) => string[] | undefined;
};

function parseFormAll(body: string, contentType: string | undefined): ParsedForm {
  const multi = new Map<string, string[]>();
  const push = (k: string, v: string) => multi.set(k, [...(multi.get(k) ?? []), v]);
  if ((contentType ?? "").includes("application/json")) {
    try {
      const obj = JSON.parse(body) as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (v == null) continue;
        if (Array.isArray(v)) v.forEach((item) => push(k, String(item)));
        else push(k, String(v));
      }
    } catch {
      // empty form
    }
  } else {
    for (const [k, v] of new URLSearchParams(body).entries()) push(k, v);
  }
  const fields: Record<string, string> = {};
  for (const [k, v] of multi) fields[k] = v[v.length - 1];
  return { fields, all: (key) => multi.get(key) };
}

function parseForm(body: string, contentType: string | undefined): Record<string, string> {
  return parseFormAll(body, contentType).fields;
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>
): void {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function oauthErrorStatus(code: string): number {
  if (code === "invalid_client") return 401;
  return 400;
}

type PublicOAuthError = { status: number; error: string; description: string };

/**
 * What an OAuth endpoint may tell the client about `err`. Only errors the provider raised
 * deliberately (tagged `oauthError`) keep their message. A revocation that could not be
 * persisted is a retryable 503 (RFC 7009 2.2.1). Anything else is a generic 500: raw
 * exception text can carry file paths and other internals, so it goes to the log only.
 */
function publicOAuthError(err: unknown): PublicOAuthError {
  if (err instanceof RevocationStoreError) {
    logger.error("oauth revocation not persisted", {
      jti: err.entryId,
      errno: err.errno ?? "none",
      error: err,
    });
    return { status: 503, error: "server_error", description: "revocation could not be persisted" };
  }
  if (err && typeof err === "object" && "oauthError" in err) {
    const error = String((err as { oauthError?: string }).oauthError);
    const description = err instanceof Error ? err.message : error;
    return { status: oauthErrorStatus(error), error, description };
  }
  logger.error("oauth endpoint error", { error: err });
  return { status: 500, error: "server_error", description: "internal error" };
}

function sendOAuthError(res: ServerResponse, err: unknown): void {
  const e = publicOAuthError(err);
  json(res, e.status, { error: e.error, error_description: e.description });
}

function consentPage(opts: {
  title: string;
  action: string;
  hidden: Record<string, string>;
  scopes: string[];
  extra?: string;
}): string {
  const hidden = Object.entries(opts.hidden)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}" />`)
    .join("\n");
  const scopes = opts.scopes.map((s) => `<li><code>${escapeHtml(s)}</code></li>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(opts.title)}</title></head>
<body>
  <h1>${escapeHtml(opts.title)}</h1>
  <p>kaia-mcp demo IdP — review scopes, then approve or deny. This is a local mock; do not use in production.</p>
  ${opts.extra ?? ""}
  <p>Requested scopes:</p>
  <ul>${scopes}</ul>
  <form method="post" action="${escapeHtml(opts.action)}">
    ${hidden}
    <button type="submit" name="decision" value="approve">Approve</button>
    <button type="submit" name="decision" value="deny">Deny</button>
  </form>
  <p>Revoke tokens later via <code>POST /oauth/revoke</code>.</p>
</body></html>`;
}

export function applyCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Mcp-Session-Id, Accept"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
}

/** Scope named in 401 challenges: the least-privilege scope for basic use (MCP scope selection). */
export const CHALLENGE_SCOPE = "kaia:read";

/** RFC 6750 quoted-string: drop characters that cannot appear in one. */
function quoted(value: string): string {
  return `"${value.replace(/[\\"\r\n]/g, "")}"`;
}

function bearerChallenge(params: Record<string, string | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${quoted(v!)}`);
  return `Bearer ${parts.join(", ")}`;
}

/**
 * 401 for a missing, invalid, expired or revoked token. The challenge carries
 * resource_metadata (RFC 9728) and scope (MCP 2026-07-28); `error` is omitted when the
 * request had no credentials at all (RFC 6750 §3.1). The body is the JSON-RPC
 * -32040/-32041/-32043 error gateways already parse.
 */
export function writeAuthFailure(
  res: ServerResponse,
  result: Extract<VerifyResult, { ok: false }>,
  resourceMetadataUrl: string
): void {
  const noCredentials = result.error === "unauthorized";
  const www = bearerChallenge({
    realm: WWW_AUTHENTICATE_REALM,
    error: noCredentials ? undefined : "invalid_token",
    error_description: noCredentials ? undefined : result.message,
    resource_metadata: resourceMetadataUrl,
    scope: CHALLENGE_SCOPE,
  });
  json(
    res,
    401,
    {
      jsonrpc: "2.0",
      error: { code: result.code, message: result.message, data: { error: result.error } },
      id: null,
    },
    { "WWW-Authenticate": www }
  );
}

/**
 * 403 for a valid token that lacks the scope a tools/call needs (RFC 6750 §3.1, MCP
 * runtime insufficient-scope). The body keeps the JSON-RPC -32042 error and the request id.
 */
export function writeInsufficientScope(
  res: ServerResponse,
  opts: {
    id: string | number | null;
    scope: string;
    message: string;
    resourceMetadataUrl: string;
  }
): void {
  const www = bearerChallenge({
    realm: WWW_AUTHENTICATE_REALM,
    error: "insufficient_scope",
    scope: opts.scope,
    resource_metadata: opts.resourceMetadataUrl,
    error_description: opts.message,
  });
  json(
    res,
    403,
    {
      jsonrpc: "2.0",
      id: opts.id,
      error: {
        code: MCP_ERROR_CODES.InsufficientScope,
        message: opts.message,
        data: { error: "insufficient_scope" },
      },
    },
    { "WWW-Authenticate": www }
  );
}

export function authenticateRequest(
  req: IncomingMessage,
  provider: DemoOAuthProvider
): VerifyResult {
  const header = req.headers.authorization;
  if (Array.isArray(header)) {
    return { ok: false, status: 401, ...AUTH_ERRORS.UNAUTHORIZED };
  }
  const token = bearerFromHeader(header);
  return provider.verifyAccessToken(token);
}

export type AuxRequestContext = {
  provider: DemoOAuthProvider;
  authMode: "required" | "off";
  unsafeWallet: boolean;
};

/**
 * Handle health, discovery, and OAuth demo IdP routes.
 * Returns true when the request was fully handled (do not pass to MCP).
 */
export const TOOL_SCOPES_PATH = "/.well-known/kaia-mcp/tool-scopes";

/** Error codes passed through verbatim on an /oauth/authorize error redirect. */
const AUTHORIZE_REDIRECT_ERRORS = new Set(["server_error", "invalid_scope", "invalid_target"]);

export async function tryHandleAuxRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuxRequestContext
): Promise<boolean> {
  const host = req.headers.host ?? "127.0.0.1";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/health") {
    json(res, 200, {
      status: "ok",
      server: "kaia-mcp",
      authMode: ctx.authMode,
      issuer: ctx.provider.issuer,
      unsafeWallet: ctx.unsafeWallet,
    });
    return true;
  }

  if (
    req.method === "GET" &&
    (path === "/.well-known/openid-configuration" ||
      path === "/.well-known/oauth-authorization-server")
  ) {
    json(res, 200, ctx.provider.discovery());
    return true;
  }

  if (req.method === "GET" && path === "/.well-known/oauth-protected-resource") {
    json(res, 200, ctx.provider.protectedResourceMetadata());
    return true;
  }

  if (req.method === "GET" && path === "/oauth/jwks") {
    json(res, 200, ctx.provider.jwks(), { "Cache-Control": "public, max-age=300" });
    return true;
  }

  // Public tool -> scope map so gateways can detect drift against their own copy.
  if (req.method === "GET" && path === TOOL_SCOPES_PATH) {
    json(res, 200, {
      resource: "kaia-mcp",
      scopes: [...new Set(Object.values(TOOL_SCOPES))].sort(),
      tool_scopes: Object.fromEntries(
        Object.entries(TOOL_SCOPES).sort(([a], [b]) => a.localeCompare(b))
      ),
    });
    return true;
  }

  // RFC 7662. Only offered when KAIA_INTROSPECTION_CLIENT_SECRET is set; callers authenticate
  // with client_secret_basic. Answers never echo the token.
  if (req.method === "POST" && path === "/oauth/introspect") {
    if (!ctx.provider.introspectionEnabled) {
      json(res, 404, { error: "not_found", error_description: "introspection is not enabled" });
      return true;
    }
    if (!ctx.provider.authenticateIntrospectionClient(req.headers.authorization)) {
      json(
        res,
        401,
        {
          error: "invalid_client",
          error_description: "introspection requires client authentication",
        },
        { "WWW-Authenticate": 'Basic realm="kaia-mcp-introspection"', "Cache-Control": "no-store" }
      );
      return true;
    }
    try {
      const fields = parseForm(await readBody(req), req.headers["content-type"]);
      json(res, 200, ctx.provider.introspect(fields.token, fields.token_type_hint), {
        "Cache-Control": "no-store",
      });
    } catch (err) {
      sendOAuthError(res, err);
    }
    return true;
  }

  if (req.method === "GET" && path === "/oauth/authorize") {
    try {
      const { requestId, scopes } = ctx.provider.createAuthorizationRequest({
        clientId: url.searchParams.get("client_id") ?? "",
        redirectUri: url.searchParams.get("redirect_uri") ?? "",
        state: url.searchParams.get("state") ?? undefined,
        scope: url.searchParams.get("scope") ?? undefined,
        codeChallenge: url.searchParams.get("code_challenge") ?? "",
        codeChallengeMethod: url.searchParams.get("code_challenge_method") ?? "",
        resource: url.searchParams.has("resource")
          ? url.searchParams.getAll("resource")
          : undefined,
      });
      html(
        res,
        200,
        consentPage({
          title: "Authorize kaia-mcp",
          action: "/oauth/consent",
          hidden: { request_id: requestId },
          scopes,
        })
      );
    } catch (err) {
      const e = publicOAuthError(err);
      const msg = e.description;
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state");
      if (
        redirectUri &&
        ctx.provider.isAllowedRedirectUri(redirectUri) &&
        msg !== "invalid_request: redirect_uri is not registered"
      ) {
        const loc = new URL(redirectUri);
        loc.searchParams.set(
          "error",
          AUTHORIZE_REDIRECT_ERRORS.has(e.error) ? e.error : "invalid_request"
        );
        loc.searchParams.set("error_description", msg);
        if (state) loc.searchParams.set("state", state);
        res.writeHead(302, { Location: loc.toString() });
        res.end();
      } else {
        html(res, 400, `<!doctype html><html><body><p>${escapeHtml(msg)}</p></body></html>`);
      }
    }
    return true;
  }

  if (req.method === "POST" && path === "/oauth/consent") {
    try {
      const fields = parseForm(await readBody(req), req.headers["content-type"]);
      const decision = fields.decision === "deny" ? "deny" : "approve";
      const { redirectUri } = ctx.provider.consent(fields.request_id ?? "", decision);
      res.writeHead(302, { Location: redirectUri });
      res.end();
    } catch (err) {
      sendOAuthError(res, err);
    }
    return true;
  }

  if (req.method === "POST" && path === "/oauth/token") {
    try {
      const { fields, all } = parseFormAll(await readBody(req), req.headers["content-type"]);
      const resource = all("resource");
      const grant = fields.grant_type;
      if (grant === "authorization_code") {
        json(
          res,
          200,
          ctx.provider.exchangeAuthorizationCode({
            clientId: fields.client_id ?? "",
            code: fields.code ?? "",
            codeVerifier: fields.code_verifier ?? "",
            redirectUri: fields.redirect_uri ?? "",
            resource,
          })
        );
      } else if (grant === "refresh_token") {
        json(
          res,
          200,
          ctx.provider.exchangeRefreshToken({
            clientId: fields.client_id ?? "",
            refreshToken: fields.refresh_token ?? "",
            resource,
          })
        );
      } else if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
        json(
          res,
          200,
          ctx.provider.exchangeDeviceCode({
            clientId: fields.client_id ?? "",
            deviceCode: fields.device_code ?? "",
            resource,
          })
        );
      } else {
        json(res, 400, { error: "unsupported_grant_type" });
      }
    } catch (err) {
      sendOAuthError(res, err);
    }
    return true;
  }

  if (req.method === "POST" && path === "/oauth/device") {
    try {
      const { fields, all } = parseFormAll(await readBody(req), req.headers["content-type"]);
      json(
        res,
        200,
        ctx.provider.startDeviceAuthorization({
          clientId: fields.client_id ?? "",
          scope: fields.scope,
          resource: all("resource"),
        })
      );
    } catch (err) {
      sendOAuthError(res, err);
    }
    return true;
  }

  if (req.method === "GET" && path === "/oauth/device/verify") {
    const userCode = (url.searchParams.get("user_code") ?? "").toUpperCase();
    const peeked = userCode ? ctx.provider.peekDeviceByUserCode(userCode) : undefined;
    html(
      res,
      200,
      consentPage({
        title: "Device authorization",
        action: "/oauth/device/verify",
        hidden: {},
        scopes: peeked?.scopes ?? [],
        extra: `<p><label>User code <input name="user_code" value="${escapeHtml(userCode)}" required></label></p>${
          peeked ? "" : "<p>Enter the code shown on your device, then approve.</p>"
        }`,
      })
    );
    return true;
  }

  if (req.method === "POST" && path === "/oauth/device/verify") {
    try {
      const fields = parseForm(await readBody(req), req.headers["content-type"]);
      const decision = fields.decision === "deny" ? "deny" : "approve";
      ctx.provider.consentDevice(fields.user_code ?? "", decision);
      html(
        res,
        200,
        `<!doctype html><html><body><p>Device ${decision === "approve" ? "authorized" : "denied"}.</p></body></html>`
      );
    } catch (err) {
      sendOAuthError(res, err);
    }
    return true;
  }

  if (req.method === "POST" && path === "/oauth/revoke") {
    try {
      const fields = parseForm(await readBody(req), req.headers["content-type"]);
      // A RevocationStoreError means the token is denied in this process but not durably;
      // sendOAuthError answers 503 server_error so the client retries instead of trusting 200.
      ctx.provider.revoke(fields.token ?? "");
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end("{}");
    } catch (err) {
      sendOAuthError(res, err);
    }
    return true;
  }

  return false;
}

export type { AuthContext };
