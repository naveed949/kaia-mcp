/**
 * Runtime dependencies are exactly what the shipped code imports: SDK packages used only by
 * tests (client, core) belong in devDependencies, so `npm install --omit=dev` stays minimal.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const PACKAGE_SPEC = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[^\s]*)?$/;

/** Bare package names imported by non-test source files. */
function runtimeImports(): Set<string> {
  const names = new Set<string>();
  const root = new URL("./", import.meta.url).pathname;
  for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.startsWith("test-support/")) {
      continue;
    }
    const text = readFileSync(root + file, "utf8");
    for (const m of text.matchAll(/(?:\bfrom\s+|\bimport\(\s*)"([^"\n]+)"/g)) {
      const spec = m[1];
      if (spec.startsWith("node:") || !PACKAGE_SPEC.test(spec)) continue;
      const parts = spec.split("/");
      names.add(spec.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]);
    }
  }
  return names;
}

describe("package.json dependencies", () => {
  it("every @modelcontextprotocol runtime dependency is imported by shipped code", () => {
    const used = runtimeImports();
    const mcpDeps = Object.keys(pkg.dependencies).filter((d) =>
      d.startsWith("@modelcontextprotocol/")
    );
    expect(mcpDeps.filter((d) => !used.has(d))).toEqual([]);
  });

  it("every package imported by shipped code is a runtime dependency", () => {
    const missing = [...runtimeImports()].filter((d) => !(d in pkg.dependencies));
    expect(missing).toEqual([]);
  });

  it("test-only SDK packages are devDependencies", () => {
    for (const d of ["@modelcontextprotocol/client", "@modelcontextprotocol/core"]) {
      expect(pkg.devDependencies[d], d).toBeDefined();
    }
  });
});
