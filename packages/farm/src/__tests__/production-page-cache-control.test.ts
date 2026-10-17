import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type PageHeaderInputs = {
  pprCanCache: boolean;
  pprConfig: { enabled: boolean; revalidate?: number };
  hasRequestScopedRender: boolean;
  stream?: boolean;
  sharedCacheControl?: string | null;
};

/**
 * Runs the generated production page-response header code from universal-build.ts,
 * so the test exercises the exact code the Nitro server ships.
 */
function createPageResponseHeaders(): (inputs: PageHeaderInputs) => Record<string, string> {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src", "nitro", "universal-build.ts"),
    "utf-8",
  );
  // The generated code lives inside a template literal, so undo its escapes.
  const unescape = (code: string) => code.replace(/\\`/g, "`").replace(/\\\$\{/g, "${");

  const pprStart = source.indexOf("function getPPRHeaders(status, config)");
  const pprEnd = source.indexOf("function getRouteSharedCacheControl(", pprStart);
  const blockStart = source.indexOf(
    "const sharedCacheControl = getRouteSharedCacheControl(route, pprCanCache);",
  );
  const blockEnd = source.indexOf("const farmI18nSnapshot = getFarmI18nSnapshot();", blockStart);
  expect(pprStart).toBeGreaterThan(-1);
  expect(pprEnd).toBeGreaterThan(pprStart);
  expect(blockStart).toBeGreaterThan(-1);
  expect(blockEnd).toBeGreaterThan(blockStart);

  const run = new Function(
    "route",
    "pprCanCache",
    "pprConfig",
    "renderedPage",
    "hasRequestScopedRender",
    "farmFontPreloadHeader",
    "getRouteSharedCacheControl",
    `${unescape(source.slice(pprStart, pprEnd))}\n${unescape(
      source.slice(blockStart, blockEnd),
    )}\nreturn responseHeaders;`,
  );

  return (inputs) =>
    run(
      { module: {} },
      inputs.pprCanCache,
      inputs.pprConfig,
      { stream: inputs.stream ?? false },
      inputs.hasRequestScopedRender,
      null,
      () =>
        inputs.sharedCacheControl === undefined
          ? "public, s-maxage=60, stale-while-revalidate=300"
          : inputs.sharedCacheControl,
    );
}

describe("production page Cache-Control", () => {
  const headersFor = createPageResponseHeaders();
  const ppr = { enabled: true, revalidate: 60 };

  it("keeps error and request-scoped PPR renders private when the shell has a revalidate", () => {
    // pageStatus >= 400, route context, middleware data, and private request headers all
    // make the render request-scoped. A PPR miss used to overwrite no-store with s-maxage.
    const headers = headersFor({ pprCanCache: true, pprConfig: ppr, hasRequestScopedRender: true });
    expect(headers["Cache-Control"]).toBe("private, no-store");
    expect(headers["X-Farm-PPR"]).toBe("miss");
  });

  it("keeps routes without a shared policy private under PPR", () => {
    const headers = headersFor({
      pprCanCache: true,
      pprConfig: ppr,
      hasRequestScopedRender: false,
      sharedCacheControl: null,
    });
    expect(headers["Cache-Control"]).toBe("private, no-store");
  });

  it("still lets a shareable PPR miss advertise the shell revalidate", () => {
    const headers = headersFor({
      pprCanCache: true,
      pprConfig: ppr,
      hasRequestScopedRender: false,
    });
    expect(headers["Cache-Control"]).toBe("s-maxage=60, stale-while-revalidate");
  });

  it("uses the route policy when PPR is off and no-store when PPR bypasses", () => {
    expect(
      headersFor({
        pprCanCache: false,
        pprConfig: { enabled: false },
        hasRequestScopedRender: false,
      })["Cache-Control"],
    ).toBe("public, s-maxage=60, stale-while-revalidate=300");
    expect(
      headersFor({ pprCanCache: false, pprConfig: ppr, hasRequestScopedRender: false })[
        "Cache-Control"
      ],
    ).toBe("private, no-store");
  });
});
