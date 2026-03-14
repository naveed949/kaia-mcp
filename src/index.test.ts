import { describe, it, expect } from "vitest";
import { createKaiaMcpServer } from "./index.js";

describe("createKaiaMcpServer", () => {
  it("returns an MCP server instance", () => {
    const server = createKaiaMcpServer();
    expect(server).toBeDefined();
    expect(server).toHaveProperty("connect");
  });
});
