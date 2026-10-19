// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { createServer, startDevServer } from "../server/create-server";
import { getAvailablePort } from "./dev-server-port";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
type FailurePhase =
  | "register"
  | "init"
  | "config"
  | "vite-config"
  | "vite-configure"
  | "vite-file-configure"
  | "vite-post"
  | "vite-late-post"
  | "vite-buildStart"
  | "setup"
  | "devServerCreated"
  | "configResolved"
  | "buildStart";
type ResourceState = {
  phase?: FailurePhase;
  originalError: unknown;
  events: string[];
  reported?: unknown;
  server?: ViteDevServer;
  reporterFailure?: "sync" | "async";
  cleanupFailures?: boolean;
  failInstrumentationShutdown?: boolean;
  disposeGate?: Promise<void>;
  onDispose?: () => void;
  instrumentationGate?: Promise<void>;
  onInstrumentationCleanup?: () => void;
  onViteClose?: () => void;
  viteCloseGate?: Promise<void>;
  onViteServer?: (server: ViteDevServer) => void;
};
const projects: Array<{ root: string; state: ResourceState }> = [];

afterEach(async () => {
  for (const { root, state } of projects.splice(0)) {
    // The failing control still needs its captured handle closed by the test.
    await state.server?.close().catch(() => {});
    Reflect.deleteProperty(globalThis, Symbol.for(root));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  vi.restoreAllMocks();
});

async function createProject(phase?: FailurePhase) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "farm-create-failure-")));
  const state: ResourceState = {
    phase,
    originalError: new Error("original startup failure"),
    events: [],
  };
  projects.push({ root, state });
  Reflect.set(globalThis, Symbol.for(root), state);
  await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
  for (const name of ["react", "react-dom"]) {
    await fs.symlink(
      await fs.realpath(path.join(packageRoot, "node_modules", name)),
      path.join(root, "node_modules", name),
      "junction",
    );
  }
  await fs.writeFile(path.join(root, "package.json"), '{"private":true,"type":"module"}');
  await fs.mkdir(path.join(root, "src", "app"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "app", "layout.tsx"),
    "export default function Layout({ children }) { return <>{children}</>; }",
  );
  await fs.writeFile(
    path.join(root, "src", "instrumentation.ts"),
    `const state = globalThis[Symbol.for(${JSON.stringify(root)})];
export function register() {
  state.events.push("register");
  if (state.phase === "register") throw state.originalError;
  return async () => {
    state.onInstrumentationCleanup?.();
    await state.instrumentationGate;
    state.events.push("instrumentation-cleanup");
    if (state.cleanupFailures) throw new Error("instrumentation cleanup failed");
  };
}
export function shutdown() {
  state.events.push("instrumentation-shutdown");
  if (state.failInstrumentationShutdown) throw new Error("instrumentation shutdown failed");
}`,
  );
  await fs.writeFile(
    path.join(root, "farm.config.ts"),
    `const state = globalThis[Symbol.for(${JSON.stringify(root)})];
function fail(phase) { if (state.phase === phase) throw state.originalError; }
export default {
  images: { provider: "none" },
  plugins: [{
    name: "startup-resources",
    init(context) {
      context.lifecycle.onShutdown(() => {
        state.events.push("init-dispose");
        if (state.cleanupFailures) throw new Error("init disposal failed");
      });
      fail("init");
    },
    config(config) { fail("config"); return config; },
    setup(context) {
      state.server = context.viteServer;
      context.lifecycle.onShutdown(async () => {
        state.onDispose?.();
        await state.disposeGate;
        state.events.push("setup-dispose");
        if (state.cleanupFailures) throw new Error("plugin disposal failed");
      });
      fail("setup");
    },
    devServerCreated() { fail("devServerCreated"); },
    configResolved() { fail("configResolved"); },
    buildStart() { fail("buildStart"); },
    onError(event) {
      state.events.push("onError");
      state.reported = event.error;
      if (state.reporterFailure === "sync") throw new Error("error reporter failed");
      if (state.reporterFailure === "async") return Promise.reject(new Error("error reporter failed"));
    },
  }],
  vite: { server: { middlewareMode: state.phase === "vite-buildStart" }, plugins: [{
    name: "startup-vite-close",
    enforce: "pre",
    config() { fail("vite-config"); },
    buildStart() { fail("vite-buildStart"); },
    configureServer: {
      order: "pre",
      handler(server) {
        state.server = server;
        state.onViteServer?.(server);
        const close = server.close.bind(server);
        server.close = async () => {
          state.onViteClose?.();
          await state.viteCloseGate;
          await close();
          state.events.push("vite-close");
          if (state.cleanupFailures) throw new Error("Vite close failed");
        };
        fail("vite-configure");
        return () => fail("vite-post");
      },
    },
  }, {
    name: "startup-late-post",
    enforce: "post",
    configureServer: { order: "post", handler() { return () => fail("vite-late-post"); } },
  }] },
};`,
  );
  if (phase === "vite-file-configure") {
    await fs.writeFile(
      path.join(root, "vite.config.ts"),
      `const state = globalThis[Symbol.for(${JSON.stringify(root)})];
export default { plugins: [{
  name: "file-config-first",
  enforce: "pre",
  configureServer: { order: "pre", handler(server) {
    state.server = server;
    state.onViteServer?.(server);
    const close = server.close.bind(server);
    server.close = async () => { await close(); state.events.push("vite-close"); };
    throw state.originalError;
  } },
}] };`,
    );
  }
  return { root, state };
}

const closedEvents = [
  "register",
  "onError",
  "vite-close",
  "setup-dispose",
  "init-dispose",
  "instrumentation-cleanup",
  "instrumentation-shutdown",
];

describe("development server creation failure cleanup", () => {
  it.each([
    "vite-configure",
    "vite-file-configure",
    "vite-post",
    "vite-late-post",
    "vite-buildStart",
  ] as const)(
    "closes the unreturned Vite server when %s fails during construction",
    async (phase) => {
      const { root, state } = await createProject(phase);
      const signals = process.listenerCount("SIGTERM");
      const closers: Array<ReturnType<typeof vi.fn>> = [];
      state.onViteServer = (server) => {
        closers.push(vi.spyOn(server.ws, "close"));
        for (const environment of Object.values(server.environments)) {
          closers.push(vi.spyOn(environment, "close"));
        }
      };
      await expect(createServer({ root })).rejects.toBe(state.originalError);
      expect(state.reported).toBe(state.originalError);
      expect(state.server).toBeDefined();
      expect(state.server!.watcher.closed).toBe(true);
      expect(state.server!.httpServer?.listening ?? false).toBe(false);
      expect(process.listenerCount("SIGTERM")).toBe(signals);
      for (const close of closers) expect(close).toHaveBeenCalledTimes(1);
      expect(state.events).toEqual(closedEvents.filter((event) => event !== "setup-dispose"));
    },
    60_000,
  );

  it("starts and serves a fresh instance after a failed construction", async () => {
    const { root, state } = await createProject("vite-configure");
    await fs.writeFile(
      path.join(root, "src", "app", "page.tsx"),
      "export default function Page() { return <main>retry works</main>; }",
    );
    await expect(createServer({ root })).rejects.toBe(state.originalError);
    const failed = state.server!;
    expect(failed.watcher.closed).toBe(true);
    state.phase = undefined;
    state.events.length = 0;
    const server = await startDevServer({ root }, await getAvailablePort());
    expect(server.watcher).not.toBe(failed.watcher);
    const address = server.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const response = await fetch(`http://localhost:${address.port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("retry works");
    expect(state.events).toEqual(["register"]);
    await server.close();
    expect(state.events).toEqual(closedEvents.filter((event) => event !== "onError"));
  }, 60_000);

  it("awaits an unreturned Vite server's close before disposing Farm resources", async () => {
    const { root, state } = await createProject("vite-configure");
    const closing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    state.onViteClose = closing.resolve;
    state.viteCloseGate = release.promise;
    let settled = false;
    const result = createServer({ root }).then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    try {
      await Promise.race([closing.promise, result]);
      expect(settled).toBe(false);
      expect(state.events).not.toContain("init-dispose");
      release.resolve();
      expect(await result).toBe(state.originalError);
      expect(state.server!.watcher.closed).toBe(true);
      expect(state.events).toEqual(closedEvents.filter((event) => event !== "setup-dispose"));
    } finally {
      release.resolve();
      await result;
    }
  }, 60_000);

  it.each(["vite-configure", "vite-late-post"] as const)(
    "preserves a %s failure when reporting and each cleanup stage also fail",
    async (phase) => {
      const { root, state } = await createProject(phase);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      state.cleanupFailures = true;
      state.reporterFailure = "async";
      await expect(createServer({ root })).rejects.toBe(state.originalError);
      expect(state.server!.watcher.closed).toBe(true);
      expect(state.events).toEqual(closedEvents.filter((event) => event !== "setup-dispose"));
      expect(log).toHaveBeenCalledWith(expect.stringContaining("close"), expect.any(Error));
    },
    60_000,
  );

  it.each(["init", "config", "vite-config"] as const)(
    "disposes Farm resources when %s fails before Vite returns a server",
    async (phase) => {
      const { root, state } = await createProject(phase);
      await expect(createServer({ root })).rejects.toBe(state.originalError);
      expect(state.reported).toBe(state.originalError);
      expect(state.server).toBeUndefined();
      expect(state.events).toEqual([
        "register",
        "onError",
        "init-dispose",
        "instrumentation-cleanup",
        "instrumentation-shutdown",
      ]);
    },
    60_000,
  );

  it.each(["setup", "devServerCreated", "configResolved", "buildStart"] as const)(
    "closes Vite and disposes resources when %s fails",
    async (phase) => {
      const { root, state } = await createProject(phase);
      await expect(createServer({ root })).rejects.toBe(state.originalError);
      expect(state.reported).toBe(state.originalError);
      expect(state.server?.watcher.closed).toBe(true);
      expect(state.events).toEqual(closedEvents);
      await state.server!.close();
      expect(state.events).toEqual(closedEvents);
    },
    60_000,
  );

  it.each([
    ["init", "sync"],
    ["setup", "async"],
  ] as const)(
    "preserves a %s error and completes cleanup after a %s error reporter failure",
    async (phase, reporterFailure) => {
      const { root, state } = await createProject(phase);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      state.reporterFailure = reporterFailure;
      await expect(createServer({ root })).rejects.toBe(state.originalError);
      expect(state.events).toContain("init-dispose");
      expect(state.events.at(-1)).toBe("instrumentation-shutdown");
      if (state.server) expect(state.server.watcher.closed).toBe(true);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("error hooks"),
        expect.objectContaining({ message: "error reporter failed" }),
      );
    },
    60_000,
  );

  it("keeps the startup error when Vite, plugin, and instrumentation cleanup all fail", async () => {
    const { root, state } = await createProject("setup");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    state.cleanupFailures = true;
    await expect(createServer({ root })).rejects.toBe(state.originalError);
    expect(state.server?.watcher.closed).toBe(true);
    expect(state.events).toEqual(closedEvents);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("close the dev server"),
      expect.objectContaining({
        errors: expect.arrayContaining([
          expect.objectContaining({ message: "Vite close failed" }),
          expect.objectContaining({ message: "Farm runtime shutdown failed" }),
          expect.objectContaining({ message: "instrumentation cleanup failed" }),
        ]),
      }),
    );
  }, 60_000);

  it("continues flushing instrumentation when plugin cleanup fails before Vite creation", async () => {
    const { root, state } = await createProject("init");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    state.cleanupFailures = true;
    await expect(createServer({ root })).rejects.toBe(state.originalError);
    expect(state.events).toEqual([
      "register",
      "onError",
      "init-dispose",
      "instrumentation-cleanup",
      "instrumentation-shutdown",
    ]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("close the plugin runtime"),
      expect.objectContaining({
        errors: [expect.objectContaining({ message: "init disposal failed" })],
      }),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("shut down instrumentation"),
      expect.objectContaining({ message: "instrumentation cleanup failed" }),
    );
  });

  it.each([false, true])(
    "flushes instrumentation after registration fails, even if shutdown fails: %s",
    async (failShutdown) => {
      const { root, state } = await createProject("register");
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      state.failInstrumentationShutdown = failShutdown;
      await expect(createServer({ root })).rejects.toBe(state.originalError);
      expect(state.events).toEqual(["register", "instrumentation-shutdown"]);
      if (failShutdown) {
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining("shut down instrumentation"),
          expect.objectContaining({ message: "instrumentation shutdown failed" }),
        );
      }
    },
  );

  it("awaits plugin and instrumentation cleanup before rejecting startup", async () => {
    const { root, state } = await createProject("setup");
    const disposing = Promise.withResolvers<void>();
    const releaseDispose = Promise.withResolvers<void>();
    const flushing = Promise.withResolvers<void>();
    const releaseInstrumentation = Promise.withResolvers<void>();
    state.onDispose = disposing.resolve;
    state.disposeGate = releaseDispose.promise;
    state.onInstrumentationCleanup = flushing.resolve;
    state.instrumentationGate = releaseInstrumentation.promise;
    let settled = false;
    const result = createServer({ root }).then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    try {
      // A broken implementation can skip disposal; do not hang the control.
      await Promise.race([disposing.promise, flushing.promise, result]);
      expect(settled).toBe(false);
      expect(state.server?.watcher.closed).toBe(true);
      expect(state.events).not.toContain("instrumentation-cleanup");
      releaseDispose.resolve();
      await Promise.race([flushing.promise, result]);
      expect(settled).toBe(false);
      expect(state.events).toContain("init-dispose");
      releaseInstrumentation.resolve();
      expect(await result).toBe(state.originalError);
      expect(state.events).toEqual(closedEvents);
    } finally {
      releaseDispose.resolve();
      releaseInstrumentation.resolve();
      await result;
    }
  }, 60_000);

  it("preserves non-Error thrown values", async () => {
    const { root, state } = await createProject("setup");
    state.originalError = null;
    state.reporterFailure = "async";
    await expect(createServer({ root })).rejects.toBe(null);
    expect(state.events).toEqual(closedEvents);
  }, 60_000);

  it("keeps successful startup resources alive until the caller closes the server", async () => {
    const { root, state } = await createProject();
    const server = await createServer({ root });
    expect(state.events).toEqual(["register"]);
    expect(server.watcher.closed).toBe(false);
    await Promise.all([server.close(), server.close()]);
    expect(state.events).toEqual(closedEvents.filter((event) => event !== "onError"));
  }, 60_000);
});
