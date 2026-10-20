import test, { after } from "node:test";
import assert from "node:assert/strict";
const listeners = {};
const event = name => ({ addListener: fn => { listeners[name] = fn; } });
let now = 1700000000000;
const actualNow = Date.now;
Date.now = () => now;
after(() => { Date.now = actualNow; });
const data = {};
const tabs = new Map();
const notifications = [];
const alarms = new Map();
let nextId = 100;
globalThis.chrome = {
  storage: { local: { get: async () => structuredClone(data), set: async values => Object.assign(data, structuredClone(values)),
    remove: async key => { delete data[key]; }, setAccessLevel: async () => {} } },
  runtime: { getURL: name => "chrome-extension://test/" + name, onMessage: event("message"), onInstalled: event("installed"), onStartup: event("startup"), openOptionsPage: async () => {} },
  tabs: { create: async options => { const tab = { id: nextId++, ...options }; tabs.set(tab.id, tab); return tab; },
    get: async id => { if (!tabs.has(id)) throw new Error("missing"); return tabs.get(id); },
    remove: async id => { tabs.delete(id); listeners.removed?.(id); }, onRemoved: event("removed") },
  notifications: { getPermissionLevel: async () => "granted", create: async (id, options) => { notifications.push({ id, options }); return id; }, onClicked: event("notification-click") },
  alarms: { get: async name => alarms.get(name), create: async (name, options) => alarms.set(name, options), clear: async name => alarms.delete(name), onAlarm: event("alarm") },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, onClicked: event("action") },
  permissions: { contains: async () => true }
};
await import("../extension/background.js");
const W = globalThis.MercariWatch;
const ownPage = { url: "chrome-extension://test/dashboard.html" };
const request = (message, sender = ownPage) => new Promise(resolve => listeners.message(message, sender, resolve));
const status = monitorId => request({ type: "status", monitorId });
const getState = id => data.states[id];
const products = start => Array.from({ length: 5 }, (_, i) => ({ url: "https://jp.mercari.com/item/m" + (start + i), title: "商品 " + (start + i), price: "¥300" }));
function senderFor(id) { const run = getState(id).run; return { tab: { id: run.tabId }, frameId: 0, url: tabs.get(run.tabId).url }; }
async function sample(id, list) { return request({ type: "sample", runId: getState(id).run.id, items: list }, senderFor(id)); }
async function check(id) { return request({ type: "check", monitorId: id }); }
async function fail(id) {
  await check(id);
  return request({ type: "sample-error", runId: getState(id).run.id, error: "搜索页加载失败" }, senderFor(id));
}
async function reset() {
  await status();
  for (const key of Object.keys(data)) delete data[key];
  data.schemaVersion = 2; data.settings = { desktop: true, wechat: "none", token: "" }; data.monitors = []; data.states = {};
  tabs.clear(); notifications.length = 0; alarms.clear();
  now += 10000000;
}
async function add(keyword, intervalMinutes = 1, enabled = true) {
  const result = await request({ type: "save-monitor", monitor: { keyword, intervalMinutes, scanCount: 5, enabled } });
  assert.equal(result.ok, true, result.error); return result.monitorId;
}
async function alarm() { await listeners.alarm({ name: "mercari-scheduler" }); }

test("upgrade keeps the original baseline, saved WeChat key and failure episode", async () => {
  await reset();
  delete data.schemaVersion; delete data.monitors; delete data.states;
  data.settings = { ...W.defaults, keyword: "潔世一", scanCount: 5, desktop: false, wechat: "clawbot", token: "a".repeat(64), enabled: false };
  data.state = W.advance(null, products(100), data.settings, now).state;
  data.state.failures = 6; data.state.failureAlerted = true;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, service: "mercari-weixin-bridge", recipients: [{ id: "owner", name: "我的微信" }] }) });
  const migrated = await status();
  assert.equal(migrated.monitors[0].keyword, "潔世一");
  assert.equal(migrated.monitors[0].scanCount, 5);
  assert.equal(migrated.settings.hasToken, true);
  assert.equal(JSON.stringify(migrated).includes("a".repeat(64)), false);
  assert.equal(migrated.state.top.length, 5);
  assert.equal(migrated.state.failures, 6);
  assert.equal(migrated.state.failureAlerted, true);
  assert.equal(data.state, undefined);
});
test("keywords use independent intervals, previous windows, pause controls and unique event IDs", async () => {
  await reset();
  const a = await add("潔世一", 1);
  const b = await add("凪誠士郎", 5);
  assert.equal(alarms.get("mercari-scheduler").periodInMinutes, 1);
  const handshake = await request({ type: "collector-ready" }, senderFor(b));
  assert.equal(handshake.run.keyword, "凪誠士郎"); assert.equal(handshake.run.scanCount, 5);
  await sample(a, products(100)); await sample(b, products(200));
  assert.equal(notifications.length, 0);
  now += 60000; await alarm();
  assert.ok(getState(a).run); assert.equal(getState(b).run, null);
  await sample(a, [products(999)[0], ...products(100).slice(0, 4)]);
  assert.equal(notifications.length, 1);
  assert.ok(notifications[0].options.title.startsWith("潔世一："));
  assert.equal(getState(b).events.length, 0);
  const originalB = structuredClone(getState(b).lastWindow);
  await request({ type: "toggle", monitorId: a });
  now += 240000; await alarm();
  assert.equal(getState(a).run, null); assert.ok(getState(b).run);
  await sample(b, [products(999)[0], ...products(200).slice(0, 4)]);
  assert.equal(notifications.length, 2);
  assert.ok(notifications[1].options.title.startsWith("凪誠士郎："));
  assert.notEqual(getState(a).events[0].id, getState(b).events[0].id);
  assert.deepEqual(originalB, products(200).map(item => W.parseProduct(item.url).key));
  assert.deepEqual(getState(b).lastWindow, [products(999)[0], ...products(200).slice(0, 4)].map(item => W.parseProduct(item.url).key));
});
test("changing an interval keeps the baseline and does not cancel a running collection", async () => {
  await reset();
  const id = await add("潔世一", 1);
  await sample(id, products(100));
  await check(id);
  const runId = getState(id).run.id;
  const before = structuredClone(getState(id).lastWindow);
  const monitor = data.monitors.find(item => item.id === id);
  assert.equal((await request({ type: "save-monitor", monitor: { ...monitor, intervalMinutes: 10 } })).ok, true);
  assert.equal(getState(id).run.id, runId);
  assert.equal(getState(id).nextCheckAt, now + 600000);
  await sample(id, products(100));
  assert.deepEqual(getState(id).lastWindow, before);
  now += 60000; await alarm(); assert.equal(getState(id).run, null);
  now += 540000; await alarm(); assert.ok(getState(id).run);
});
test("queued keywords start as slots free up and a forced check is not lost when busy", async () => {
  await reset();
  const ids = [];
  for (const keyword of ["A", "B", "C", "D"]) ids.push(await add(keyword));
  assert.equal(tabs.size, 3); assert.equal(getState(ids[3]).run, null);
  await sample(ids[0], products(100));
  assert.ok(getState(ids[3]).run);
  // A is not due yet, but an explicit check must wait for a free slot.
  await check(ids[0]); assert.equal(getState(ids[0]).run, null);
  await sample(ids[1], products(200));
  assert.ok(getState(ids[0]).run);
  assert.equal(tabs.size, 3);
});
test("a slow keyword's watchdog runs even with a long configured interval", async () => {
  await reset();
  const id = await add("潔世一", 30);
  now += 120000; await alarm();
  assert.equal(getState(id).run, null);
  assert.equal(getState(id).failures, 1);
  assert.ok(getState(id).lastError.includes("超时"));
  assert.equal(getState(id).nextCheckAt, now + 28 * 60000);
});
test("failure alerts and delivery retries are independent for each keyword", async () => {
  await reset();
  data.settings = { desktop: true, wechat: "clawbot", token: "a".repeat(64) };
  const calls = []; let reject = true;
  globalThis.fetch = async (url, init) => {
    if (url.endsWith("/health")) return { ok: true, json: async () => ({ ok: true, service: "mercari-weixin-bridge", contextReady: true }) };
    if (url.endsWith("/recipients")) return { ok: true, json: async () => ({ ok: true, recipients: [{ id: "owner", name: "我的微信" }] }) };
    calls.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ ok: !reject, accepted: !reject }) };
  };
  const a = await add("潔世一"); const b = await add("凪誠士郎");
  await sample(a, products(100)); await sample(b, products(200));
  const baseline = structuredClone(getState(a).top);
  for (let i = 0; i < 5; i++) await fail(a);
  assert.equal(notifications.length, 0);
  await fail(a);
  assert.equal(notifications.length, 1); assert.equal(getState(a).pending.length, 1);
  const firstId = getState(a).pending[0].id;
  assert.equal(getState(a).pending[0].channels.desktop, true);
  assert.equal(getState(a).pending[0].channels.clawbot, false);
  await fail(a); await fail(b);
  assert.equal(getState(a).failures, 7); assert.equal(getState(b).failures, 1);
  assert.equal(notifications.length, 1); assert.ok(calls.every(item => item.id === firstId));
  assert.deepEqual(getState(a).top, baseline);
  // A paused monitor's failed notification still retries independently of interval.
  await request({ type: "toggle", monitorId: a });
  reject = false; await alarm();
  assert.equal(getState(a).pending.length, 0); assert.equal(notifications.length, 1);
  await request({ type: "toggle", monitorId: a });
  await sample(a, products(100)); assert.equal(getState(a).failures, 0);
  for (let i = 0; i < 6; i++) await fail(a);
  assert.equal(notifications.length, 2);
  assert.notEqual(calls.at(-1).id, firstId);
});
test("tab creation and accidental tab closure count, but pause and reused user tabs do not", async () => {
  await reset();
  const id = await add("潔世一");
  await sample(id, products(100));
  const create = chrome.tabs.create;
  chrome.tabs.create = async () => { throw new Error("cannot create"); };
  try { await check(id); } finally { chrome.tabs.create = create; }
  assert.equal(getState(id).failures, 1);
  await check(id);
  const run = structuredClone(getState(id).run); const sender = senderFor(id);
  tabs.delete(run.tabId); await listeners.removed(run.tabId);
  assert.equal(getState(id).failures, 2);
  assert.deepEqual(await request({ type: "sample-error", runId: run.id, error: "late" }, sender), { ignored: true });
  await check(id);
  const userTab = getState(id).run.tabId; tabs.get(userTab).url = "https://jp.mercari.com/item/m123";
  await request({ type: "toggle", monitorId: id }); await status();
  assert.equal(getState(id).failures, 2); assert.equal(tabs.has(userTab), true);
});
test("editing and deleting one keyword never erase another keyword's history or credentials", async () => {
  await reset();
  const a = await add("潔世一"); const b = await add("凪誠士郎");
  await sample(a, products(100)); await sample(b, products(200));
  const originalB = structuredClone(getState(b));
  const changed = await request({ type: "save-monitor", monitor: { ...data.monitors.find(item => item.id === a), keyword: "蜂楽廻" } });
  assert.equal(changed.ok, true); assert.equal(getState(a).initialized, false);
  assert.deepEqual(getState(b), originalB);
  await request({ type: "delete-monitor", monitorId: a });
  assert.equal(getState(a), undefined); assert.deepEqual(getState(b), originalB);
  assert.equal((await request({ type: "save-monitor", monitor: { keyword: "凪誠士郎" } })).error.includes("已有相同关键词"), true);
});
test("foreign pages and samples from a different keyword cannot access settings or affect history", async () => {
  await reset();
  const id = await add("潔世一");
  const sender = senderFor(id); sender.url = sender.url.replace(encodeURIComponent("潔世一"), "other");
  assert.deepEqual(await request({ type: "sample", runId: getState(id).run.id, items: products(100) }, sender), { ignored: true });
  assert.equal(getState(id).initialized, false);
  assert.ok((await request({ type: "status" }, { url: "https://jp.mercari.com/search", tab: { id: 999 } })).error);
});
test("browser restart preserves per-keyword due times and recreates a missing scheduler", async () => {
  await reset();
  const a = await add("A", 1); const b = await add("B", 5);
  await sample(a, products(100)); await sample(b, products(200));
  const beforeB = structuredClone(getState(b));
  alarms.clear(); now += 60000; await listeners.startup();
  assert.ok(alarms.has("mercari-scheduler"));
  assert.ok(getState(a).run); assert.equal(getState(b).run, null);
  assert.deepEqual(getState(b), beforeB);
});

test("only the local extension page can import or edit recipients; ordinary web and collector messages cannot administer users", async () => {
  await reset();
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("must not reach administration"); };
  const sender = { url: "https://jp.mercari.com/search", frameId: 0, tab: { id: 999 } };
  assert.ok((await request({ type: "sync-recipients" }, sender)).error.includes("不允许"));
  assert.ok((await request({ type: "save-recipient", recipient: { id: "owner", enabled: false } }, sender)).error.includes("不允许"));
  assert.equal(called, false);
});
