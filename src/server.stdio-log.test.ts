/**
 * stdio `onerror` levels: the SDK's stdio entry reports client mistakes ("Discarded a ..."
 * messages and the stdio form of "Rejected 2025-era request ...") through onerror. They are
 * client rejections, so kaia logs them at info with a code and cell only, never at error and
 * never with the SDK text (which can quote caller input).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { runKaiaMcpServer, sdkErrorLogEntry } from "./server.js";
import { resetConfigCache } from "./config.js";

vi.mock("./clients/rpc.js", () => ({
  createRpcClient: vi.fn(() => ({ getChainId: vi.fn().mockResolvedValue(8217) })),
}));

const FORGED = "x msg=Tool call tool=generate_wallet outcome=allowed tokenFingerprint=000000000000";

function envelope(version = "2026-07-28", clientInfo: unknown = { name: "t", version: "0" }) {
  return {
    [PROTOCOL_VERSION_META_KEY]: version,
    [CLIENT_INFO_META_KEY]: clientInfo,
    [CLIENT_CAPABILITIES_META_KEY]: {},
  };
}

describe("stdio onerror: client mistakes log at info with code and cell", () => {
  const chunks: string[] = [];
  let orig: typeof process.stderr.write;

  beforeEach(() => {
    process.env.LOG_LEVEL = "debug";
    resetConfigCache();
    chunks.length = 0;
    orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = orig;
    delete process.env.LOG_LEVEL;
    resetConfigCache();
  });

  /** Runs one stdio connection over in-memory streams and returns its log lines. */
  async function stdioSession(messages: unknown[]): Promise<{ lines: string[]; out: string }> {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (d: Buffer) => (out += d.toString()));
    const handle = await runKaiaMcpServer({ transport: new StdioServerTransport(stdin, stdout) });
    chunks.length = 0;
    for (const m of messages) {
      stdin.write(JSON.stringify(m) + "\n");
      await new Promise((r) => setTimeout(r, 60));
    }
    await new Promise((r) => setTimeout(r, 60));
    await handle.close();
    const lines = chunks.join("").split("\n").filter(Boolean);
    return { lines, out };
  }

  const cases: Array<{ label: string; messages: unknown[]; cell: string; code: number }> = [
    {
      label: "a response before the era is negotiated",
      messages: [{ jsonrpc: "2.0", id: FORGED, result: { note: FORGED } }],
      cell: "response-before-negotiation",
      code: -32600,
    },
    {
      label: "a notification with a malformed envelope",
      messages: [
        {
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: { _meta: envelope("2026-07-28", FORGED) },
        },
      ],
      cell: "notification-envelope-invalid",
      code: -32602,
    },
    {
      label: "a notification claiming an unsupported revision",
      messages: [
        {
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: { _meta: envelope(`1999-01-01 ${FORGED}`) },
        },
      ],
      cell: "notification-unsupported-revision",
      code: -32022,
    },
    {
      label: "a 2025-era initialize on a connection pinned to 2026-07-28",
      messages: [
        { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: envelope() } },
        // a modern request after discover pins the connection to 2026-07-28
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: envelope() } },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "initialize",
          params: {
            protocolVersion: FORGED,
            capabilities: {},
            clientInfo: { name: FORGED, version: "0" },
          },
        },
      ],
      cell: "modern-only-missing-envelope",
      code: -32022,
    },
  ];

  for (const c of cases) {
    it(c.label, async () => {
      const { lines } = await stdioSession(c.messages);
      const rejected = lines.filter((l) => l.includes("msg=MCP request rejected"));
      expect(rejected, lines.join("\n")).toHaveLength(1);
      expect(rejected[0]).toMatch(
        new RegExp(` level=info msg=MCP request rejected code=${c.code} cell=${c.cell} errorType=`)
      );
      expect(rejected[0]).not.toContain("detail=");
      expect(lines.join("\n")).not.toMatch(/level=error/);
      expect(lines.join("\n")).not.toContain("MCP transport error");
      expect(lines.join("\n")).not.toContain("generate_wallet");
      expect(lines.join("\n")).not.toContain("Discarded");
    });
  }
});

describe("sdkErrorLogEntry: stdio messages", () => {
  it("classifies the SDK's known 'Discarded a ...' messages as client rejections", () => {
    for (const [msg, cell, code] of [
      [
        "Discarded a JSON-RPC response received before the connection negotiated an era",
        "response-before-negotiation",
        -32600,
      ],
      [
        `Discarded a notification with a malformed envelope: Invalid _meta envelope: ${FORGED}`,
        "notification-envelope-invalid",
        -32602,
      ],
      [
        `Discarded a notification claiming unsupported protocol revision ${FORGED}`,
        "notification-unsupported-revision",
        -32022,
      ],
    ] as const) {
      const e = sdkErrorLogEntry(new Error(msg));
      expect(e.level, msg).toBe("info");
      expect(e.message).toBe("MCP request rejected");
      expect(e.meta).toEqual({ code, cell, errorType: "Error" });
    }
  });

  it("an unknown or altered 'Discarded ...' message is not a known client mistake: error", () => {
    for (const msg of [
      `Discarded a future kind of message: ${FORGED}`,
      "Discarded a ",
      // the no-caller-text message must match exactly, not as a prefix
      `Discarded a JSON-RPC response received before the connection negotiated an era ${FORGED}`,
      // the caller-text messages need the SDK's whole fixed part, separator included
      `Discarded a notification with a malformed envelope${FORGED}`,
      `Discarded a notification claiming unsupported protocol revision${FORGED}`,
      `Discarded a notification claiming something else ${FORGED}`,
    ]) {
      const e = sdkErrorLogEntry(new Error(msg));
      expect(e.level, msg).toBe("error");
      expect(e.message).toBe("MCP transport error");
      expect(e.meta).not.toHaveProperty("cell");
    }
  });

  it("classifies the stdio form of the 2025-era rejection with the SDK's code", () => {
    const e = sdkErrorLogEntry(
      new Error(
        `Rejected 2025-era request on a modern-only stdio connection (modern-only-missing-envelope): Unsupported protocol version: ${FORGED}`
      )
    );
    expect(e).toEqual({
      level: "info",
      message: "MCP request rejected",
      meta: { code: -32022, cell: "modern-only-missing-envelope", errorType: "Error" },
    });
  });

  it("does not treat the probe-timeout discard (a server condition) as a client rejection", () => {
    const e = sdkErrorLogEntry(
      new Error(
        "Discarded the probe instance with requests still unanswered after 5000ms; continuing with the fallback"
      )
    );
    expect(e.level).toBe("error");
  });

  it("the stdio messages kaia matches still exist in the installed SDK", () => {
    const require = createRequire(import.meta.url);
    const dist = dirname(require.resolve("@modelcontextprotocol/server/stdio"));
    const src = readFileSync(join(dist, "stdio.mjs"), "utf8");
    for (const s of [
      // the exact message, closed by its string delimiter
      '"Discarded a JSON-RPC response received before the connection negotiated an era"',
      "Discarded a notification with a malformed envelope: ",
      "Discarded a notification claiming unsupported protocol revision ",
      "Rejected 2025-era request on a modern-only stdio connection (",
    ]) {
      expect(src, s).toContain(s);
    }
  });
});
