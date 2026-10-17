// @vitest-environment node

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleNodeModule } from "../build/node-module-bundle";
import { minifyFarmServerChunk } from "../nitro/universal-build";

const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...temporaryRoots].map((root) => rm(root, { recursive: true, force: true })));
  temporaryRoots.clear();
});

async function createRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "farm-node-bundle-")));
  temporaryRoots.add(root);
  return root;
}

describe("bundleNodeModule", () => {
  it("bundles tsconfig path aliases and leaves packages external", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "src", "lib"), { recursive: true });
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }),
    );
    await writeFile(path.join(root, "src", "lib", "value.ts"), "export const value = 41;\n");
    await writeFile(
      path.join(root, "entry.tsx"),
      [
        'import { value } from "@/lib/value";',
        'import pc from "picocolors";',
        'import { readFileSync } from "node:fs";',
        "export default { value: value + 1, pc, readFileSync, element: <div /> };",
      ].join("\n"),
    );
    const outfile = path.join(root, "out.mjs");

    await bundleNodeModule({
      root,
      entry: path.join(root, "entry.tsx"),
      outfile,
      target: "node20",
      externalPackages: true,
    });

    const code = await readFile(outfile, "utf8");
    expect(code).toMatch(/\b4[12]\b/);
    expect(code).not.toContain("@/lib/value");
    expect(code).toMatch(/from ["']picocolors["']/);
    expect(code).toMatch(/from ["']node:fs["']/);
    expect(code).toMatch(/from ["']react\/jsx-runtime["']/);
    expect(code).toContain("sourceMappingURL=data:application/json");
  });

  it("reports load errors as plain text", async () => {
    const root = await createRoot();
    await writeFile(path.join(root, "broken.ts"), "export default { a: 1 ;\n");

    const error = await bundleNodeModule({
      root,
      entry: path.join(root, "broken.ts"),
      outfile: path.join(root, "out.mjs"),
      target: "node20",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("broken.ts");
    expect((error as Error).message).not.toContain("\u001b[");
  });
});

describe("minifyFarmServerChunk", () => {
  const source = [
    "/*! legal notice */",
    "export function namedHandler() { const longLocalName = 'café'; return longLocalName; }",
    "export const Component = class NamedComponent {};",
    "export const arrow = () => namedHandler.name;",
  ].join("\n");

  it("keeps function and class names, drops legal comments, and emits ASCII", async () => {
    const code = await minifyFarmServerChunk(source, "chunk.mjs", {
      keepNames: true,
      target: "node18",
    });
    expect(code).not.toContain("legal notice");
    expect(code).not.toContain("longLocalName");
    expect(code).toMatch(/caf\\(?:u00e9|xe9)/i);
    expect([...code].every((character) => character.charCodeAt(0) < 128)).toBe(true);

    const module = await import(`data:text/javascript,${encodeURIComponent(code)}`);
    expect(module.namedHandler.name).toBe("namedHandler");
    expect(module.namedHandler()).toBe("café");
    expect(module.Component.name).toBe("NamedComponent");
    expect(module.arrow()).toBe("namedHandler");
  });

  it("does not add name helpers when names are not kept", async () => {
    const code = await minifyFarmServerChunk(source, "chunk.mjs", {
      keepNames: false,
      target: "esnext",
    });
    expect(code).not.toContain("__name");
    const module = await import(`data:text/javascript,${encodeURIComponent(code)}`);
    expect(module.namedHandler()).toBe("café");
  });

  it("throws on syntax errors instead of emitting partial output", async () => {
    await expect(
      minifyFarmServerChunk("export const = ;", "broken.mjs", {
        keepNames: true,
        target: "esnext",
      }),
    ).rejects.toThrow("broken.mjs");
  });
});
