// @vitest-environment node

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePackageJson } from "../nitro/universal-build";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createPackage(root: string, name: string, manifest: Record<string, unknown>) {
  const directory = path.join(root, "node_modules", ...name.split("/"));
  await mkdir(path.join(directory, "export"), { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name, ...manifest }));
  await writeFile(path.join(directory, "index.js"), "module.exports = {};\n");
  await writeFile(path.join(directory, "export", "package.cjs"), "module.exports = {};\n");
  return directory;
}

describe("staged package metadata", () => {
  it("finds the manifest of a package whose ./package export is a module", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "farm-package-json-")));
    roots.push(root);
    await writeFile(path.join(root, "package.json"), '{"name":"app"}');
    // The shape of @img/sharp-freebsd-wasm32 0.35: no package.json export, ./package → .cjs.
    const directory = await createPackage(root, "@img/sharp-wasm32", {
      main: "index.js",
      exports: { ".": "./index.js", "./package": "./export/package.cjs" },
    });

    const resolved = resolvePackageJson(
      createRequire(path.join(root, "package.json")),
      "@img/sharp-wasm32",
    );

    expect(resolved).toBe(path.join(directory, "package.json"));
  });

  it("still uses an exported package.json directly", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "farm-package-json-")));
    roots.push(root);
    await writeFile(path.join(root, "package.json"), '{"name":"app"}');
    const directory = await createPackage(root, "plain-package", { main: "index.js" });

    const resolved = resolvePackageJson(
      createRequire(path.join(root, "package.json")),
      "plain-package",
    );

    expect(resolved).toBe(path.join(directory, "package.json"));
  });
});
