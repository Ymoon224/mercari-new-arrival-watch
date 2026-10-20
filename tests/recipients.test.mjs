import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createRecipientHub, REMOVAL_NOTICE } from "../bridge/recipients.mjs";
import { createBridge, notification } from "../bridge/service.mjs";
import { writeJson, readJson } from "../bridge/weixin.mjs";

const sample = { id: "new-test", title: "关键词：发现上新", text: "商品 ¥300\nhttps://jp.mercari.com/item/m123" };
async function until(check) { for (let i = 0; i < 150; i++) { if (await check()) return; await delay(20); } throw new Error("condition did not become true"); }
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mercari-recipients-test-"));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  const directory = path.join(root, "bridge"); const stateDir = path.join(root, "state");
  const config = { token: "a".repeat(64), accountId: "owner-bot", target: "owner@im.wechat", stateDir };
  await writeJson(path.join(stateDir, "openclaw-weixin/accounts.json"), ["owner-bot"]);
  await writeJson(path.join(stateDir, "openclaw-weixin/accounts/owner-bot.json"), { token: "PRIVATE-OWNER-LOGIN", userId: config.target });
  const old = { ...notification({ ...sample, id: "old-accepted" }), nextChunk: 1, createdAt: Date.now(), doneAt: Date.now() };
  delete old.chunks;
  await writeJson(path.join(directory, "deliveries.json"), { records: [old] });
  const sent = []; const controls = new Map(); const instances = [];
  const f = { root, directory, config, sent, controls, disconnected: [], rejectNewAcceptance: false };
  async function start() {
    const hub = await createRecipientHub({ config, directory, port: 0,
      transportFactory: async transportConfig => {
        if (!controls.has(transportConfig.accountId)) controls.set(transportConfig.accountId, { blocked: false, revision: 1 });
        const control = controls.get(transportConfig.accountId);
        return {
          status: async () => ({ contextReady: !control.blocked && !control.expired, needsInteraction: control.blocked, needsLogin: control.expired,
            verified: !control.blocked && !control.expired, sessionRevision: control.revision, lastPollError: control.expired ? "微信登录已失效，请重新扫码登录" : "" }),
          send: async (text, id) => {
            if (control.blocked || control.expired) throw new Error("微信登录已失效");
            sent.push({ account: transportConfig.accountId, target: transportConfig.target, text, id });
          },
          disconnect: async () => {
            if (control.cleanupFails) throw new Error("Simulated credential cleanup failure");
            f.disconnected.push(transportConfig.accountId);
            const indexFile = path.join(stateDir, "openclaw-weixin/accounts.json");
            await writeJson(indexFile, (await readJson(indexFile)).filter(id => id !== transportConfig.accountId));
            await fs.rm(path.join(stateDir, "openclaw-weixin/accounts", `${transportConfig.accountId}.json`), { force: true });
            return { remoteStopped: !control.blocked, localCredentialsRemoved: true };
          },
          monitor: signal => new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", resolve, { once: true }); })
        };
      },
      queueFactory: async options => {
        const queue = await createBridge(options);
        const accept = queue.accept;
        queue.accept = async input => {
          if (f.rejectNewAcceptance && !options.stateFile.endsWith("deliveries.json")) { f.rejectNewAcceptance = false; throw new Error("队列保存失败模拟"); }
          return accept(input);
        };
        return queue;
      }
    });
    instances.push(hub); return hub;
  }
  t.after(async () => { for (const hub of instances) if (hub.server.listening) await hub.close(); await fs.rm(root, { recursive: true, force: true }); });
  f.hub = await start(); f.start = start;
  f.url = `http://127.0.0.1:${f.hub.server.address().port}`;
  f.post = (route, body = {}, headers = {}) => fetch(`${f.url}/${route}`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}`, ...headers }, body: JSON.stringify(body) });
  f.addBob = async () => {
    await writeJson(path.join(stateDir, "openclaw-weixin/accounts/bob-bot.json"), { token: "PRIVATE-BOB-LOGIN", userId: "bob@im.wechat" });
    await writeJson(path.join(stateDir, "openclaw-weixin/accounts.json"), ["owner-bot", "bob-bot"]);
    const result = await f.hub.admin("/sync-recipients", {});
    return result.recipients.find(row => row.id !== "owner");
  };
  return f;
}

test("the original recipient keeps its queue, and private administration requires the local secret", async t => {
  const f = await fixture(t);
  assert.equal((await f.hub.health()).accepted, 1);
  assert.equal(f.sent.length, 0);
  assert.equal((await f.post("recipients", {}, { Authorization: "Bearer wrong" })).status, 401);
  assert.equal((await f.post("save-recipient", { id: "owner", name: "改名" }, { Origin: "https://evil.test" })).status, 403);
  const bob = await f.addBob();
  await f.hub.admin("/save-recipient", { id: bob.id, name: "朋友甲" });
  const privateList = await (await f.post("recipients")).json();
  assert.equal(privateList.recipients.length, 2);
  assert.equal(privateList.recipients.find(row => row.id === bob.id).name, "朋友甲");
  const publicText = await (await fetch(`${f.url}/health`)).text();
  for (const secret of [configToken(f), "PRIVATE-", "朋友甲", "owner@im.wechat", "bob-bot", bob.id]) assert.equal(publicText.includes(secret), false);
  assert.equal(JSON.stringify(privateList).includes("PRIVATE-"), false);
  assert.equal(JSON.stringify(privateList).includes("accountId"), false);
});
function configToken(f) { return f.config.token; }

test("newly bound accounts receive nothing until explicitly selected, and invalid fan-out cannot send a partial notification", async t => {
  const f = await fixture(t); const bob = await f.addBob();
  await f.hub.accept(sample); // Old extensions and queued events target only owner.
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0].account, "owner-bot");
  await assert.rejects(f.hub.accept({ ...sample, id: "bad-1", recipientIds: ["owner", "unknown"] }), /接收人不存在/);
  await assert.rejects(f.hub.accept({ ...sample, id: "bad-2", recipientIds: ["../outside"] }), /接收人/);
  await assert.rejects(f.hub.accept({ ...sample, id: "bad-3", recipientIds: [] }), /未指定/);
  assert.equal(f.sent.length, 1);
  await f.hub.accept({ ...sample, id: "bob-only", recipientIds: [bob.id, bob.id] });
  await until(() => f.sent.length === 2);
  assert.equal(f.sent[1].account, "bob-bot");
});

test("one paused recipient cannot block another and resuming sends only that recipient's saved messages", async t => {
  const f = await fixture(t); const bob = await f.addBob();
  await f.hub.admin("/save-recipient", { id: bob.id, enabled: false });
  await f.hub.accept({ ...sample, recipientIds: ["owner", bob.id] });
  await until(() => f.sent.length === 1);
  await delay(600); assert.equal(f.sent.length, 1);
  const rows = (await f.hub.admin("/recipients", {})).recipients;
  assert.equal(rows.find(row => row.id === bob.id).pending, 1);
  assert.equal(rows.find(row => row.id === "owner").pending, 0);
  await f.hub.admin("/save-recipient", { id: bob.id, enabled: true });
  await until(() => f.sent.length === 2);
  assert.equal(f.sent[1].account, "bob-bot");
  await until(async () => (await f.hub.health()).pending === 0);
  await f.hub.retryPending(); await delay(550);
  assert.equal(f.sent.length, 2);
});

test("a partially accepted multi-recipient handoff retries without repeating a recipient who already succeeded, including restart", async t => {
  const f = await fixture(t); const bob = await f.addBob();
  f.rejectNewAcceptance = true;
  const message = { ...sample, recipientIds: ["owner", bob.id] };
  await assert.rejects(f.hub.accept(message), /队列保存失败/);
  await until(() => f.sent.length === 1);
  await f.hub.close();
  const restarted = await f.start();
  await restarted.accept(message);
  await until(() => f.sent.length === 2);
  assert.equal(f.sent.filter(call => call.account === "owner-bot").length, 1);
  assert.equal(f.sent.filter(call => call.account === "bob-bot").length, 1);
  assert.equal((await restarted.admin("/recipients", {})).recipients[1].id, bob.id);
  await until(async () => (await restarted.health()).pending === 0);
  const files = await fs.readdir(path.join(f.directory, "queues"));
  assert.deepEqual(files, [`${bob.id}.json`]);
  assert.equal((await readJson(path.join(f.directory, "deliveries.json"))).records.some(row => row.id === "old-accepted"), true);
});

test("administrator deletion stops and archives only the selected user's queue; stale clients and account synchronization cannot revive them", async t => {
  const f = await fixture(t); const bob = await f.addBob();
  assert.equal((await f.post("delete-recipient", { id: bob.id, confirmName: bob.name }, { Authorization: "wrong" })).status, 401);
  await assert.rejects(f.hub.admin("/delete-recipient", { id: bob.id, confirmName: "wrong user" }), /重新确认/);
  await f.hub.admin("/save-recipient", { id: bob.id, enabled: false });
  await f.hub.accept({ ...sample, recipientIds: ["owner", bob.id] });
  await until(() => f.sent.length === 1);
  const result = await f.hub.admin("/delete-recipient", { id: bob.id, confirmName: bob.name });
  assert.equal(result.noticeState, "not-requested"); assert.equal(result.localCredentialsRemoved, true);
  assert.equal(result.recipients.length, 1); assert.ok(result.deletedRecipientIds.includes(bob.id));
  assert.equal(f.sent.length, 1, "no unsolicited deletion notice");
  assert.deepEqual(f.disconnected, ["bob-bot"]);
  const archives = await fs.readdir(path.join(f.directory, "deleted-queues"));
  assert.equal(archives.length, 1);
  assert.equal((await readJson(path.join(f.directory, "deleted-queues", archives[0]))).records.some(row => row.id === sample.id), true);
  const stale = await f.hub.accept({ ...sample, id: "stale-after-delete", recipientIds: ["owner", bob.id] });
  assert.equal(stale.removedRecipients, 1);
  await until(() => f.sent.length === 2); assert.equal(f.sent[1].account, "owner-bot");
  await f.hub.close(); const restarted = await f.start();
  assert.equal((await restarted.accept({ ...sample, id: "dead-only", recipientIds: [bob.id] })).discarded, true);
  // A stale local credential/index copy is ignored until a genuinely new QR login.
  await writeJson(path.join(f.config.stateDir, "openclaw-weixin/accounts/bob-bot.json"), { token: "PRIVATE-BOB-LOGIN", userId: "bob@im.wechat" });
  await writeJson(path.join(f.config.stateDir, "openclaw-weixin/accounts.json"), ["owner-bot", "bob-bot"]);
  assert.equal((await restarted.admin("/sync-recipients", {})).imported, 0);
  await writeJson(path.join(f.config.stateDir, "openclaw-weixin/accounts/bob-bot.json"), { token: "NEW-EXPLICIT-QR-LOGIN", userId: "bob@im.wechat" });
  const imported = await restarted.admin("/sync-recipients", {});
  assert.equal(imported.imported, 1);
  assert.notEqual(imported.recipients.find(row => row.id !== "owner").id, bob.id);
  assert.equal(f.sent.length, 2);
});

test("an optional removal notice is attempted once, and a failed notice never prevents revocation", async t => {
  const f = await fixture(t); const bob = await f.addBob();
  const result = await f.hub.admin("/delete-recipient", { id: bob.id, confirmName: bob.name, notifyBeforeDelete: true });
  assert.equal(result.noticeState, "accepted"); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].text, REMOVAL_NOTICE);
  await f.hub.admin("/delete-recipient", { id: bob.id, confirmName: bob.name, notifyBeforeDelete: true });
  assert.equal(f.sent.length, 1);
  await f.hub.close(); const restarted = await f.start();
  assert.equal((await restarted.admin("/recipients", {})).recipients.length, 1);
  assert.equal(f.sent.length, 1);
  // Test the already-disconnected case shown in the screenshot.
  f.controls.get("owner-bot").blocked = true;
  const failed = await restarted.admin("/delete-recipient", { id: "owner", confirmName: "我的微信", notifyBeforeDelete: true });
  assert.equal(failed.noticeState, "failed"); assert.equal(failed.localCredentialsRemoved, true);
  assert.equal((await restarted.health()).recipientCount, 0);
  assert.equal((await restarted.accept({ ...sample, id: "legacy-after-owner-removed" })).discarded, true);
  assert.equal(f.sent.length, 1);
  await restarted.close(); const empty = await f.start();
  assert.equal((await empty.health()).recipientCount, 0);
  assert.equal((await empty.admin("/recipients", {})).ok, true, "local administrator access survives deletion of all receiving accounts");
});

test("an interrupted deletion remains revoked and finishes local cleanup on restart without retrying a notice", async t => {
  const f = await fixture(t); const bob = await f.addBob();
  f.controls.get("bob-bot").cleanupFails = true;
  const result = await f.hub.admin("/delete-recipient", { id: bob.id, confirmName: bob.name });
  assert.ok(result.cleanupWarning); assert.equal(result.recipients.length, 1);
  assert.equal((await f.hub.accept({ ...sample, recipientIds: [bob.id] })).discarded, true);
  await f.hub.close(); f.controls.get("bob-bot").cleanupFails = false;
  const restarted = await f.start();
  const registry = await readJson(path.join(f.directory, "recipients.json"));
  assert.equal(registry.deleted[0].cleanupPending, false);
  assert.equal((await restarted.health()).recipientCount, 1);
  assert.equal(f.sent.length, 0);
});

test("another user's expired login accumulates only their own backlog and never pauses the healthy recipient", async t => {
  const f = await fixture(t); const bob = await f.addBob();
  f.controls.get("bob-bot").expired = true;
  for (let i = 0; i < 3; i++) await f.hub.accept({ ...sample, id: `while-bob-offline-${i}`, recipientIds: ["owner", bob.id] });
  await until(async () => (await f.hub.admin("/recipients", {})).recipients.find(row => row.id === "owner").pending === 0);
  const rows = (await f.hub.admin("/recipients", {})).recipients;
  assert.equal(rows.find(row => row.id === bob.id).pending, 3);
  assert.equal(rows.find(row => row.id === bob.id).needsLogin, true);
  assert.ok(f.sent.length > 0); assert.ok(f.sent.every(call => call.account === "owner-bot"));
  assert.equal((await f.hub.health()).contextReady, true);
  assert.equal((await f.hub.health()).blockedCount, 1);
});
