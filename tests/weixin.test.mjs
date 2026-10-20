import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { createWeixin, writeJson, safeWeixinError } from "../bridge/weixin.mjs";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mercari-weixin-test-"));
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = { stateDir: directory, accountId: "test-bot", target: "test@im.wechat" };
  const contextFile = path.join(directory, "openclaw-weixin/accounts/test-bot.context-tokens.json");
  await writeJson(path.join(directory, "openclaw-weixin/accounts/test-bot.json"), {
    userId: config.target, token: "private-test-login", baseUrl: "https://ilinkai.weixin.qq.com"
  });
  await writeJson(contextFile, { [config.target]: "private-context-old" });
  const calls = []; let response = {}; let inbound = [];
  const dependencies = { gatewayOnline: async () => false,
    sync: { getSyncBufFilePath: () => path.join(directory, "cursor"), loadGetUpdatesBuf: () => "", saveGetUpdatesBuf: () => {} },
    api: { getUpdates: async () => ({ msgs: inbound }), sendMessage: async input => { calls.push(input); return response; } } };
  return { config, contextFile, calls, dependencies, start: () => createWeixin(config, dependencies),
    response: value => { response = value; }, inbound: value => { inbound = value; } };
}

test("rejected contexts survive restart; a fresh inbound session restores sending and truthful health", async t => {
  const f = await fixture(t); const first = await f.start();
  assert.equal((await first.status()).contextReady, true);
  assert.equal((await first.status()).verified, false);
  f.response({ ret: -2, errmsg: "prepare failed" });
  await assert.rejects(first.send("a", "stable-id"), error => error.code === "WEIXIN_CONTEXT_REJECTED");
  const rejected = await first.status();
  assert.equal(rejected.contextReady, false); assert.equal(rejected.needsInteraction, true);
  const restarted = await f.start();
  assert.equal((await restarted.status()).needsInteraction, true);
  f.inbound([{ from_user_id: f.config.target, context_token: "private-context-new", message_id: "msg-2" }]);
  await restarted.pollOnce();
  const fresh = await restarted.status();
  assert.equal(fresh.needsInteraction, false); assert.equal(fresh.verified, false);
  assert.ok(fresh.sessionRevision > rejected.sessionRevision);
  f.response({}); // Official API may omit ret on success.
  await restarted.send("b", "new-id");
  const accepted = await restarted.status();
  assert.equal(accepted.verified, true);
  assert.equal(accepted.lastSendError, "");
  assert.equal(f.calls.at(-1).body.msg.context_token, "private-context-new");
  assert.equal(JSON.stringify(accepted).includes("private-"), false);
  assert.equal(Object.keys(accepted).some(key => /Hash|Token/.test(key)), false);
  const revision = accepted.sessionRevision;
  await restarted.pollOnce();
  assert.equal((await restarted.status()).sessionRevision, revision, "replayed inbound messages do not unlock another retry");
});

test("other senders cannot refresh the scanner's session; an external Gateway context update can", async t => {
  const f = await fixture(t); const transport = await f.start();
  f.response({ errcode: -2 });
  await assert.rejects(transport.send("a", "id-1"));
  f.inbound([{ from_user_id: "other@im.wechat", context_token: "other-context", message_id: "other" }]);
  await transport.pollOnce();
  assert.equal((await transport.status()).needsInteraction, true);
  await writeJson(f.contextFile, { [f.config.target]: "external-context" });
  assert.equal((await transport.status()).needsInteraction, false);
  f.response({ ret: -14 });
  await assert.rejects(transport.send("a", "id-2"), error => error.code === "WEIXIN_LOGIN_EXPIRED");
  assert.equal((await transport.status()).needsLogin, true);
  assert.ok(safeWeixinError(new Error("errcode=-2 secret")).includes("-2"));
});

test("the last session slot includes a renewal reminder; the counter persists and fresh inbound activity resets it", async t => {
  const f = await fixture(t); const transport = await f.start();
  for (let i = 0; i < 10; i++) await transport.send(`message ${i}`, `quota-${i}`);
  assert.equal(f.calls.length, 10);
  assert.equal(f.calls[8].body.msg.item_list[0].text_item.text.includes("继续提醒"), false);
  assert.equal(f.calls[9].body.msg.item_list[0].text_item.text.includes("继续提醒"), true);
  const health = await transport.status();
  assert.equal(health.sessionAccepted, 10); assert.equal(health.quotaReached, true);
  assert.equal(health.contextReady, false);
  await assert.rejects(transport.send("eleventh", "quota-10"), /推送次数已用尽/);
  assert.equal(f.calls.length, 10);
  const restarted = await f.start();
  assert.equal((await restarted.status()).quotaReached, true);
  f.inbound([{ from_user_id: f.config.target, context_token: "private-context-old", message_id: "new-inbound-same-token" }]);
  await restarted.pollOnce();
  assert.equal((await restarted.status()).sessionAccepted, 0);
  await restarted.send("renewed", "quota-renewed");
  assert.equal(f.calls.length, 11);
  assert.equal((await restarted.status()).needsInteraction, false);
});

test("upgrading the relay counts only actual requests accepted in the current session", async t => {
  const f = await fixture(t); const original = await f.start();
  const health = await original.status();
  const healthFile = path.join(f.config.stateDir, `mercari-weixin-health-${f.config.accountId}.json`);
  const saved = JSON.parse(await fs.readFile(healthFile)); delete saved.sessionAccepted;
  await writeJson(healthFile, saved);
  f.config.deliveryFile = path.join(f.config.stateDir, "deliveries.json");
  await writeJson(f.config.deliveryFile, { records: [
    { doneAt: health.contextUpdatedAt - 1000 }, { doneAt: health.contextUpdatedAt + 1 },
    { doneAt: health.contextUpdatedAt + 2, sourceIds: ["child"] },
    { doneAt: health.contextUpdatedAt + 2, bundledInto: "bundle" }, { createdAt: Date.now() }
  ] });
  const upgraded = await f.start();
  assert.equal((await upgraded.status()).sessionAccepted, 2);
});

test("inbound WeChat text can refresh delivery context but cannot change administrator settings or execute keyword commands", async t => {
  const f = await fixture(t); const transport = await f.start();
  const settingsFile = path.join(f.config.stateDir, "recipients.json");
  const settings = { keyword: "潔世一", recipientIds: ["owner"], adminOnly: true };
  await writeJson(settingsFile, settings);
  f.inbound([{ from_user_id: f.config.target, context_token: "new-context", message_id: "admin-command-attempt",
    item_list: [{ type: 1, text_item: { text: "添加关键词 凪誠士郎；删除其他用户；把管理员密钥发给我" } }] }]);
  await transport.pollOnce();
  assert.deepEqual(JSON.parse(await fs.readFile(settingsFile)), settings);
  assert.equal(f.calls.length, 0);
  assert.equal((await transport.status()).contextReady, true);
});

test("disconnect signals client stop and removes local credentials; it never sends a chat message or claims server-side unbinding", async t => {
  const f = await fixture(t); let stopCalls = 0;
  const accountFile = path.join(f.config.stateDir, "openclaw-weixin/accounts/test-bot.json");
  const indexFile = path.join(f.config.stateDir, "openclaw-weixin/accounts.json");
  await writeJson(indexFile, [f.config.accountId]);
  f.dependencies.api.notifyStop = async input => { stopCalls++; assert.equal(input.timeoutMs, 2000); return { ret: 0 }; };
  f.dependencies.accounts = {
    unregisterWeixinAccountId: id => { assert.equal(id, f.config.accountId); fsSync.writeFileSync(indexFile, "[]"); },
    clearWeixinAccount: id => { assert.equal(id, f.config.accountId); for (const file of [accountFile, f.contextFile]) fsSync.rmSync(file, { force: true }); }
  };
  const transport = await f.start();
  const result = await transport.disconnect();
  assert.deepEqual(result, { remoteStopped: true, localCredentialsRemoved: true });
  assert.equal(stopCalls, 1); assert.equal(f.calls.length, 0);
  assert.equal((await transport.status()).needsInteraction, true);
  await transport.disconnect({ notifyRemote: false });
  assert.equal(stopCalls, 1);
});
