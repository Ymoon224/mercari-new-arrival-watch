import test from "node:test";
import assert from "node:assert/strict";
import { remoteUrl, remotePermission, remoteRequest } from "../extension/remote.js";
const data = {}; const callbacks = {}; const tabs = new Map(); const alarms = new Map(); const requests = [];
let created = 0; let allowed = true;
const event = name => ({ addListener: fn => { callbacks[name] = fn; } });
globalThis.chrome = {
  storage: { local: { get: async () => structuredClone(data), set: async value => Object.assign(data, structuredClone(value)), remove: async key => delete data[key], setAccessLevel: async () => {} } },
  runtime: { getURL: name => `chrome-extension://test/${name}`, onMessage: event("message"), onInstalled: event("installed"), onStartup: event("startup"), openOptionsPage: async () => {} },
  tabs: { create: async options => { const id = ++created; tabs.set(id, { id, ...options }); return { id }; }, get: async id => tabs.get(id), remove: async id => tabs.delete(id), onRemoved: event("removed") },
  alarms: { get: async name => alarms.get(name), create: async (name, value) => alarms.set(name, value), clear: async name => alarms.delete(name), onAlarm: event("alarm") },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, onClicked: event("action") },
  notifications: { onClicked: event("notification"), create: async () => { throw new Error("unexpected local notification"); } },
  permissions: { contains: async () => allowed }
};
const remoteStatus = { version: "2.0.0", monitors: [], settings: { desktop: false, wechat: "clawbot", hasToken: true }, recipients: [], state: null, selectedId: null, executionMode: "remote", server: { collector: "http" } };
globalThis.fetch = async (url, options) => { requests.push({ url, ...options }); return { ok: true, text: async () => JSON.stringify(JSON.parse(options.body).type === "status" ? remoteStatus : { ok: true }) }; };
await import("../extension/background.js");
const request = (message, sender = { url: "chrome-extension://test/dashboard.html" }) => new Promise(resolve => callbacks.message(message, sender, resolve));
const token = "b".repeat(64);

test("remote server URL rejects insecure non-loopback and embedded credentials without sending secrets", async () => {
  for (const url of ["http://example.com", "https://a:b@example.com", "https://example.com?token=x", "https://example.com/#x", "file:///tmp", "https://example.com/api", "https://example.com/api/admin"]) assert.throws(() => remoteUrl(url));
  assert.equal(remoteUrl(" https://example.com/ "), "https://example.com");
  assert.equal(remotePermission("http://127.0.0.1:17870"), "http://127.0.0.1/*");
  assert.throws(() => remoteUrl("http://[::1]:17870"));
  allowed = false; const before = requests.length;
  await assert.rejects(() => remoteRequest({ baseUrl: "https://example.com", token }, { type: "status" }), /允许访问/);
  assert.equal(requests.length, before); allowed = true;
});

test("connecting remote suspends local collector and retries while preserving local data and unrelated tabs", async () => {
  await request({ type: "status" });
  const W = globalThis.MercariWatch;
  data.schemaVersion = 2; data.settings = { desktop: false, wechat: "none", token: "local-private" };
  data.monitors = [{ id: "local", keyword: "潔世一", intervalMinutes: 1, scanCount: 5, enabled: true }];
  data.states = { local: { ...W.emptyState("潔世一"), initialized: true, lastWindow: ["item:m123"], pending: [{ id: "pending", channels: { clawbot: false } }], run: { id: "owned", tabId: 91 } } };
  tabs.set(91, { url: "https://jp.mercari.com/search#mercari-watch=owned" }); tabs.set(92, { url: "https://jp.mercari.com/search" });
  alarms.set("mercari-scheduler", {}); alarms.set("mercari-check", {});
  const connected = await request({ type: "connect-remote", baseUrl: "https://example.com/", token });
  assert.equal(connected.ok, true); assert.equal(JSON.stringify(connected).includes(token), false);
  assert.equal(data.remoteController.mode, "remote"); assert.equal(data.remoteController.token, token);
  assert.equal(tabs.has(91), false); assert.equal(tabs.has(92), true); assert.equal(alarms.size, 0);
  assert.equal(data.settings.token, "local-private"); assert.deepEqual(data.states.local.lastWindow, ["item:m123"]); assert.equal(data.states.local.pending.length, 1); assert.equal(data.monitors[0].enabled, true);
  const count = created;
  await callbacks.alarm({ name: "mercari-scheduler" }); await callbacks.startup();
  const status = await request({ type: "status" }); assert.equal(status.executionMode, "remote"); assert.equal(status.controller.baseUrl, "https://example.com");
  assert.equal(JSON.stringify(status).includes(token), false); assert.equal(created, count); assert.equal(alarms.size, 0);
  await request({ type: "save-monitor", monitor: { keyword: "x", blockedWords: ["a"] } });
  assert.equal(requests.at(-1).url, "https://example.com/api/admin"); assert.equal(JSON.parse(requests.at(-1).body).monitor.keyword, "x");
  assert.equal(requests.at(-1).headers.Authorization, `Bearer ${token}`); assert.equal(requests.at(-1).redirect, "error"); assert.equal(requests.at(-1).credentials, "omit");
  assert.equal(data.monitors[0].keyword, "潔世一");
  await request({ type: "save-collection-schedule", schedule: { enabled: true, timeZone: "Asia/Shanghai", windows: [{ start: "09:00", end: "23:00" }] } });
  assert.equal(JSON.parse(requests.at(-1).body).type, "save-collection-schedule");
  assert.equal(data.collectionSchedule, undefined, "the server owns the collection schedule; it must not start a local timer");
  const countRequests = requests.length;
  assert.deepEqual(await request({ type: "collector-ready" }, { url: "https://jp.mercari.com/search", frameId: 0, tab: { id: 91 } }), {});
  assert.equal(requests.length, countRequests);
  assert.match((await request({ type: "pause-all" }, { url: "https://evil.example" })).error, /不允许/);
  assert.equal(requests.length, countRequests);
});

test("remote disconnect never starts local tasks; switching local requires separate explicit activation", async () => {
  await request({ type: "disconnect-remote" }); assert.equal(data.remoteController.mode, "remote"); assert.equal(data.remoteController.token, undefined);
  const before = created;
  assert.equal((await request({ type: "status" })).monitors.length, 0);
  await request({ type: "switch-local" });
  const local = await request({ type: "status" }); assert.equal(local.executionMode, "local"); assert.equal(local.controller.localSuspended, true); assert.equal(local.monitors[0].keyword, "潔世一");
  await callbacks.alarm({ name: "mercari-scheduler" }); assert.equal(created, before);
  data.states.local.pending = []; data.settings.desktop = true;
  await request({ type: "activate-local" }); assert.equal(created, before + 1); assert.equal(data.remoteController.localSuspended, false);
});

test("failed remote handshake keeps current local mode and unknown admin messages never reach remote", async () => {
  const previous = structuredClone(data.remoteController); const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401 });
  assert.match((await request({ type: "connect-remote", baseUrl: "https://other.example", token })).error, /管理员密钥/);
  assert.deepEqual(data.remoteController, previous);
  globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ ...remoteStatus, executionMode: "local" }) });
  assert.match((await request({ type: "connect-remote", baseUrl: "https://other.example", token })).error, /运行模式不兼容/);
  assert.deepEqual(data.remoteController, previous); globalThis.fetch = oldFetch;
  await assert.rejects(() => remoteRequest({ baseUrl: "https://example.com", token }, { type: "execute-shell" }), /不支持/);
});

test("blocked title filtering preserves raw comparison window and baseline without extra fetches", () => {
  const W = globalThis.MercariWatch; const settings = { ...W.defaults, keyword: "x", scanCount: 5, blockedWords: [" ＡＢＣ "] };
  const items = n => Array.from({ length: 5 }, (_, i) => ({ url: `/item/m${n + i}`, title: i === 0 ? "商品 abc" : "商品" }));
  const first = W.advance(null, items(1), settings).state;
  const next = W.advance(first, items(10), settings);
  assert.equal(next.fresh.length, 4); assert.equal(next.state.lastWindow.length, 5); assert.equal(next.state.top[0].id, "m10");
  assert.equal(next.state.events[0].items.some(item => item.id === "m10"), false);
  assert.equal(W.advance(next.state, items(10), settings).fresh.length, 0);
});
