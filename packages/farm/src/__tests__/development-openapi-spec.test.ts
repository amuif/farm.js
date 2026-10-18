// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { createServer } from "../server/create-server";
import { getAvailablePort } from "./dev-server-port";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryRoots = new Set<string>();
const servers = new Set<ViteDevServer>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
  await Promise.all(
    [...temporaryRoots].map((root) =>
      fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    ),
  );
  temporaryRoots.clear();
});

async function writeModule(root: string, relativePath: string, source: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, source);
}

async function startApp(config = ""): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farm-development-openapi-"));
  temporaryRoots.add(root);

  await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
  for (const pkg of ["react", "react-dom"]) {
    await fs.symlink(
      await fs.realpath(path.join(packageRoot, "node_modules", pkg)),
      path.join(root, "node_modules", pkg),
      "junction",
    );
  }
  await fs.writeFile(path.join(root, "package.json"), '{"private":true,"type":"module"}');
  // Use a real farm.config.ts so the OpenAPI config (and its specRoute
  // default of /openapi.json) is resolved, matching how `farm dev` runs.
  await fs.writeFile(
    path.join(root, "farm.config.ts"),
    `export default {
  srcDir: "src",
  images: { provider: "none" },
  openapi: { enabled: true, title: "Dev API" },
  ${config}
};`,
  );
  await writeModule(
    root,
    "src/app/layout.tsx",
    `import React from "react";
export default function Layout({ children }) { return <>{children}</>; }`,
  );
  await writeModule(
    root,
    "src/app/api/health/route.ts",
    `export function GET() { return Response.json({ ok: true }); }`,
  );

  const server = await createServer({ root });
  servers.add(server);
  await server.listen(await getAvailablePort());
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Missing dev server address");
  return `http://localhost:${address.port}`;
}

describe("development OpenAPI spec route", () => {
  it("serves the raw OpenAPI spec as JSON at /openapi.json", async () => {
    const origin = await startApp();

    const response = await fetch(`${origin}/openapi.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const spec = await response.json();
    expect(spec.openapi ?? spec.swagger).toBeTruthy();
    expect(spec.paths["/health"].get.operationId).toBe("get_health");

    const post = await fetch(`${origin}/openapi.json`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  }, 30_000);

  it("serves the OpenAPI reference and spec beneath the configured basePath", async () => {
    const origin = await startApp(`basePath: "/app",`);

    const spec = await fetch(`${origin}/app/openapi.json`);
    expect(spec.status).toBe(200);
    expect(spec.headers.get("content-type")).toContain("application/json");
    expect((await spec.json()).paths["/health"].get.operationId).toBe("get_health");

    const reference = await fetch(`${origin}/app/docs/reference`);
    expect(reference.status).toBe(200);
    expect(await reference.text()).toContain("<title>Dev API</title>");
  }, 30_000);

  it("lists the OpenAPI surfaces at /.well-known/api-catalog", async () => {
    const origin = await startApp(`basePath: "/app", agent: { apiCatalog: true },`);

    const response = await fetch(`${origin}/app/.well-known/api-catalog`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/linkset+json");
    expect(response.headers.get("link")).toBe('</app/.well-known/api-catalog>; rel="api-catalog"');
    const { linkset } = await response.json();
    const api = linkset[1];
    expect(linkset[0].item).toEqual([{ href: api.anchor }]);
    // Every listed link resolves on this server.
    expect((await fetch(`${origin}${api.anchor}/health`)).status).toBe(200);
    expect((await fetch(`${origin}${api["service-desc"][0].href}`)).status).toBe(200);
    expect((await fetch(`${origin}${api["service-doc"][0].href}`)).status).toBe(200);
  }, 30_000);

  it("does not serve /.well-known/api-catalog unless agent.apiCatalog is on", async () => {
    const origin = await startApp();
    expect((await fetch(`${origin}/.well-known/api-catalog`)).status).toBe(404);
  }, 30_000);
});
