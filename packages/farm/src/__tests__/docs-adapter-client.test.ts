// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateFarmDocsAdapterClientRuntime,
  getFarmDocsAdapterConfigModule,
} from "../docs/adapter-client";

const ADAPTER = "@farming-labs/farmjs/react";

type Hydrate = () => Promise<boolean>;

/** Run the generated runtime with `import()` routed to a stub loader. */
function evaluate(runtime: string, load: (specifier: string) => Promise<unknown>): Hydrate {
  const source = runtime.replaceAll("await import(", "await __load(");
  return new Function("__load", `${source}\nreturn hydrateFarmDocsAdapterRuntime;`)(load);
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("Farm docs adapter client runtime", () => {
  it("never imports the adapter statically", () => {
    const runtime = generateFarmDocsAdapterClientRuntime(ADAPTER);

    expect(runtime).not.toMatch(/^\s*import\s/m);
    expect(runtime).toContain(`await import(${JSON.stringify(ADAPTER)})`);
    // The import happens only after the page is known to be a docs page.
    expect(runtime.indexOf("if (!runtime) return false;")).toBeLessThan(
      runtime.indexOf("await import("),
    );
  });

  it("leaves pages the docs server did not render alone", async () => {
    (globalThis as { window?: unknown }).window = {};
    const load = vi.fn();

    await expect(evaluate(generateFarmDocsAdapterClientRuntime(ADAPTER), load)()).resolves.toBe(
      false,
    );
    expect(load).not.toHaveBeenCalled();
  });

  it("loads the adapter and hydrates a docs page with its runtime data", async () => {
    const data = { page: "/docs/guide" };
    (globalThis as { window?: unknown }).window = {
      __FARM_DOCS_ADAPTER__: { config: { entry: "docs" }, data },
    };
    const hydrateFarmDocs = vi.fn();
    const load = vi.fn(async () => ({ hydrateFarmDocs }));

    await expect(evaluate(generateFarmDocsAdapterClientRuntime(ADAPTER), load)()).resolves.toBe(
      true,
    );
    expect(load).toHaveBeenCalledWith(ADAPTER);
    expect(hydrateFarmDocs).toHaveBeenCalledWith({ config: { entry: "docs" }, data });
  });

  it("passes the docs config module only when the server flagged the page", async () => {
    const CONFIG = "/app/docs.config.tsx";
    const configModule = { default: { icons: { book: "<svg/>" } } };
    const hydrateFarmDocs = vi.fn();
    const load = vi.fn(async (specifier: string) =>
      specifier === CONFIG ? configModule : { hydrateFarmDocs },
    );

    (globalThis as { window?: unknown }).window = {
      __FARM_DOCS_ADAPTER__: { config: { entry: "docs" }, data: {} },
    };
    await evaluate(generateFarmDocsAdapterClientRuntime(ADAPTER, CONFIG), load)();
    expect(load).not.toHaveBeenCalledWith(CONFIG);
    expect(hydrateFarmDocs).toHaveBeenLastCalledWith({ config: { entry: "docs" }, data: {} });

    (globalThis as { window?: unknown }).window = {
      __FARM_DOCS_ADAPTER__: { config: { entry: "docs" }, data: {}, configModule: true },
    };
    await evaluate(generateFarmDocsAdapterClientRuntime(ADAPTER, CONFIG), load)();
    expect(load).toHaveBeenCalledWith(CONFIG);
    expect(hydrateFarmDocs).toHaveBeenLastCalledWith({
      config: { entry: "docs" },
      data: {},
      configModule: configModule.default,
    });
  });

  it("names a config module only for a code config with an adapter", () => {
    const adapter = { react: ADAPTER };
    expect(
      getFarmDocsAdapterConfigModule({ enabled: true, adapter, configPath: "/app/docs.config.ts" }),
    ).toBe("/app/docs.config.ts");
    expect(
      getFarmDocsAdapterConfigModule({ enabled: true, adapter, configPath: "/app/docs.json" }),
    ).toBeUndefined();
    expect(
      getFarmDocsAdapterConfigModule({ enabled: true, configPath: "/app/docs.config.ts" }),
    ).toBeUndefined();
  });

  it("reports an adapter without hydrateFarmDocs()", async () => {
    (globalThis as { window?: unknown }).window = { __FARM_DOCS_ADAPTER__: { data: {} } };

    await expect(
      evaluate(generateFarmDocsAdapterClientRuntime(ADAPTER), async () => ({}))(),
    ).rejects.toThrow("does not export hydrateFarmDocs()");
  });

  it("is a no-op without an adapter", async () => {
    const runtime = generateFarmDocsAdapterClientRuntime(undefined);

    expect(runtime).not.toContain("import");
    await expect(evaluate(runtime, vi.fn())()).resolves.toBe(false);
  });
});
