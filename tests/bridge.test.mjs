import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createBridge } from "../bridge/service.mjs";

const token = "a".repeat(64);
const origin = `chrome-extension://${"b".repeat(32)}`;
const sample = { id: "new-1", title: "潔世一：发现上新", text: "商品 ¥300\nhttps://jp.mercari.com/item/m123" };
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(30); }
  throw new Error("condition did not become true");
}
async function fixture(t, send, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mercari-bridge-test-"));
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  const stateFile = path.join(directory, "queue.json");
  const instances = [];
  const start = async () => {
    const bridge = await createBridge({ token, stateFile, send, status: async () => ({ contextReady: true }), port: 0, ...options });
    instances.push(bridge); return bridge;
  };
  t.after(async () => { for (const item of instances) if (item.server.listening) await item.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const bridge = await start();
  const url = `http://127.0.0.1:${bridge.server.address().port}`;
  const post = (message = sample, headers = {}) => fetch(`${url}/notify`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Origin: origin, ...headers }, body: JSON.stringify(message) });
  return { bridge, start, stateFile, url, post };
}

test("only authorized loopback clients can enqueue; setup secrets are not exposed to extensions or websites", async t => {
  const sent = [];
  const f = await fixture(t, async text => sent.push(text));
  assert.equal((await f.post(sample, { Authorization: "Bearer wrong" })).status, 401);
  assert.equal((await f.post(sample, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await fetch(`${f.url}/setup`, { headers: { Origin: origin } })).status, 403);
  const setup = await fetch(`${f.url}/setup`);
  assert.ok((await setup.text()).includes(token));
  assert.ok(setup.headers.get("content-security-policy").includes("frame-ancestors 'none'"));
  const health = await (await fetch(`${f.url}/health`)).text();
  assert.equal(health.includes(token), false);
  assert.equal(sent.length, 0);
  const preflight = await fetch(`${f.url}/notify`, { method: "OPTIONS", headers: { Origin: origin } });
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
});

test("durable acceptance and duplicate retries survive a service restart", async t => {
  const sent = [];
  const f = await fixture(t, async (text, id) => sent.push({ text, id }));
  assert.equal((await (await f.post()).json()).accepted, true);
  assert.equal(JSON.parse(await fs.readFile(f.stateFile)).records.length, 1);
  await until(async () => (await f.bridge.health()).delivered === 1);
  assert.equal((await (await f.post()).json()).duplicate, true);
  await f.bridge.close();
  const restarted = await f.start();
  assert.equal((await restarted.accept(sample)).delivered, true);
  await delay(150);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes("https://jp.mercari.com/item/m123"));
  await assert.rejects(restarted.accept({ ...sample, text: "different" }), /不同内容/);
});

test("upstream receipt metadata survives completion and restart without replaying accepted messages", async t => {
  let calls = 0;
  const f = await fixture(t, async (_text, clientId) => {
    calls++;
    return { accepted: true, receipt: { clientId, acceptedAt: Date.now(), ret: 0,
      serverMessageId: null, serverMessageIdStatus: 'missing', token: 'must-not-be-saved' } };
  });
  await f.bridge.accept(sample);
  await until(async () => (await f.bridge.health()).accepted === 1);
  const text = await fs.readFile(f.stateFile, 'utf8');
  const receipt = JSON.parse(text).records[0].sendReceipts[0];
  assert.equal(receipt.ret, 0); assert.equal(receipt.serverMessageIdStatus, 'missing');
  assert.equal(receipt.chunkIndex, 0); assert.match(receipt.clientId, /^mercari-/);
  assert.equal(text.includes('must-not-be-saved'), false);
  await f.bridge.close(); const restarted = await f.start();
  await restarted.retryPending(); await delay(150);
  assert.equal(calls, 1, 'missing message IDs alone never make a completed message retry');
  assert.equal((await restarted.accept(sample)).duplicate, true);
  assert.deepEqual(JSON.parse(await fs.readFile(f.stateFile, 'utf8')).records[0].sendReceipts[0], receipt);
});

test("failed chunks remain queued and successful chunks are not repeated after restart", async t => {
  let now = Date.now();
  const sent = [];
  let fail = true;
  const f = await fixture(t, async (text, id) => {
    if (sent.length && fail) throw new Error("微信连接暂时中断");
    sent.push({ text, id });
  }, { clock: () => now });
  const long = { ...sample, text: "😀".repeat(4500) };
  await f.bridge.accept(long);
  await until(async () => Boolean((await f.bridge.health()).lastError));
  assert.equal(sent.length, 1);
  assert.equal((await f.bridge.health()).pending, 1);
  await f.bridge.close();
  fail = false; now += 300001;
  const restarted = await f.start();
  await until(async () => (await restarted.health()).delivered === 1);
  assert.equal(sent.length, 2);
  assert.equal(sent.map(item => item.text).join(""), `${long.title}\n\n${long.text}`);
  assert.notEqual(sent[0].id, sent[1].id);
  assert.equal((await restarted.health()).lastError, "");
});

test("malformed notifications never reach WeChat or enter the durable queue", async t => {
  const f = await fixture(t, async () => { throw new Error("must not send"); });
  assert.equal((await f.post({ ...sample, id: "../file" })).status, 400);
  assert.equal((await f.post({ ...sample, text: "a".repeat(40001) })).status, 400);
  assert.equal((await f.bridge.health()).pending, 0);
});

test("rejected sessions stop further sends and retry immediately after a fresh inbound message", async t => {
  let attempts = 0; let rejected = false; let revision = 1;
  const f = await fixture(t, async () => {
    attempts++;
    if (attempts === 1) { rejected = true; throw Object.assign(new Error("微信拒绝发送（-2）"), { code: "WEIXIN_CONTEXT_REJECTED" }); }
  }, { status: async () => ({ contextReady: !rejected, needsInteraction: rejected, sessionRevision: revision }) });
  await f.bridge.accept(sample);
  await until(async () => Boolean((await f.bridge.health()).lastError));
  await f.bridge.accept({ ...sample, id: "new-2" });
  await delay(650);
  assert.equal(attempts, 1, "newly queued batches cannot hammer a rejected context");
  const retryUrl = `${f.url}/retry`;
  assert.equal((await fetch(retryUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
  const retry = await fetch(retryUrl, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Origin: origin }, body: "{}" });
  assert.equal((await retry.json()).pending, 2);
  await delay(550); assert.equal(attempts, 1);
  rejected = false; revision++;
  await until(async () => (await f.bridge.health()).pending === 0);
  assert.equal(attempts, 2, "the two waiting batches are combined into one request");
  await f.bridge.retryPending(); await delay(550);
  assert.equal(attempts, 2, "completed batches are never retried");
});

function listing(id, code, title = "ブルーロック 潔世一 ジャケット", price = "¥7,975") {
  return { id, title: "潔世一：发现 1 件新出现的商品", text: `${title} ${price}\nhttps://jp.mercari.com/shops/product/${code.padEnd(20, "x")}` };
}
test("all Shop offers survive backlog bundling, and a returning product is sent as a new event after restart", async t => {
  const sent = [];
  const f = await fixture(t, async text => sent.push(text));
  await f.bridge.accept(listing("first", "first"));
  await f.bridge.accept(listing("second", "second"));
  await f.bridge.accept(listing("third", "third", undefined, "¥7,000"));
  await until(async () => (await f.bridge.health()).pending === 0);
  assert.equal(sent.length, 1, "all three events share one backlog request");
  for (const code of ["first", "second", "third"]) assert.ok(sent[0].includes(code.padEnd(20, "x")));
  assert.equal((await f.bridge.health()).suppressed, 0);
  assert.equal((await f.bridge.health()).accepted, 3);
  await f.bridge.close();
  // An installed pre-upgrade receipt must not suppress a new discovery event.
  const saved = JSON.parse(await fs.readFile(f.stateFile));
  const hash = text => createHash("sha256").update(text).digest("hex");
  saved.records.find(item => item.id === "first").deliveredKeys = [
    `${hash("潔世一")}:id:shops/product/${"first".padEnd(20, "x")}`,
    `${hash("潔世一")}:shop:${hash(JSON.stringify(["ブルーロック 潔世一 ジャケット", "7975"]))}`
  ];
  await fs.writeFile(f.stateFile, JSON.stringify(saved));
  const restarted = await f.start();
  await restarted.accept({ ...listing("return", "first"), dedupeSimilarShops: true });
  await until(async () => (await restarted.health()).pending === 0);
  assert.equal(sent.length, 2);
  assert.ok(sent[1].includes("first".padEnd(20, "x")));
  assert.equal((await restarted.health()).accepted, 4);
  assert.equal((await restarted.accept(listing("return", "first"))).duplicate, true);
  await delay(150); assert.equal(sent.length, 2, "retrying the same event never creates a second send");
});

test("mixed batches retain every listing even when a legacy client requests content deduplication", async t => {
  const sent = []; const f = await fixture(t, async text => sent.push(text));
  await f.bridge.accept(listing("first", "first"));
  await until(async () => (await f.bridge.health()).accepted === 1);
  const mixed = { id: "mixed", title: "潔世一：发现 2 件新出现的商品", text: `${listing("unused", "second").text}\n\n別の商品 ¥300\nhttps://jp.mercari.com/item/m999` };
  await f.bridge.accept({ ...mixed, dedupeSimilarShops: true });
  await until(async () => (await f.bridge.health()).accepted === 2);
  assert.ok(sent[1].startsWith("潔世一：发现 2 件"));
  assert.ok(sent[1].includes("/item/m999")); assert.equal(sent[1].includes("/shops/"), true);
  await f.bridge.accept({ ...listing("disabled", "third"), dedupeSimilarShops: false });
  await until(async () => (await f.bridge.health()).accepted === 3);
  assert.equal(sent.length, 3);
});

test("a failed combined backlog survives restart with the same text/client ID and completes all original batches atomically", async t => {
  const calls = []; let fail = true;
  const f = await fixture(t, async (text, id) => {
    calls.push({ text, id });
    if (fail) throw Object.assign(new Error("微信拒绝发送（-2）"), { code: "WEIXIN_CONTEXT_REJECTED" });
  });
  const messages = Array.from({ length: 12 }, (_, i) => ({ id: `pending-${i}`, title: "潔世一：发现 1 件新出现的商品",
    text: `商品 ${i} ¥300\nhttps://jp.mercari.com/item/m${1000 + i}` }));
  for (const message of messages) await f.bridge.accept(message);
  await until(async () => Boolean((await f.bridge.health()).lastError));
  assert.equal(calls.length, 1); assert.equal((await f.bridge.health()).pending, 12);
  assert.equal((await f.bridge.health()).accepted, 0);
  const saved = JSON.parse(await fs.readFile(f.stateFile));
  assert.equal(saved.records.filter(item => item.bundledInto).length, 12);
  await f.bridge.close(); fail = false;
  const restarted = await f.start(); await restarted.retryPending();
  await until(async () => (await restarted.health()).pending === 0);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal((await restarted.health()).accepted, 12);
  assert.equal((await restarted.health()).sendRequests, 1);
  for (const message of messages) assert.equal((await restarted.accept(message)).delivered, true);
});
