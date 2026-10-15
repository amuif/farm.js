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

// Behavior the production build already had, which the development server lacked.
describe("development server matches production", () => {
  it("resolves @/ imports and renders suspending components on every request", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farm-development-parity-")),
    );
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
    await writeModule(root, "src/lib/greeting.ts", 'export const greeting = "hello from @/lib";');
    // A whole document, so requests after the first take the buffered path.
    await writeModule(
      root,
      "src/app/layout.tsx",
      `export default function Layout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}`,
    );
    // Suspends with no <Suspense> boundary, as data hooks do in the jobs example.
    await writeModule(
      root,
      "src/app/page.tsx",
      `import { lazy } from "react";
import { greeting } from "@/lib/greeting";
const Late = lazy(async () => ({ default: () => <p>late content</p> }));
export default function Page() {
  return <main><h1>{greeting}</h1><Late /></main>;
}`,
    );

    const server = await createServer({ root, images: { provider: "none" } });
    servers.add(server);
    await server.listen(await getAvailablePort());
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Missing dev server address");
    const origin = `http://localhost:${address.port}`;

    for (const attempt of ["first", "second", "third"]) {
      const response = await fetch(`${origin}/`, { headers: { accept: "text/html" } });
      const html = await response.text();
      expect({ attempt, status: response.status }).toEqual({ attempt, status: 200 });
      expect(html).toContain("hello from @/lib");
      expect(html).toContain("late content");
    }

    // Better Auth's browser client imports better-call; excluding it from pre-bundling
    // left a bare import the browser couldn't resolve.
    expect(server.config.optimizeDeps.exclude ?? []).not.toContain("better-call");
  }, 60_000);

  it("keeps an @ alias from the app's own Vite config", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farm-development-alias-")),
    );
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
    await writeModule(root, "shared/greeting.ts", 'export const greeting = "from the app alias";');
    await writeModule(
      root,
      "src/app/page.tsx",
      `import { greeting } from "@/greeting";
export default function Page() { return <main>{greeting}</main>; }`,
    );

    const server = await createServer({
      root,
      images: { provider: "none" },
      vite: { resolve: { alias: { "@": path.join(root, "shared") } } },
    });
    servers.add(server);
    await server.listen(await getAvailablePort());
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Missing dev server address");

    const response = await fetch(`http://localhost:${address.port}/`, {
      headers: { accept: "text/html" },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("from the app alias");
  }, 60_000);
});
