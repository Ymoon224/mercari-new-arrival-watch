import test from "node:test";
import assert from "node:assert/strict";
import { sendChannel, messageFor, bridgeStatus, retryBridge, recipientAdmin } from "../extension/notify.js";
const event = { id: "test", items: [{ title: "商品 <b>测试</b>", price: "¥300", url: "https://jp.mercari.com/item/m123" }] };
const api = { permissions: { contains: async () => true }, notifications: { getPermissionLevel: async () => "granted", create: async () => "test" }, runtime: { getURL: path => `chrome-extension://test/${path}` } };
test("desktop notification needs no external request or WeChat key", async () => {
  await sendChannel("desktop", event, { keyword: "潔世一" }, api, () => { throw new Error("must not request network"); });
});
test("Serverchan receives only the intended notification payload", async () => {
  let called;
  await sendChannel("serverchan", event, { keyword: "潔世一", wechat: "serverchan", token: "SCT12345" }, api, async (url, init) => {
    called = { url, init }; return { ok: true, json: async () => ({ code: 0 }) };
  });
  assert.equal(called.url, "https://sctapi.ftqq.com/SCT12345.send");
  assert.deepEqual(Object.keys(JSON.parse(called.init.body)).sort(), ["desp", "title"]);
  assert.equal(called.init.redirect, "error");
});
test("provider errors are failures even with HTTP 200", async () => {
  await assert.rejects(sendChannel("pushplus", event, { keyword: "test", wechat: "pushplus", token: "12345" }, api,
    async () => ({ ok: true, json: async () => ({ code: 401, msg: "secret" }) })), /未接受/);
});
test("network failures do not leak tokens in error messages", async () => {
  await assert.rejects(sendChannel("serverchan", event, { keyword: "test", wechat: "serverchan", token: "SCTSECRET" }, api,
    async () => { throw new Error("https://sctapi.ftqq.com/SCTSECRET.send failed"); }), error => !error.message.includes("SCTSECRET"));
});
test("PushPlus accepted response is recognized; message contains product link", async () => {
  await sendChannel("pushplus", event, { keyword: "test", wechat: "pushplus", token: "12345" }, api,
    async () => ({ ok: true, json: async () => ({ code: 200 }) }));
  assert.ok(messageFor(event, "test").markdown.includes(event.items[0].url));
});

test("ClawBot transfers stable event IDs only to the authenticated loopback service", async () => {
  let called;
  const settings = { keyword: "潔世一", wechat: "clawbot", token: "a".repeat(64) };
  await sendChannel("clawbot", event, settings, api, async (url, init) => {
    called = { url, init }; return { ok: true, json: async () => ({ ok: true, accepted: true }) };
  });
  assert.equal(called.url, "http://127.0.0.1:17869/notify");
  assert.equal(called.init.headers.Authorization, `Bearer ${settings.token}`);
  assert.equal(JSON.parse(called.init.body).id, event.id);
  assert.equal(called.init.body.includes(settings.token), false);
  assert.equal(called.init.redirect, "error");
});
test("ClawBot outages and rejected keys remain delivery failures without leaking the key", async () => {
  const settings = { keyword: "test", wechat: "clawbot", token: "a".repeat(64) };
  await assert.rejects(sendChannel("clawbot", event, settings, api, async () => { throw new Error(settings.token); }),
    error => error.message.includes("未连接") && !error.message.includes(settings.token));
  await assert.rejects(sendChannel("clawbot", event, settings, api,
    async () => ({ ok: false, status: 401, json: async () => ({ error: "bad key" }) })), /密钥不正确/);
  await assert.rejects(sendChannel("clawbot", event, settings, api,
    async () => ({ ok: true, json: async () => ({ ok: true, accepted: false }) })), /未接受/);
});

test("monitor error alerts describe the outage and never claim new products were found", async () => {
  const alert = { id: "failure-test", type: "monitor-error", keyword: "潔世一", failures: 6,
    time: 1700000000000, lastSuccess: null, error: "页面加载超时",
    url: "https://jp.mercari.com/search?keyword=test", items: [] };
  const message = messageFor(alert, "different keyword");
  assert.equal(message.title, "潔世一：监控连续异常 6 次");
  assert.ok(message.text.includes("请检查电脑网络"));
  assert.ok(message.text.includes("页面加载超时"));
  assert.ok(message.text.includes("尚无成功记录"));
  assert.equal(message.title.includes("新出现的商品"), false);
  const serverAlert = messageFor(alert, "different keyword", { remote: true, timeZone: "Asia/Shanghai" });
  assert.ok(serverAlert.text.includes("请检查服务器网络"));
  assert.ok(serverAlert.text.includes("2023/11/15 06:13:20"));
  let payload;
  await sendChannel("clawbot", alert, { keyword: "潔世一", wechat: "clawbot", token: "a".repeat(64) }, api,
    async (url, init) => { payload = JSON.parse(init.body); return { ok: true, json: async () => ({ ok: true, accepted: true }) }; });
  assert.equal(payload.id, alert.id);
  assert.equal(payload.title, message.title);
  assert.equal(payload.text, message.text);
});

test("bridge health exposes rejected sessions instead of treating saved context as delivery success", async () => {
  const status = await bridgeStatus(api, async () => ({ ok: true, json: async () => ({ ok: true,
    service: "mercari-weixin-bridge", contextReady: false, hasContext: true, needsInteraction: true,
    lastSendError: "微信拒绝发送（-2）", pending: 6, accepted: 8, suppressed: 2 }) }));
  assert.equal(status.contextReady, false); assert.equal(status.hasContext, true);
  assert.equal(status.needsInteraction, true); assert.equal(status.pending, 6);
  assert.equal(status.delivered, 8); assert.equal(status.suppressed, 2);
  assert.ok(status.error.includes("-2"));
});
test("manual retry is authenticated and retries pending batches rather than creating a new test notification", async () => {
  const settings = { wechat: "clawbot", token: "a".repeat(64) }; let called;
  const result = await retryBridge(settings, api, async (url, init) => {
    called = { url, init }; return { ok: true, json: async () => ({ ok: true, accepted: true, pending: 6 }) };
  });
  assert.equal(result.pending, 6); assert.equal(called.url, "http://127.0.0.1:17869/retry");
  assert.equal(called.init.headers.Authorization, `Bearer ${settings.token}`);
  assert.equal(called.init.body, "{}");
  await assert.rejects(retryBridge(settings, api, async () => ({ status: 404 })), /旧版/);
  await assert.rejects(retryBridge(settings, api, async () => ({ status: 401 })), /密钥/);
});

test("ClawBot sends to the event's frozen recipients and legacy pending messages never inherit a newly selected user", async () => {
  const settings = { keyword: "x", wechat: "clawbot", token: "a".repeat(64), recipientIds: ["recipient-new"] };
  const bodies = [];
  const request = async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ ok: true, accepted: true }) }; };
  await sendChannel("clawbot", event, settings, api, request);
  await sendChannel("clawbot", { ...event, recipientIds: ["recipient-old"] }, settings, api, request);
  assert.deepEqual(bodies.map(body => body.recipientIds), [["owner"], ["recipient-old"]]);
  await assert.rejects(sendChannel("clawbot", { ...event, recipientIds: [] }, settings, api, request), /未选择微信接收人/);
  assert.equal(bodies.length, 2);
});

test("recipient administration uses the local administrator secret and only explicit allowed operations", async () => {
  const settings = { wechat: "clawbot", token: "a".repeat(64) }; let called;
  const result = await recipientAdmin(settings, "save-recipient", { id: "owner", name: "本人", enabled: true }, api, async (url, init) => {
    called = { url, init }; return { ok: true, json: async () => ({ ok: true, recipients: [{ id: "owner", name: "本人" }] }) };
  });
  assert.equal(result.recipients[0].name, "本人");
  assert.equal(called.url, "http://127.0.0.1:17869/save-recipient");
  assert.equal(called.init.headers.Authorization, `Bearer ${settings.token}`);
  assert.equal(called.init.body.includes(settings.token), false);
  assert.equal(called.init.redirect, "error");
  await assert.rejects(recipientAdmin(settings, "../../config", {}, api), /操作不正确/);
  await assert.rejects(recipientAdmin(settings, "recipients", {}, api, async () => ({ status: 401 })), /密钥/);
});
