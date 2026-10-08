/**
 * close() must settle and release the port and revocation store even when the SDK
 * handler's own close() rejects, without leaving an unhandled rejection behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./clients/rpc.js", () => ({
  createRpcClient: vi.fn(() => ({ getChainId: vi.fn().mockResolvedValue(8217) })),
}));

vi.mock("@modelcontextprotocol/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/server")>();
  return {
    ...actual,
    createMcpHandler: ((...args: Parameters<typeof actual.createMcpHandler>) => {
      const handler = actual.createMcpHandler(...args);
      return {
        ...handler,
        close: async () => {
          await handler.close();
          throw new Error("handler close failed");
        },
      };
    }) as typeof actual.createMcpHandler,
  };
});

const { runKaiaMcpServerHttp } = await import("./server.js");
const { resetConfigCache } = await import("./config.js");

describe("KaiaHttpServerHandle.close", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeEach(() => {
    process.env.LOG_LEVEL = "error";
    process.env.KAIA_AUTH_MODE = "required";
    resetConfigCache();
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    delete process.env.KAIA_AUTH_MODE;
    delete process.env.LOG_LEVEL;
    resetConfigCache();
  });

  it("settles, frees the port and leaves no unhandled rejection when the handler close fails", async () => {
    const handle = await runKaiaMcpServerHttp(0);
    const { port } = handle;
    await expect(handle.close()).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 50));
    expect(unhandled).toEqual([]);
    // the port is released: a new listener can bind it
    const { createServer } = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(port, "127.0.0.1", () => s.close(() => resolve()));
    });
  });
});
