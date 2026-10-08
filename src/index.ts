/**
 * Kaia MCP Server — production-ready MCP server for the Kaia blockchain.
 */

export { createKaiaMcpServer, runKaiaMcpServer, runKaiaMcpServerHttp } from "./server.js";
export type { CreateKaiaMcpServerOptions, KaiaHttpServerHandle } from "./server.js";
export { SCOPES, AUTH_ERRORS, createDemoOAuthProvider, generatePkcePair } from "./auth/index.js";
