import test from "node:test";
import assert from "node:assert/strict";
import { createWeixinLogin } from "../server/weixin-login.mjs";

const turn = () => new Promise(resolve => setTimeout(resolve, 3));
async function until(predicate) { for (let n = 0; n < 100; n++) { if (await predicate()) return; await turn(); } assert.fail("QR state did not settle"); }
function fake(overrides = {}) {
  const saved = [], registered = [], requests = [];
  const responses = overrides.responses || [{ status: "wait" }];
  let index = 0;
  const dependencies = { pollMs: 1,
    api: {
      async apiPostFetch(input) { requests.push(input); return JSON.stringify({ qrcode: "private-poll-secret", qrcode_img_content: "https://liteapp.weixin.qq.com/q/scan-link" }); },
      async apiGetFetch(input) { requests.push(input); return JSON.stringify(responses[Math.min(index++, responses.length - 1)]); }
    }, accounts: {
      listIndexedWeixinAccountIds: () => ["existing-bot"], loadWeixinAccount: () => ({ token: "stored-bot-secret" }),
      saveWeixinAccount: (...args) => saved.push(args), registerWeixinAccountId: id => registered.push(id)
    }, normalizeAccountId: id => id.replaceAll("@", "-").replaceAll(".", "-"),
    ...overrides.dependencies
  };
  return { saved, registered, requests, dependencies };
}
const confirmed = { status: "confirmed", ilink_bot_id: "new@im.bot", bot_token: "new-private-token", ilink_user_id: "scanner@im.wechat", baseurl: "https://ilinkai.weixin.qq.com" };

test("QR start and background status expose only display payload; credentials stay in official server account storage", async t => {
  const fixture = fake({ responses: [{ status: "scaned" }, confirmed] }); let imported = 0;
  const manager = await createWeixinLogin({ config: {}, dependencies: fixture.dependencies, onBound: async () => { imported++; } });
  t.after(() => manager.close());
  const session = await manager.start();
  await until(() => manager.status(session).status === "connected");
  assert.equal(imported, 1);
  assert.deepEqual(fixture.registered, ["new-im-bot"]);
  assert.equal(fixture.saved[0][1].token, "new-private-token");
  const publicText = JSON.stringify([session, manager.status(session)]);
  assert.doesNotMatch(publicText, /private-poll-secret|stored-bot-secret|new-private-token|scanner@im.wechat|new-im-bot/);
  assert.match(fixture.requests[0].body, /stored-bot-secret/);
  assert.equal(manager.status(session).qrUrl, undefined);
});

test("numeric pairing code is submitted only to official QR polling endpoint and never appears in status", async t => {
  const fixture = fake({ responses: [{ status: "need_verifycode" }, { status: "scaned" }, confirmed] });
  const manager = await createWeixinLogin({ config: {}, dependencies: fixture.dependencies }); t.after(() => manager.close());
  const session = await manager.start(); await until(() => manager.status(session).status === "need_verifycode");
  assert.throws(() => manager.verify({ id: session.id, code: "<script>" }), /数字配对码/);
  manager.verify({ id: session.id, code: "123456" });
  await until(() => manager.status(session).status === "connected");
  assert.ok(fixture.requests.some(request => request.endpoint.includes("verify_code=123456")));
  assert.doesNotMatch(JSON.stringify(manager.status(session)), /123456/);
});

test("cancellation closes immediately and late confirmed responses never save an account", async () => {
  let release; const fixture = fake();
  fixture.dependencies.api.apiGetFetch = async () => new Promise(resolve => { release = resolve; });
  const manager = await createWeixinLogin({ config: {}, dependencies: fixture.dependencies });
  const session = await manager.start(); await until(() => release);
  assert.equal(manager.cancel(session).status, "cancelled");
  await manager.close();
  release(JSON.stringify(confirmed)); await turn();
  assert.equal(fixture.saved.length, 0);
});

test("duplicate start reuses one pending session; expiry prevents credential writes", async t => {
  let now = 1000; const fixture = fake({ dependencies: { now: () => now, ttlMs: 100 } });
  const manager = await createWeixinLogin({ config: {}, dependencies: fixture.dependencies }); t.after(() => manager.close());
  const first = await manager.start(); const second = await manager.start();
  assert.equal(first.id, second.id);
  assert.equal(fixture.requests.filter(request => request.body).length, 1);
  now += 101;
  assert.equal(manager.status(first).status, "expired");
  assert.equal(fixture.saved.length, 0);
});

test("redirects and confirmation base URLs cannot move requests or credentials to arbitrary hosts", async t => {
  const fixture = fake({ responses: [{ status: "scaned_but_redirect", redirect_host: "attacker.example" }] });
  const manager = await createWeixinLogin({ config: {}, dependencies: fixture.dependencies }); t.after(() => manager.close());
  const session = await manager.start(); await until(() => manager.status(session).status === "failed");
  assert.ok(fixture.requests.every(request => request.baseUrl === "https://ilinkai.weixin.qq.com"));
  assert.equal(fixture.saved.length, 0);
});

test("successful binding with failed import is saved once, reports manual sync, and never leaks callback details", async t => {
  const fixture = fake({ responses: [confirmed] });
  const manager = await createWeixinLogin({ config: {}, dependencies: fixture.dependencies, onBound: async () => { throw new Error("token=private-internal-detail"); } });
  t.after(() => manager.close()); const session = await manager.start();
  await until(() => manager.status(session).syncPending);
  assert.equal(manager.status(session).status, "connected");
  assert.equal(fixture.saved.length, 1);
  assert.doesNotMatch(JSON.stringify(manager.status(session)), /private-internal-detail/);
});

test("account index write failure does not repeatedly persist credentials or import partial accounts", async t => {
  const fixture = fake({ responses: [confirmed] }); let imported = 0;
  fixture.dependencies.accounts.registerWeixinAccountId = () => { throw new Error("EACCES token=new-private-token"); };
  const manager = await createWeixinLogin({ config: {}, dependencies: fixture.dependencies, onBound: async () => { imported++; } });
  t.after(() => manager.close()); const session = await manager.start();
  await until(() => manager.status(session).status === "failed");
  assert.equal(fixture.saved.length, 1); assert.equal(imported, 0);
  assert.doesNotMatch(JSON.stringify(manager.status(session)), /new-private-token|EACCES/);
});
