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

/** The shape the gateway signs after a GitHub sign-in: prefix.payload.signature. */
function accountToken(claims) {
  return `fp1.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

function runtime({ config, saved, signOut = () => Response.json({ signedOut: true }) } = {}) {
  const store = new Map(saved ? [[gatewayUrl, saved]] : []);
  const signOuts = [];
  return {
    store,
    signOuts,
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
      if (url === "https://infra.example.com/api/previews/sign-out") {
        signOuts.push(init.headers.authorization);
        return signOut();
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

test("login saves a sign-in without starting a preview, and logout ends it", async () => {
  const r = runtime({ config: infra });
  assert.deepEqual(await signInToPreviewGateway(gatewayUrl, r), {
    login: "your Farm.js Infrastructure account",
  });
  assert.equal(r.store.get(gatewayUrl), "device-session");
  assert.deepEqual(await signOutOfPreviewGateway(gatewayUrl, r), { removed: true, ended: true });
  assert.deepEqual(r.signOuts, ["Bearer device-session"]);
  assert.equal(r.store.has(gatewayUrl), false);
  assert.deepEqual(await signOutOfPreviewGateway(gatewayUrl, r), { removed: false, ended: false });
  assert.equal(r.signOuts.length, 1);
  await assert.rejects(signInToPreviewGateway(gatewayUrl, runtime()), /doesn't use sign-in/);
});

test("logout forgets a sign-in the server can't end", async () => {
  // A GitHub sign-in is signed by the gateway, so there is no session to end anywhere.
  const saved = accountToken({ kind: "account", provider: "github", login: "sam" });
  const githubRuntime = runtime({ config: github, saved });
  assert.deepEqual(await signOutOfPreviewGateway(gatewayUrl, githubRuntime), {
    removed: true,
    ended: false,
  });
  // Nor is one sent to Infrastructure after the gateway switches to it.
  const switched = runtime({ config: infra, saved });
  assert.deepEqual(await signOutOfPreviewGateway(gatewayUrl, switched), {
    removed: true,
    ended: false,
  });
  assert.deepEqual(switched.signOuts, []);

  for (const [signOut, error] of [
    [() => new Response(null, { status: 503 }), "Farm.js Infrastructure answered 503"],
    // An Infrastructure from before the sign-out endpoint.
    [() => new Response("Not found", { status: 404 }), "Farm.js Infrastructure answered 404"],
    // What Better Auth's own /sign-out says for a token it can't see.
    [() => Response.json({ success: true }), "Farm.js Infrastructure didn't confirm the sign-out"],
    [() => new Response("<!doctype html>"), "Farm.js Infrastructure didn't confirm the sign-out"],
  ]) {
    const failing = runtime({ config: infra, saved: "device-session", signOut });
    assert.deepEqual(await signOutOfPreviewGateway(gatewayUrl, failing), {
      removed: true,
      ended: false,
      error,
    });
    assert.equal(failing.store.has(gatewayUrl), false);
  }

  const offline = runtime({ saved: "device-session" });
  offline.fetch = async () => {
    throw new Error("fetch failed");
  };
  assert.deepEqual(await signOutOfPreviewGateway(gatewayUrl, offline), {
    removed: true,
    ended: false,
    error: "fetch failed",
  });
  assert.equal(offline.store.has(gatewayUrl), false);
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

test("whoami shows when a GitHub gateway also takes Infrastructure keys", async () => {
  const dual = {
    ...github,
    infrastructure: {
      issuer: "https://infra.example.com/api/auth",
      dashboardUrl: "https://infra.example.com/dashboard/previews",
    },
  };
  const status = (env) => previewSignInStatus(gatewayUrl, runtime({ config: dual }), env);
  const optedIn = await status({
    FARMJS_API_KEY: key,
    FARMJS_API_URL: "https://infra.example.com",
  });
  assert.equal(optedIn.mode, "github");
  assert.equal(optedIn.acceptsInfrastructureKeys, true);
  assert.deepEqual(optedIn.using, { source: "FARMJS_API_KEY", hint: "farmjs_secr…" });
  const plain = await status({});
  assert.equal(plain.acceptsInfrastructureKeys, true);
  assert.equal(plain.using, undefined);
  const elsewhere = await status({ FARMJS_API_KEY: key });
  assert.match(
    elsewhere.ignoredKey,
    /but this gateway signs in through https:\/\/infra\.example\.com/,
  );
  // A plain GitHub gateway still says it takes no keys.
  const githubOnly = await previewSignInStatus(gatewayUrl, runtime({ config: github }), {
    FARMJS_API_KEY: key,
  });
  assert.equal(githubOnly.acceptsInfrastructureKeys, undefined);
  assert.match(githubOnly.ignoredKey, /doesn't accept API keys/);
});
