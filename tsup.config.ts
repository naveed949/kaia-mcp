import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "bin/kaia-mcp": "src/bin/kaia-mcp.ts",
  },
  format: ["esm"],
  clean: true,
  target: "node20",
  sourcemap: false,
  outDir: "dist",
});
