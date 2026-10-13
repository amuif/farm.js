import assert from "node:assert/strict";
import test from "node:test";
import {
  createPreviewGatewayHandler,
  MemoryPreviewGatewayStore,
  verifyPreviewTunnelGrant,
} from "../dist/index.js";
const signingSecret = "fixture-signing-secret-at-least-32-bytes-long";
function fixture(resolve, rateLimitExchange) {
  const sessions = [];
  const store = new MemoryPreviewGatewayStore();
  const handler = createPreviewGatewayHandler({
    store,
    auth: {
      signingSecret,
      rateLimitExchange,
      dashboardUrl: "https://infra.example.com/dashboard/previews",
      deviceAuth: {
        issuer: "https://infra.example.com/api/auth",
        clientId: "farm-preview",
        authorizeAccount: resolve,
      },
    },
    observer: { session: (event) => sessions.push(event) },
  });
  const grant = (token, input = {}) =>
    handler(
      new Request("https://preview.example.com/api/tunnel/grants", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "docs", expiresInMs: 7200_000, ...input }),
      }),
    );
  return { handler, grant, store, sessions };
}
test("validates Infra credentials per grant and attributes sessions from verified claims", async () => {
  let valid = true;
  const expiresAt = Date.now() + 3600_000;
  const f = fixture(async (token) =>
    valid && token === "api-key"
      ? { subject: "owner-1", login: "Owner", expiresAt, keyId: "key_verified" }
      : null,
  );
  const config = await (
    await f.handler(new Request("https://preview.example.com/api/auth/config"))
  ).json();
  assert.equal(config.provider, "device");
  assert.equal(config.clientId, "farm-preview");
  assert.ok(!JSON.stringify(config).includes(signingSecret));
  const grant = await (await f.grant("api-key", { project: "my-app", keyId: "spoofed" })).json();
  assert.equal(grant.expiresAt, expiresAt);
  const claims = verifyPreviewTunnelGrant(grant.token, { signingSecret, name: "docs" });
  assert.equal(claims.provider, "device");
  assert.equal(claims.subject, "owner-1");
  assert.equal(claims.project, "my-app");
  assert.equal(claims.keyId, "key_verified");
  const session = await f.handler(
    new Request("https://preview.example.com/api/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "docs",
        ownerId: "attacker",
        project: "spoofed",
        keyId: "spoofed",
      }),
    }),
  );
  assert.equal(session.status, 200);
  assert.equal(f.sessions[0].ownerId, "device:owner-1");
  assert.equal(f.sessions[0].project, "my-app");
  assert.equal(f.sessions[0].keyId, "key_verified");
  for (const project of ["../app", "APP", "", "x".repeat(64), {}])
    assert.equal((await f.grant("api-key", { project })).status, 400);
  assert.ok(!JSON.stringify(f.sessions).includes(grant.token));
  valid = false;
  assert.equal((await f.grant("api-key")).status, 401);
});
test("identity service errors fail closed without leaking provider errors", async () => {
  const f = fixture(async () => {
    throw new Error("secret provider details");
  });
  const response = await f.grant("api-key");
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("secret provider details"));
});

test("device grants honor the shared limiter before verifying credentials", async () => {
  let verifications = 0;
  const f = fixture(
    async () => {
      verifications++;
      return { subject: "owner", login: "Owner" };
    },
    () => ({ allowed: false, retryAfterMs: 1500 }),
  );
  const response = await f.grant("api-key");
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "2");
  assert.equal(verifications, 0);
});
test("beside GitHub sign-in, takes Infra API keys as an opt-in and keeps GitHub the default", async () => {
  const verified = [];
  const handler = createPreviewGatewayHandler({
    store: new MemoryPreviewGatewayStore(),
    auth: {
      signingSecret,
      githubClientId: "github-client",
      dashboardUrl: "https://infra.example.com/dashboard/previews",
      deviceAuth: {
        issuer: "https://infra.example.com/api/auth",
        clientId: "farm-preview",
        async authorizeAccount(token) {
          verified.push(token);
          return token === "farmjs_valid"
            ? { subject: "owner-1", login: "Owner", keyId: "key_1" }
            : null;
        },
      },
      async fetch(url) {
        assert.equal(url, "https://api.github.com/user");
        return Response.json({ id: 42, login: "sam", name: "Sam" });
      },
    },
  });
  const post = (path, body, token) =>
    handler(
      new Request(`https://preview.example.com${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  const config = await (
    await handler(new Request("https://preview.example.com/api/auth/config"))
  ).json();
  // GitHub stays the sign-in; Infrastructure is nested, so older CLIs never see its dashboard.
  assert.equal(config.provider, "github");
  assert.equal(config.clientId, "github-client");
  assert.equal(config.dashboardUrl, undefined);
  assert.deepEqual(config.infrastructure, {
    issuer: "https://infra.example.com/api/auth",
    dashboardUrl: "https://infra.example.com/dashboard/previews",
  });

  const exchange = await post("/api/auth/exchange", { provider: "github", accessToken: "gho_x" });
  assert.equal(exchange.status, 200);
  const account = await exchange.json();
  const github = await (await post("/api/tunnel/grants", { name: "docs" }, account.token)).json();
  const githubClaims = verifyPreviewTunnelGrant(github.token, { signingSecret, name: "docs" });
  assert.equal(githubClaims.provider, "github");
  assert.equal(githubClaims.subject, "42");
  // A GitHub sign-in is the gateway's own token and never goes to Infrastructure.
  assert.deepEqual(verified, []);

  const keyed = await (await post("/api/tunnel/grants", { name: "docs" }, "farmjs_valid")).json();
  const keyedClaims = verifyPreviewTunnelGrant(keyed.token, { signingSecret, name: "docs" });
  assert.equal(keyedClaims.provider, "device");
  assert.equal(keyedClaims.subject, "owner-1");
  assert.equal(keyedClaims.keyId, "key_1");
  assert.equal((await post("/api/tunnel/grants", { name: "docs" }, "farmjs_revoked")).status, 401);
  assert.deepEqual(verified, ["farmjs_valid", "farmjs_revoked"]);
});
test("reports the verified owner with each proxied request", async () => {
  const requests = [];
  const handler = createPreviewGatewayHandler({
    store: new MemoryPreviewGatewayStore(),
    auth: {
      signingSecret,
      deviceAuth: {
        issuer: "https://infra.example.com/api/auth",
        clientId: "farm-preview",
        authorizeAccount: async () => ({ subject: "owner-1", login: "Owner" }),
      },
    },
    observer: { request: (event) => requests.push(event) },
  });
  const call = (url, init = {}) => handler(new Request(url, init));
  const json = { "content-type": "application/json" };
  const grant = await (
    await call("https://preview.example.com/api/tunnel/grants", {
      method: "POST",
      headers: { ...json, authorization: "Bearer farmjs_key" },
      body: JSON.stringify({ name: "docs" }),
    })
  ).json();
  const session = await (
    await call("https://preview.example.com/api/sessions", {
      method: "POST",
      headers: { ...json, authorization: `Bearer ${grant.token}` },
      body: JSON.stringify({ name: "docs" }),
    })
  ).json();
  const control = { authorization: `Bearer ${session.token}` };
  const visit = call(`${session.publicUrl}/page`);
  const poll = await (
    await call(`https://preview.example.com/api/sessions/${session.id}/requests?wait=1000`, {
      headers: control,
    })
  ).json();
  await call(
    `https://preview.example.com/api/sessions/${session.id}/responses/${poll.requests[0].id}`,
    {
      method: "POST",
      headers: { ...control, ...json },
      body: JSON.stringify({ status: 200, headers: {}, body: "ok" }),
    },
  );
  assert.equal((await visit).status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].ownerId, "device:owner-1");
  assert.equal(requests[0].path, "/page");
});
