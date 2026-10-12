import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type React from "react";
import { compileReactModule } from "../compiler";
import { normalizeReactCompilerOptions } from "../index";

const here = dirname(fileURLToPath(import.meta.url));
// One directory per worker, so cleanup never races another test file.
const tmpDirectory = join(here, "tmp", String(process.pid));
const runtimePath = join(here, "..", "compiler-runtime.tsx");
let sequence = 0;

/**
 * Loads one module both as written and as the compiler emits it, so a test can
 * render the same component through React and through the compiled runtime.
 */
export async function loadCompiledAndOriginal(source: string): Promise<{
  compiled: Record<string, React.ComponentType<Record<string, unknown>>>;
  original: Record<string, React.ComponentType<Record<string, unknown>>>;
  names: readonly string[];
  reasons: string[];
}> {
  const result = await compileReactModule(
    source,
    "/app/Harness.tsx",
    normalizeReactCompilerOptions(true),
  );
  // Vitest transforms the written TSX like any other test module.
  const load = async (code: string) => {
    await mkdir(tmpDirectory, { recursive: true });
    const file = join(tmpDirectory, `module-${sequence++}.tsx`);
    await writeFile(
      file,
      code.split('"@farm.js/react/compiler-runtime"').join(JSON.stringify(runtimePath)),
    );
    return import(/* @vite-ignore */ file);
  };
  return {
    compiled: await load(result.code),
    original: await load(source),
    names: result.compiled,
    reasons: result.diagnostics.map((diagnostic) => diagnostic.reason),
  };
}

export async function removeCompiledModules(): Promise<void> {
  await rm(tmpDirectory, { force: true, recursive: true });
}
