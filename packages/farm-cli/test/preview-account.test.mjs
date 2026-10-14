import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const { previewSignInStatus, signInToPreviewGateway, signOutOfPreviewGateway } = createRequire(
  import.meta.url,
)("../dist/index.js");
const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "../bin/farm.js");
const gatewayUrl = "https://preview.example.com";
const infra = {
  enabled: true,
  provider: "device",
  issuer: "https://infra.example.com/api/auth",
  clientId: "farm-preview",
  defaultSessionTtlMs: 3600_000,
  maxSessionTtlMs: 86400_000,
};
const github = { ...infra, provider: "github", issuer: undefined, clientId: "github-client" };
const key = "farmjs_secretsecretsecretsecretsecret00";
const savedKey = "farmjs_saved_key_0123456789abcdef0123";

/** The shape the gateway signs after a GitHub sign-in: prefix.payload.signature. */
function accountToken(claims) {
  return `fp1.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

function runtime({
  config,
  saved,
  keyResponse = () => Response.json({ key: savedKey }, { status: 201 }),
  answer = true,
  pick,
} = {}) {
  const store = new Map(saved ? [[gatewayUrl, saved]] : []);
  const keyRequests = [];
  const questions = [];
  const offered = [];
  return {
    offered,
    async chooseProject(projects) {
      offered.push(projects);
      return pick === undefined ? undefined : projects[pick];
    },
    store,
    keyRequests,
    questions,
    async confirm(question) {
      questions.push(question);
      return answer;
    },
    interactive: true,
    credentials: {
      async get(url) {
        return store.get(url);
      },
      async set(url, value) {
        store.set(url, value);
      },
      async delete(url) {
        store.delete(url);
      },
    },
    async openBrowser() {
      return true;
    },
    async wait() {},
    async promptDuration() {
      return undefined;
    },
    async fetch(url, init) {
      if (url === "https://infra.example.com/api/previews/key") {
        keyRequests.push({
          authorization: init.headers.authorization,
          body: JSON.parse(init.body),
        });
        return keyResponse();
      }
      if (url.endsWith("/api/auth/config"))
        return config ? Response.json(config) : new Response(null, { status: 404 });
      if (url.endsWith("/device/code"))
        return Response.json({
          device_code: "device",
          user_code: "ABCD1234",
          verification_uri: "https://infra.example.com/device",
          expires_in: 600,
          interval: 1,
        });
      if (url.endsWith("/device/token"))
        return Response.json({ access_token: "device-session", expires_in: 86400 });
      throw new Error(`Unexpected URL ${url}`);
    },
  };
}

test("whoami reports the credential farm preview would use, never a whole key", async () => {
  assert.equal((await previewSignInStatus(gatewayUrl, runtime(), {})).mode, "none");

  const expiresAt = Date.now() + 86400_000;
  const saved = accountToken({ kind: "account", provider: "github", login: "sam", expiresAt });
  const signedIn = await previewSignInStatus(gatewayUrl, runtime({ config: github, saved }), {
    FARMJS_API_KEY: key,
  });
  assert.deepEqual(signedIn.using, { source: "saved", login: "sam", expiresAt });
  assert.match(signedIn.ignoredKey, /GitHub sign-in, which doesn't accept API keys/);

  const env = { FARMJS_API_KEY: key, FARMJS_API_URL: "https://infra.example.com" };
  const keyed = await previewSignInStatus(gatewayUrl, runtime({ config: infra, saved }), env);
  assert.deepEqual(keyed.using, { source: "FARMJS_API_KEY", hint: "farmjs_secr…" });
  assert.equal(keyed.savedOverridden, true);
  assert.ok(!JSON.stringify(keyed).includes(key));

  const elsewhere = await previewSignInStatus(gatewayUrl, runtime({ config: infra }), {
    FARMJS_API_KEY: key,
  });
  assert.equal(elsewhere.using, undefined);
  assert.match(
    elsewhere.ignoredKey,
    /for https:\/\/app\.farmjs\.dev, but this gateway signs in through https:\/\/infra\.example\.com/,
  );

  // An Infrastructure sign-in is opaque, and the deprecated variable is only reported.
  const opaque = await previewSignInStatus(
    gatewayUrl,
    runtime({ config: infra, saved: "session" }),
    {},
  );
  assert.deepEqual(opaque.using, { source: "saved" });
  const legacy = await previewSignInStatus(gatewayUrl, runtime({ config: infra }), {
    FARM_PREVIEW_TOKEN: "legacy",
  });
  assert.deepEqual(legacy.using, { source: "FARM_PREVIEW_TOKEN" });
});

test("login saves an API key from Infrastructure, and logout only forgets it here", async () => {
  const r = runtime({ config: infra });
  assert.deepEqual(await signInToPreviewGateway(gatewayUrl, r), {
    login: "your Farm.js Infrastructure account",
  });
  // After signing in, the developer is asked before a key is made for this machine.
  assert.deepEqual(r.questions, ["Create an API key for this machine? (Y/n) "]);
  // The approved device sign-in is exchanged once for a key, and only the key is kept.
  assert.equal(r.keyRequests.length, 1);
  assert.equal(r.keyRequests[0].authorization, "Bearer device-session");
  assert.match(r.keyRequests[0].body.name, /^Farm CLI on /);
  assert.equal(r.store.get(gatewayUrl), savedKey);
  assert.deepEqual((await previewSignInStatus(gatewayUrl, r, {})).using, {
    source: "saved",
    hint: "farmjs_save…",
  });
  // Logging out asks Infrastructure for nothing: the key stays valid there.
  assert.equal(await signOutOfPreviewGateway(gatewayUrl, r), true);
  assert.equal(r.store.has(gatewayUrl), false);
  assert.equal(r.keyRequests.length, 1);
  assert.equal(await signOutOfPreviewGateway(gatewayUrl, r), false);
  await assert.rejects(signInToPreviewGateway(gatewayUrl, runtime()), /doesn't use sign-in/);
});

test("after signing in, a picked project is saved to the app's .env", async () => {
  const previous = process.env.FARMJS_PROJECT_ID;
  delete process.env.FARMJS_PROJECT_ID;
  const roots = [];
  const tempRoot = async () => {
    roots.push(await fs.mkdtemp(path.join(os.tmpdir(), "farm-login-project-")));
    return roots.at(-1);
  };
  const projects = [
    { id: "project_1", name: "Storefront", organization: "Acme" },
    { id: "project_2", name: "Docs", organization: "Acme" },
  ];
  // A malformed id is never offered: it would be written into .env.
  const keyResponse = () =>
    Response.json(
      { key: savedKey, projects: [...projects, { id: "bad\nX=1", name: "Injected" }] },
      { status: 201 },
    );
  try {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, ".env"), "OTHER=1");
    const picked = runtime({ config: infra, keyResponse, pick: 1 });
    await signInToPreviewGateway(gatewayUrl, picked, { root });
    assert.deepEqual(picked.offered, [projects]);
    assert.equal(
      await fs.readFile(path.join(root, ".env"), "utf8"),
      "OTHER=1\nFARMJS_PROJECT_ID=project_2\n",
    );
    // An app that already names its project isn't asked again.
    const again = runtime({ config: infra, keyResponse, pick: 0 });
    await signInToPreviewGateway(gatewayUrl, again, { root });
    assert.deepEqual(again.offered, []);

    // Skipping writes nothing.
    delete process.env.FARMJS_PROJECT_ID;
    const skipped = await tempRoot();
    const skip = runtime({ config: infra, keyResponse });
    await signInToPreviewGateway(gatewayUrl, skip, { root: skipped });
    assert.equal(skip.offered.length, 1);
    await assert.rejects(fs.readFile(path.join(skipped, ".env")), { code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.FARMJS_PROJECT_ID;
    else process.env.FARMJS_PROJECT_ID = previous;
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
  }
});

test("answering no creates and saves nothing", async () => {
  const r = runtime({ config: infra, answer: false });
  await assert.rejects(signInToPreviewGateway(gatewayUrl, r), (error) => {
    assert.equal(error.name, "PreviewApiKeyDeclinedError");
    assert.match(error.message, /No API key was created\. Run farm login when you want one/);
    return true;
  });
  assert.equal(r.questions.length, 1);
  assert.deepEqual(r.keyRequests, []);
  assert.equal(r.store.size, 0);
});

test("login saves nothing when Infrastructure can't make a key", async () => {
  const full = runtime({
    config: infra,
    keyResponse: () =>
      Response.json(
        { message: "Revoke one in Farm.js Infrastructure, then run farm login again." },
        { status: 409 },
      ),
  });
  await assert.rejects(
    signInToPreviewGateway(gatewayUrl, full),
    /Revoke one in Farm\.js Infrastructure/,
  );
  assert.equal(full.store.size, 0);
  const older = runtime({
    config: infra,
    keyResponse: () => new Response("Not found", { status: 404 }),
  });
  await assert.rejects(
    signInToPreviewGateway(gatewayUrl, older),
    /couldn't create an API key \(404\)/,
  );
  assert.equal(older.store.size, 0);
});

test("farm whoami and farm logout run end to end against a gateway", async () => {
  let config = github;
  const server = createServer((request, response) => {
    if (request.url !== "/api/auth/config") return response.writeHead(404).end();
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(config));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const gateway = `http://127.0.0.1:${server.address().port}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farm-preview-account-"));
  const credentials = path.join(root, "preview-auth.json");
  const env = {
    ...process.env,
    FARM_TELEMETRY_DISABLED: "1",
    FARM_PREVIEW_CREDENTIALS_PATH: credentials,
    FARMJS_API_KEY: "",
    FARM_PREVIEW_TOKEN: "",
  };
  const farm = (...args) =>
    promisify(execFile)(process.execPath, [bin, ...args, "--gateway", gateway, "--root", root], {
      env,
    });
  try {
    await assert.rejects(farm("whoami"), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /Not signed in\. Run farm login\./);
      return true;
    });
    const expiresAt = Date.now() + 86400_000;
    await fs.writeFile(
      credentials,
      JSON.stringify({
        [gateway]: accountToken({ kind: "account", provider: "github", login: "sam", expiresAt }),
      }),
    );
    const { stdout } = await farm("whoami");
    assert.match(stdout, /\(GitHub sign-in\)/);
    assert.match(stdout, /Signed in as sam, until /);
    assert.match((await farm("logout")).stdout, /Signed out of .* on this machine\./);
    assert.deepEqual(JSON.parse(await fs.readFile(credentials, "utf8")), {});

    // On an Infrastructure gateway, the hint names whichever variable is missing.
    config = infra;
    await assert.rejects(farm("whoami"), (error) => {
      assert.match(error.stdout, /Not signed in\. Run farm login, or set FARMJS_API_KEY\./);
      return true;
    });
    env.FARMJS_API_KEY = key;
    await assert.rejects(farm("whoami"), (error) => {
      assert.match(error.stdout, /Not signed in\. Run farm login\.\n/);
      assert.match(
        error.stdout,
        /signs in through https:\/\/infra\.example\.com\. If the key is from there, set FARMJS_API_URL=https:\/\/infra\.example\.com\./,
      );
      return true;
    });
  } finally {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
