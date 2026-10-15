// Build @farm.js/react first, then run with optional --executable-path /path/to/chrome.
// Checks the same prop/local-state sequence with and without compilation in dev and production.
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import React from "react";
import { renderToString } from "react-dom/server";
import { build, createServer } from "vite";
import { createFarmRendererPlugin } from "../dist/vite.mjs";

const { values } = parseArgs({ options: { "executable-path": { type: "string" } } });
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(packageRoot, "../..");
const { chromium } = createRequire(`${repo}/package.json`)("@playwright/test");
const cacheDir = await mkdtemp(join(tmpdir(), "farm-root-text-browser-"));
const entry = `${packageRoot}/fixtures/runtime-size/direct.tsx`;
const fixture = `import React, {StrictMode, useState} from 'react';
import {flushSync} from 'react-dom';
import {createRoot, hydrateRoot} from 'react-dom/client';
export function RootTextOwnership({next}) {
  const [value,setValue] = useState('before');
  return <main><button onClick={() => setValue(next)}>Update</button>
    <p>{value}</p><p>prefix {value} suffix</p><input aria-label="Draft" defaultValue="draft" />
  </main>;
}
const container = document.querySelector('#app');
const tree = next => <StrictMode><RootTextOwnership next={next}/></StrictMode>;
let root;
flushSync(() => {
  root = location.search.includes('hydrate=true') ? hydrateRoot(container, tree('after')) : createRoot(container);
  if (!location.search.includes('hydrate=true')) root.render(tree('after'));
});
window.changeProps = next => flushSync(() => root.render(tree(next)));
window.updateLocal = async () => {
  flushSync(() => container.querySelector('button').click());
  await Promise.resolve();
};
window.unmount = () => flushSync(() => root.unmount());
window.ready = true;`;
const initialHtml = renderToString(
  React.createElement(
    "main",
    null,
    React.createElement("button", null, "Update"),
    React.createElement("p", null, "before"),
    React.createElement("p", null, "prefix ", "before", " suffix"),
    React.createElement("input", { "aria-label": "Draft", defaultValue: "draft" }),
  ),
);
function html(hydrate, production) {
  return `<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="app">${hydrate ? initialHtml : ""}</div>${production ? "" : '<script type="module" src="/@vite/client"></script>'}<script type="module" src="${production ? "/bundle.js" : "/fixtures/runtime-size/direct.tsx"}"></script></body></html>`;
}

const results = [];
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: values["executable-path"] });
  for (const production of [false, true]) {
    for (const reactivity of ["static", "hybrid"]) {
      for (const compiled of [false, true]) {
        const config = {
          configFile: false,
          root: packageRoot,
          cacheDir,
          logLevel: "error",
          css: { postcss: { plugins: [] } },
          resolve: {
            alias: {
              "@farm.js/react/compiler-runtime": `${packageRoot}/dist/compiler-runtime.mjs`,
            },
          },
          plugins: [
            {
              name: "root-text-fixture",
              enforce: "pre",
              load(id) {
                if (id === entry) return fixture;
              },
              configureServer(server) {
                server.middlewares.use((req, res, next) => {
                  const url = new URL(req.url, "http://localhost");
                  if (url.pathname !== "/") return next();
                  res.setHeader("content-type", "text/html");
                  res.end(html(url.searchParams.get("hydrate") === "true", false));
                });
              },
            },
            ...createFarmRendererPlugin({
              rendererOptions: {
                compiler: compiled ? { reactivity, onUnsupported: "error" } : false,
              },
            }),
            {
              name: "root-text-compilation-proof",
              enforce: "post",
              transform(code, id) {
                if (id === entry) {
                  assert.equal(code.includes("createCompiledComponentWithFeatures"), compiled);
                }
              },
            },
          ],
        };
        let server;
        let close;
        if (production) {
          const result = await build({
            ...config,
            build: { write: false, minify: "esbuild", rollupOptions: { input: entry } },
          });
          const chunks = [result]
            .flat()
            .flatMap((result) => result.output)
            .filter((output) => output.type === "chunk");
          assert.equal(chunks.length, 1);
          server = createHttpServer((req, res) => {
            const url = new URL(req.url, "http://localhost");
            res.setHeader(
              "content-type",
              url.pathname === "/bundle.js" ? "text/javascript" : "text/html",
            );
            res.end(
              url.pathname === "/bundle.js"
                ? chunks[0].code
                : html(url.searchParams.get("hydrate") === "true", true),
            );
          });
          await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
          });
          close = () =>
            new Promise((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            );
        } else {
          const vite = await createServer({
            ...config,
            server: { host: "127.0.0.1", port: 0 },
            optimizeDeps: {
              include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
            },
          });
          await vite.listen();
          server = vite.httpServer;
          close = () => vite.close();
          const result = await vite.transformRequest("/fixtures/runtime-size/direct.tsx");
          assert.equal(result.code.includes("createCompiledComponentWithFeatures"), compiled);
        }
        try {
          for (const hydrate of [false, true]) {
            const page = await browser.newPage();
            const errors = [];
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("console", (message) => {
              if (message.type() === "error") errors.push(message.text());
            });
            try {
              await page.goto(`http://127.0.0.1:${server.address().port}/?hydrate=${hydrate}`);
              await page.waitForFunction(() => window.ready === true);
              const checked = await page.evaluate(async () => {
                const input = document.querySelector("input");
                const paragraphs = [...document.querySelectorAll("p")];
                input.value = "edited draft";
                input.focus();
                input.setSelectionRange(2, 5);
                let checked = 0;
                for (const [next, expected] of [
                  ["after", "after"],
                  [null, ""],
                  [[], ""],
                  [["one"], "one"],
                  [false, ""],
                  [0, "0"],
                  ["", ""],
                  [["one", ["two", null, 3]], "onetwo3"],
                  ["before", "before"],
                ]) {
                  window.changeProps(next);
                  await window.updateLocal();
                  if (
                    paragraphs[0].textContent !== expected ||
                    paragraphs[1].textContent !== `prefix ${expected} suffix`
                  )
                    throw new Error(`Wrong text for ${JSON.stringify(next)}`);
                  if (
                    document.querySelector("input") !== input ||
                    document.activeElement !== input ||
                    input.value !== "edited draft" ||
                    input.selectionStart !== 2 ||
                    input.selectionEnd !== 5
                  )
                    throw new Error("Lost input identity, value, focus or selection");
                  if (
                    ![...document.querySelectorAll("p")].every(
                      (node, index) => node === paragraphs[index],
                    )
                  )
                    throw new Error("Lost paragraph identity");
                  checked++;
                }
                window.unmount();
                if (document.querySelector("#app").childNodes.length !== 0)
                  throw new Error("Failed to unmount");
                return checked;
              });
              assert.equal(checked, 9);
              assert.deepEqual(errors, []);
              results.push({ production, reactivity, compiled, hydrate, checked });
            } finally {
              await page.close();
            }
          }
        } finally {
          await close();
        }
      }
    }
  }
  console.log(
    JSON.stringify({ node: process.version, browser: browser.version(), results }, null, 2),
  );
} finally {
  await browser?.close();
  await rm(cacheDir, { recursive: true, force: true });
}
