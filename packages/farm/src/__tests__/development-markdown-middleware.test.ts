// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { createServer } from "../server/create-server";
import { getAvailablePort } from "./dev-server-port";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryRoots = new Set<string>();
const servers = new Set<ViteDevServer>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
  vi.restoreAllMocks();
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

describe("development markdown-source middleware ordering", () => {
  it("closes the internal page fetch when a Markdown client disconnects", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "farm-development-md-abort-"));
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
    await writeModule(
      root,
      "src/app/layout.tsx",
      `import React from "react";
export default function Layout({ children }) { return <>{children}</>; }`,
    );
    await writeModule(
      root,
      "src/app/slow/page.tsx",
      `import React from "react";
export default function Page() { return <main>Slow page</main>; }`,
    );

    let probe: {
      started(): void;
      reading(): void;
      gate: Promise<void>;
      streaming: boolean;
      closed: boolean;
    };
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const response = await realFetch(input, init);
      if (input instanceof Request && input.headers.get("accept") === "text/html") {
        const current = probe;
        const read = response.text.bind(response);
        vi.spyOn(response, "text").mockImplementation(() => {
          const pending = read();
          current.reading();
          return pending;
        });
      }
      return response;
    });
    const server = await createServer({
      root,
      images: { provider: "none" },
      plugins: [
        {
          name: "markdown-cancellation-probe",
          async beforeRequest(req, res) {
            if (req.url !== "/slow" || req.headers.accept !== "text/html") return;
            const current = probe;
            res.once("close", () => {
              current.closed = true;
            });
            res.setHeader("Content-Type", "text/html");
            if (current.streaming) res.write("<h1>Slow page</h1>");
            current.started();
            await current.gate;
            res.end("<p>Complete</p>");
          },
        },
      ],
    });
    servers.add(server);
    await server.listen(await getAvailablePort());
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Missing dev server address");
    const origin = `http://localhost:${address.port}`;

    for (const method of ["GET", "HEAD"]) {
      for (const suffix of [".md", ""]) {
        for (const streaming of [false, true]) {
          let started!: () => void;
          let reading!: () => void;
          let finish!: () => void;
          const ready = new Promise<void>((resolve) => {
            started = resolve;
          });
          const gate = new Promise<void>((resolve) => {
            finish = resolve;
          });
          const readingBody = new Promise<void>((resolve) => {
            reading = resolve;
          });
          probe = { started, reading, gate, streaming, closed: false };
          const client = new AbortController();
          const request = fetch(`${origin}/slow${suffix}`, {
            method,
            headers: { accept: "text/markdown" },
            signal: client.signal,
          }).then(
            () => "completed",
            (error) => error.name,
          );
          try {
            await ready;
            // Do not mistake headers being written for a body read having started.
            if (streaming) await readingBody;
            client.abort();
            expect(await request).toBe("AbortError");
            await vi.waitFor(() => expect(probe.closed).toBe(true), { timeout: 5_000 });
          } finally {
            client.abort();
            finish();
            await request;
          }
        }
      }
    }
    // A disconnect must not poison the next successful mirror request.
    probe = { started() {}, reading() {}, gate: Promise.resolve(), streaming: true, closed: false };
    const healthy = await fetch(`${origin}/slow.md`);
    expect(healthy.status).toBe(200);
    expect(await healthy.text()).toContain("# Slow page");
    await vi.waitFor(() => expect(probe.closed).toBe(true));
  }, 30_000);

  it("preserves terminal page responses through the real Markdown fetch path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "farm-development-md-terminal-"));
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
    await writeModule(
      root,
      "farm.config.ts",
      `export default {
  middleware: [204, 205, 304, 429].map(status => ({
    matcher: "/terminal/" + status,
    handler() {
      return new Response(status === 429 ? "Slow down" : null, {
        status,
        headers: {
          "content-type": status === 429 ? "text/plain" : "text/html",
          "retry-after": "60",
          "x-terminal-status": String(status),
        },
      });
    },
  })),
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
      "src/app/terminal/[status]/page.tsx",
      `import React from "react";
export default function Page() { return <main>must not render</main>; }`,
    );

    const server = await createServer({ root, images: { provider: "none" } });
    servers.add(server);
    await server.listen(await getAvailablePort());
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Missing dev server address");
    for (const status of [204, 205, 304, 429]) {
      for (const method of ["GET", "HEAD"]) {
        for (const suffix of [".md", ""]) {
          const response = await fetch(
            `http://localhost:${address.port}/terminal/${status}${suffix}`,
            {
              method,
              headers: { accept: "text/markdown" },
            },
          );
          expect(response.status).toBe(status);
          expect(response.headers.get("x-terminal-status")).toBe(String(status));
          expect(response.headers.get("retry-after")).toBe("60");
          expect(await response.text()).toBe(status === 429 && method === "GET" ? "Slow down" : "");
        }
      }
    }
  }, 30_000);

  it("runs app middleware before serving raw markdown page sources", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "farm-development-md-middleware-"));
    temporaryRoots.add(root);

    await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
    await fs.symlink(
      await fs.realpath(path.join(packageRoot, "node_modules", "react")),
      path.join(root, "node_modules", "react"),
      "junction",
    );
    await fs.symlink(
      await fs.realpath(path.join(packageRoot, "node_modules", "react-dom")),
      path.join(root, "node_modules", "react-dom"),
      "junction",
    );
    await fs.writeFile(path.join(root, "package.json"), '{"private":true,"type":"module"}');
    await fs.writeFile(
      path.join(root, "farm.config.ts"),
      `export default {
  middleware: [
    {
      matcher: "/private/:path*",
      handler() {
        return new Response("sign-in required", {
          status: 401,
          headers: { "x-markdown-guard": "yes" },
        });
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
      "src/app/private/notes/page.md",
      `# Private notes\n\nprivate-notes-source\n`,
    );
    await writeModule(root, "src/app/open/page.md", `# Open notes\n\nopen-notes-source\n`);

    const server = await createServer({ root, images: { provider: "none" } });
    servers.add(server);
    await server.listen(await getAvailablePort());
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Missing dev server address");
    const origin = `http://localhost:${address.port}`;

    // A middleware guard on the route must also cover its raw .md source.
    const guardedResponse = await fetch(`${origin}/private/notes.md`);
    expect(guardedResponse.status).toBe(401);
    expect(guardedResponse.headers.get("x-markdown-guard")).toBe("yes");
    await expect(guardedResponse.text()).resolves.not.toContain("private-notes-source");

    // Routes outside every matcher keep serving their markdown source.
    const openResponse = await fetch(`${origin}/open.md`);
    expect(openResponse.status).toBe(200);
    expect(openResponse.headers.get("content-type")).toContain("text/markdown");
    await expect(openResponse.text()).resolves.toContain("open-notes-source");
  }, 30_000);
});
