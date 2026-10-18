import type { RunnableDevEnvironment } from "vite";

/** @internal The environment registry is owned and closed by Vite. */
export interface FarmDevModuleServer {
  // Environment classes contain private fields. Keep this boundary structural
  // so a plugin's Vite peer can differ from core's installed Vite instance.
  environments: Record<string, unknown>;
}

const failedModules = new WeakMap<object, Map<string, Promise<unknown>>>();

/** @internal Distinguishes an unsupported runtime from a module evaluation error. */
export class FarmDevEnvironmentError extends Error {}

/** @internal Load in the selected environment without sharing SSR/RSC module state. */
export async function loadFarmDevModule<T = Record<string, any>>(
  server: FarmDevModuleServer,
  id: string,
  environmentName: "ssr" | "rsc" = "ssr",
): Promise<T> {
  const environment = server.environments[environmentName] as RunnableDevEnvironment | undefined;
  // Use the runner capability rather than instanceof: plugins can provide an
  // environment from a separate Vite installation. Do not create a second runner
  // or silently execute a remote runtime's modules inside Node.
  const runner = environment?.runner;
  if (!environment || !runner || typeof runner.import !== "function") {
    throw new FarmDevEnvironmentError(
      `[Farm.js] Cannot load ${JSON.stringify(id)}: the "${environmentName}" development environment must provide a module runner. Remote runtimes require a request/response adapter.`,
    );
  }
  try {
    return await runner.import<T>(id);
  } catch (error) {
    // The runner no longer writes the legacy graph's ssrError field. Remember
    // settled failures so creating a missing dependency can retry its importers.
    // Do not wait for unrelated imports that are still evaluating.
    const failures = failedModules.get(environment) ?? new Map<string, Promise<unknown>>();
    failedModules.set(environment, failures);
    await Promise.all(
      [...(runner.evaluatedModules?.idToModuleMap.values() ?? [])]
        .filter((module) => module.evaluated && module.promise)
        .map(async (module) => {
          try {
            await module.promise;
          } catch {
            failures.set(module.id, module.promise!);
          }
        }),
    );
    throw error;
  }
}

/** @internal Retry failed imports after a file appears, preserving healthy modules. */
export function invalidateFailedFarmDevModules(server: FarmDevModuleServer): void {
  for (const entry of Object.values(server.environments)) {
    const environment = entry as RunnableDevEnvironment;
    const failures = failedModules.get(environment);
    if (!failures?.size) continue;
    const runner = environment.runner;
    for (const [id, failed] of failures) {
      const evaluated = runner.evaluatedModules.getModuleById(id);
      // HMR may already have recovered it; do not invalidate fresh module state.
      if (evaluated?.promise !== failed) continue;
      const transformed = environment.moduleGraph.getModuleById(id);
      if (transformed) environment.moduleGraph.invalidateModule(transformed);
      if (evaluated) runner.evaluatedModules.invalidateModule(evaluated);
    }
    failures.clear();
  }
}
