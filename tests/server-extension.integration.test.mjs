import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteApp } from "../server/app.mjs";
import { remoteRequest, qrPresentation } from "../extension/remote.js";

test("actual extension controller speaks the remote HTTP admin contract without local collection", async t => {
  const token = "c".repeat(64), calls = [], listeners = {}, data = {};
  let creates = 0, qrStatus = "wait";
  const event = name => ({ addListener: fn => { listeners[name] = fn; } });
  const monitors = [];
  const states = {};
  const users = [{ id: "receiver-a", name: "接收人甲", enabled: true, contextReady: true }];
  const status = monitorId => {
    const selected = monitors.find(row => row.id === monitorId) || monitors[0];
    return { version: "2.0.0", executionMode: "remote", settings: { desktop: false, wechat: "clawbot", hasToken: true },
      monitors: structuredClone(monitors), selectedId: selected?.id || null, state: selected ? structuredClone(states[selected.id]) : null,
      recipients: structuredClone(users), recipientsError: "", bridge: { connected: true, multiRecipient: true, pending: 0, delivered: 1 },
      server: { collector: "http", running: true, activeRequests: 0, storageError: "", minRequestGapMs: 5000, maxConcurrent: 1 } };
  };
  const monitor = {
    status: async id => status(id), removeRecipients: async ids => calls.push({ type: "removed-recipients", ids }),
    admin: async message => {
      calls.push(structuredClone(message));
      if (message.type === "status") return status(message.monitorId);
      if (message.type === "save-monitor") {
        assert.deepEqual(message.monitor.blockedWords, ["全巻", "Novel"]);
        const row = { ...message.monitor, id: message.monitor.id || "remote-watch" };
        monitors.push(row); states[row.id] = { keyword: row.keyword, top: [], lastWindow: [], events: [], pending: [], run: null, failures: 0 };
        return { ok: true, monitorId: row.id };
      }
      if (message.type === "toggle") monitors.find(row => row.id === message.monitorId).enabled = !monitors.find(row => row.id === message.monitorId).enabled;
      if (["pause-all", "start-all"].includes(message.type)) monitors.forEach(row => row.enabled = message.type === "start-all");
      return { ok: true };
    }
  };
  const hub = {
    admin: async (route, input) => { calls.push({ route, input }); return { recipients: structuredClone(users), imported: 0 }; },
    accept: async message => { calls.push({ type: "hub-accept", message }); return { ok: true, accepted: true }; }
  };
  const qr = () => ({ id: "qr-session", status: qrStatus, expiresAt: Date.now() + 180000,
    ...(["wait", "scanned"].includes(qrStatus) ? { qrUrl: "https://liteapp.weixin.qq.com/q/official-payload" } : {}) });
  const login = {
    start: async message => { calls.push(message); qrStatus = "wait"; return qr(); },
    status: async message => { assert.equal(message.id, "qr-session"); assert.equal(message.sessionId, undefined); calls.push(message); return qr(); },
    verify: async message => { assert.equal(message.id, "qr-session"); assert.equal(message.code, "123456"); calls.push(message); qrStatus = "connected"; return qr(); },
    cancel: async message => { assert.equal(message.id, "qr-session"); calls.push(message); qrStatus = "cancelled"; return qr(); }
  };
  const app = await createRemoteApp({ config: { token, host: "127.0.0.1", port: 0, requireHttps: false }, monitor, hub, login });
  t.after(() => app.close());
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  data.remoteController = { mode: "remote", baseUrl, token, localSuspended: true };
  data.schemaVersion = 2; data.settings = { desktop: false, wechat: "none", token: "local-secret-kept" }; data.monitors = []; data.states = {};
  globalThis.chrome = {
    storage: { local: { get: async () => structuredClone(data), set: async values => Object.assign(data, structuredClone(values)), remove: async () => {}, setAccessLevel: async () => {} } },
    runtime: { getURL: name => `chrome-extension://test/${name}`, onMessage: event("message"), onInstalled: event("installed"), onStartup: event("startup"), openOptionsPage: async () => {} },
    tabs: { create: async () => { creates++; throw new Error("local collection forbidden"); }, get: async () => null, remove: async () => {}, onRemoved: event("removed") },
    alarms: { clear: async () => {}, create: async () => { throw new Error("local scheduler forbidden"); }, onAlarm: event("alarm") },
    action: { setBadgeText: async () => {}, onClicked: event("action") },
    notifications: { onClicked: event("notification") }, permissions: { contains: async () => true }
  };
  await import("../extension/monitoring.js");
  const request = message => new Promise(resolve => listeners.message(message, { url: "chrome-extension://test/dashboard.html" }, resolve));

  const first = await request({ type: "status" });
  assert.equal(first.version, "2.0.0"); assert.equal(first.executionMode, "remote"); assert.equal(first.server.collector, "http");
  assert.equal(first.controller.baseUrl, baseUrl); assert.equal(first.controller.hasToken, true);
  assert.equal(JSON.stringify(first).includes(token), false); assert.equal(JSON.stringify(first).includes("local-secret-kept"), false);
  const saved = await request({ type: "save-monitor", monitor: { keyword: "潔世一", blockedWords: ["全巻", "Novel"], intervalMinutes: 3, scanCount: 5, enabled: true, recipientIds: ["receiver-a"] } });
  assert.equal(saved.monitorId, "remote-watch");
  const afterSave = await request({ type: "status", monitorId: saved.monitorId });
  assert.equal(afterSave.selectedId, saved.monitorId); assert.deepEqual(afterSave.monitors[0].blockedWords, ["全巻", "Novel"]);
  await request({ type: "toggle", monitorId: saved.monitorId }); assert.equal((await request({ type: "status" })).monitors[0].enabled, false);
  await request({ type: "start-all" }); assert.equal((await request({ type: "status" })).monitors[0].enabled, true);
  await request({ type: "pause-all" }); assert.equal((await request({ type: "status" })).monitors[0].enabled, false);
  await request({ type: "save-recipient", recipient: { id: "receiver-a", name: "修改备注", enabled: false } });
  assert.deepEqual(calls.find(row => row.route === "/save-recipient").input, { id: "receiver-a", name: "修改备注", enabled: false });

  let session = await request({ type: "qr-start" });
  assert.equal(session.ok, true); assert.equal(session.id, "qr-session"); assert.ok(session.qrUrl.startsWith("https://"));
  assert.equal(qrPresentation(session).showQr, true); assert.equal(qrPresentation(session).connected, false);
  qrStatus = "scanned"; session = await request({ type: "qr-status", id: session.id }); assert.equal(qrPresentation(session).active, true);
  qrStatus = "need_verifycode"; session = await request({ type: "qr-status", id: session.id });
  assert.equal(qrPresentation(session).verify, true); assert.equal(qrPresentation(session).showQr, false);
  session = await request({ type: "qr-verify", id: session.id, code: "123456" });
  assert.equal(qrPresentation(session).connected, true); assert.equal(qrPresentation(session).active, false); assert.equal(session.qrUrl, undefined);
  await request({ type: "qr-start" }); session = await request({ type: "qr-cancel", id: "qr-session" }); assert.equal(qrPresentation(session).status, "cancelled");
  qrStatus = "failed"; session = await request({ type: "qr-status", id: "qr-session" });
  assert.equal(session.ok, true, "HTTP success only acknowledges a status query");
  assert.equal(qrPresentation(session).connected, false, "HTTP 200/ok never means a successful binding");
  assert.equal(qrPresentation(session).active, false); assert.match(qrPresentation(session).message, /失败/);
  assert.equal(qrPresentation({ ok: true }).connected, false);
  for (const forbidden of [token, "bot_token", "context_token", "qrcode", "accountId"]) assert.equal(JSON.stringify(session).includes(forbidden), false);

  await request({ type: "test-notification", channel: "clawbot", monitorId: saved.monitorId });
  assert.deepEqual(calls.find(row => row.type === "hub-accept").message.recipientIds, ["receiver-a"]);
  assert.equal(data.monitors.length, 0, "remote edits never overwrite saved local data"); assert.equal(data.settings.token, "local-secret-kept");
  await listeners.alarm({ name: "mercari-scheduler" }); assert.equal(creates, 0);
  await assert.rejects(() => remoteRequest({ baseUrl, token: "d".repeat(64) }, { type: "status" }), /管理员密钥/);
});

test("403 connection failures describe HTTPS/origin checks, separately from invalid administrator authentication", async t => {
  const token = "e".repeat(64);
  const app = await createRemoteApp({ config: { token, host: "127.0.0.1", port: 0, requireHttps: true }, monitor: {}, hub: {}, login: {} });
  t.after(() => app.close());
  globalThis.chrome = { permissions: { contains: async () => true } };
  await assert.rejects(() => remoteRequest({ baseUrl: `http://127.0.0.1:${app.server.address().port}`, token }, { type: "status" }), /HTTPS.*允许来源/);
});
