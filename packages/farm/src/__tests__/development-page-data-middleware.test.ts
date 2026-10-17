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

async function createProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farm-page-data-middleware-"));
  temporaryRoots.add(root);

  await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
  for (const dependency of ["react", "react-dom"]) {
    await fs.symlink(
      await fs.realpath(path.join(packageRoot, "node_modules", dependency)),
      path.join(root, "node_modules", dependency),
      "junction",
    );
  }
  await fs.writeFile(path.join(root, "package.json"), '{"private":true,"type":"module"}');
  await fs.writeFile(
    path.join(root, "farm.config.ts"),
    `export default {
  middleware: [
    {
      matcher: "/private/:path*",
      handler() {
        return new Response(null, { status: 307, headers: { location: "/login" } });
      },
    },
    {
      matcher: "/account",
      async handler(ctx, next) {
        ctx.data.set("user", "ada");
        ctx.headers.set("x-account-guard", "yes");
        await next();
      },
    },
  ],
};`,
  );
  await writeModule(
    root,
    "src/app/layout.tsx",
    `import React from "react";
export default function Layout({ children }) {
  return <>{children}</>;
}`,
  );
  await writeModule(
    root,
    "src/app/private/page.tsx",
    `import React from "react";
export default function Page() {
  return <main>private-page-content</main>;
}`,
  );
  await writeModule(
    root,
    "src/app/account/page.tsx",
    `import React from "react";
export default function Page({ middleware }) {
  return <main>account:{middleware?.data?.get("user")}</main>;
}`,
  );
  return root;
}

describe("development page-data middleware", () => {
  it("runs the target route's middleware for client navigation like a document load", async () => {
    const root = await createProject();
    const server = await createServer({ root, images: { provider: "none" } });
    servers.add(server);
    await server.listen(await getAvailablePort());
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Missing dev server address");
    const origin = `http://localhost:${address.port}`;

    // The document request is guarded...
    const document = await fetch(`${origin}/private`, { redirect: "manual" });
    expect(document.status).toBe(307);
    expect(document.headers.get("location")).toBe("/login");

    // ...and so is the page data a client navigation to it fetches.
    const guarded = await fetch(`${origin}/__farm/page-data?path=/private`, {
      redirect: "manual",
    });
    expect(guarded.status).toBe(307);
    expect(guarded.headers.get("location")).toBe("/login");
    await expect(guarded.text()).resolves.not.toContain("private-page-content");

    // Pass-through middleware still contributes headers and data.
    const account = await fetch(`${origin}/__farm/page-data?path=/account`);
    expect(account.status).toBe(200);
    expect(account.headers.get("x-account-guard")).toBe("yes");
    const payload = (await account.json()) as {
      props?: { middleware?: { data?: Record<string, unknown> } };
      fragment?: { html?: string };
    };
    expect(payload.props?.middleware?.data).toEqual({ user: "ada" });
    expect(payload.fragment?.html).toContain("account:<!-- -->ada");
  }, 60_000);
});
