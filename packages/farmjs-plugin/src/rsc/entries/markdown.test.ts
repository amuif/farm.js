import { describe, expect, it, vi } from "vitest";
import {
  FARM_MARKDOWN_CONTENT_TYPE,
  applyMarkdownNegotiationHeaders,
  createFarmMarkdownErrorBody,
  createMarkdownMirrorResponse,
  farmRequestWantsMarkdown,
  resolveMarkdownConfig,
} from "@farm.js/core/markdown";
import type { EntryContext } from "../types.js";
import {
  createProductionMiddlewareRunner,
  applyProductionMiddlewareHeaders,
  type MiddlewareContext,
} from "@farm.js/core/middleware";
import { generateRscEntry } from "./rsc.js";

const context: EntryContext = {
  srcDir: "src",
  outDir: "dist",
  basePath: "/",
  actionsEnabled: false,
  serverActions: { allowedOrigins: [], bodySizeLimit: 1024 * 1024 } as never,
  deploymentId: "markdown-test",
  debug: false,
  markdown: resolveMarkdownConfig(undefined),
};

/** Runs the generated outer handler with the real core Markdown helpers. */
function createHandler(markdownConfig = resolveMarkdownConfig(undefined)) {
  const entry = generateRscEntry({ ...context, markdown: markdownConfig });
  const start = entry.indexOf("async function handleFarmPageOrMarkdown(request, context)");
  const end = entry.indexOf("async function handler(request, context)", start);
  const rendered: Request[] = [];
  const handleFarmRequest = vi.fn(async (request: Request) => {
    rendered.push(request);
    const { pathname } = new URL(request.url);
    if (pathname !== "/pricing") return new Response("Not Found", { status: 404 });
    return new Response(
      "<html><head><title>Pricing</title></head><body><main><h1>Pricing</h1><p>Plans.</p></main></body></html>",
      { headers: { "content-type": "text/html" } },
    );
  });
  const run = new Function(
    "farmMarkdownConfig",
    "createMarkdownMirrorResponse",
    "applyMarkdownNegotiationHeaders",
    "matchRoute",
    "handleFarmRequest",
    "farmApiBasePath",
    `${entry.slice(start, end)}; return handleFarmPageOrMarkdown;`,
  )(
    markdownConfig,
    createMarkdownMirrorResponse,
    applyMarkdownNegotiationHeaders,
    (pathname: string) => (pathname === "/pricing" ? { pattern: "/pricing" } : null),
    handleFarmRequest,
    "/api",
  ) as (request: Request, context?: unknown) => Promise<Response>;
  return { run, rendered, handleFarmRequest };
}

describe("RSC Markdown mirrors", () => {
  it.each([204, 205, 304])(
    "retains bodyless HTML %s responses without conversion or retry",
    async (status) => {
      for (const pathname of ["/pricing.md", "/pricing"]) {
        for (const method of ["GET", "HEAD"]) {
          const { run, handleFarmRequest } = createHandler();
          const page = new Response(null, {
            status,
            headers: { "content-type": "text/html", etag: '"page"' },
          });
          handleFarmRequest.mockResolvedValue(page);
          const response = await run(
            new Request(`https://farm.test${pathname}?outline`, {
              method,
              headers: { accept: "text/markdown" },
            }),
          );
          expect(response).toBe(page);
          expect(response.body).toBeNull();
          expect(response.headers.get("etag")).toBe('"page"');
          expect(handleFarmRequest).toHaveBeenCalledOnce();
        }
      }
    },
  );

  it("forwards cancellation through the generated RSC mirror wrapper", async () => {
    const controller = new AbortController();
    const { run, rendered } = createHandler();
    const pending = run(new Request("https://farm.test/pricing.md", { signal: controller.signal }));
    controller.abort("request cancelled");
    await pending;
    expect(rendered[0].signal.aborted).toBe(true);
    expect(rendered[0].signal.reason).toBe("request cancelled");
  });

  it.each(["/pricing.md", "/pricing"])(
    "does not retry rate-limited middleware at %s",
    async (pathname) => {
      const limited = vi.fn(
        () =>
          new Response("Slow down", {
            status: 429,
            headers: { "retry-after": "60", "cache-control": "no-store" },
          }),
      );
      const runner = createProductionMiddlewareRunner({
        modules: [{ path: "/pricing", module: { default: limited } }],
      });
      const { run, handleFarmRequest } = createHandler();
      handleFarmRequest.mockImplementation(async (request: Request) => {
        const result = await runner(request);
        return result.response ?? new Response("Not Found", { status: 404 });
      });
      const response = await run(
        new Request(`https://farm.test${pathname}`, {
          headers: { accept: "text/markdown" },
        }),
      );
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(await response.text()).toBe("Slow down");
      expect(limited).toHaveBeenCalledOnce();
      expect(handleFarmRequest).toHaveBeenCalledOnce();
    },
  );

  it("preserves middleware cookies in the published core runtime", async () => {
    const runner = createProductionMiddlewareRunner({
      modules: [
        {
          path: "/pricing",
          module: {
            default(ctx: MiddlewareContext) {
              ctx.cookies.set("session", "renewed", { httpOnly: true });
              ctx.cookies.set("old", "", { maxAge: 0 });
            },
          },
        },
      ],
    });
    for (const pathname of ["/pricing", "/pricing.md"]) {
      const { run, handleFarmRequest } = createHandler(resolveMarkdownConfig({ cache: 300 }));
      handleFarmRequest.mockImplementation(async (request: Request) => {
        const result = await runner(request);
        return applyProductionMiddlewareHeaders(
          new Response("<h1>Pricing</h1>", { headers: { "content-type": "text/html" } }),
          result.headers,
        );
      });
      const response = await run(
        new Request(`https://farm.test${pathname}`, {
          headers: { accept: "text/markdown" },
        }),
      );
      expect(response.headers.getSetCookie()).toEqual([
        "session=renewed; Path=/; HttpOnly",
        "old=; Max-Age=0; Path=/",
      ]);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(handleFarmRequest).toHaveBeenCalledOnce();
    }
  });

  it("serves a page's mirror at .md, rendering the page through the normal request path", async () => {
    const { run, rendered } = createHandler();
    const response = await run(new Request("https://farm.test/pricing.md"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await response.text()).toContain("# Pricing");
    expect(
      rendered.map((request) => [new URL(request.url).pathname, request.headers.get("accept")]),
    ).toEqual([["/pricing", "text/html"]]);
  });

  it("negotiates Accept: text/markdown and supports the partial views", async () => {
    const { run } = createHandler();
    const negotiated = await run(
      new Request("https://farm.test/pricing", { headers: { accept: "text/markdown" } }),
    );
    expect(negotiated.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(negotiated.headers.get("vary")).toContain("Accept");
    const outline = await run(new Request("https://farm.test/pricing.md?outline"));
    expect(await outline.text()).toContain("# Outline of /pricing.md");
  });

  it("advertises the mirror on HTML pages and leaves other responses alone", async () => {
    const { run } = createHandler();
    const page = await run(new Request("https://farm.test/pricing"));
    expect(page.headers.get("content-type")).toBe("text/html");
    expect(page.headers.get("link")).toBe('</pricing.md>; rel="alternate"; type="text/markdown"');
    const missing = await run(new Request("https://farm.test/nope"));
    expect(missing.status).toBe(404);
    expect(missing.headers.get("link")).toBeNull();
  });

  it("does nothing when md is turned off", async () => {
    const { run, rendered } = createHandler(resolveMarkdownConfig(false));
    const response = await run(new Request("https://farm.test/pricing.md"));
    expect(response.status).toBe(404);
    expect(rendered.map((request) => new URL(request.url).pathname)).toEqual(["/pricing.md"]);
    const page = await run(new Request("https://farm.test/pricing"));
    expect(page.headers.get("link")).toBeNull();
  });

  it("answers a missing page in Markdown when the request wants Markdown", () => {
    const entry = generateRscEntry(context);
    expect(entry).toContain(
      "farmRequestWantsMarkdown(url.pathname, request.headers.get('accept'))",
    );
    expect(entry).toContain("createFarmMarkdownErrorBody(404, url.pathname)");
    expect(entry).toContain("'X-Farm-Markdown-Error': '404'");
    // The generated module imports the helpers it uses from core.
    for (const name of [
      "createMarkdownMirrorResponse",
      "applyMarkdownNegotiationHeaders",
      "farmRequestWantsMarkdown",
      "createFarmMarkdownErrorBody",
      "FARM_MARKDOWN_CONTENT_TYPE",
    ]) {
      expect(entry).toMatch(
        new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '@farm.js/core/markdown'`),
      );
    }
    void [FARM_MARKDOWN_CONTENT_TYPE, createFarmMarkdownErrorBody, farmRequestWantsMarkdown];
  });
});
