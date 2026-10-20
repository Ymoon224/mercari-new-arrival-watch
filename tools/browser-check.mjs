// Local integration check; no Mercari login or external notification is used.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
const modulePath = process.env.PLAYWRIGHT_MODULE;
const { chromium } = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1240, height: 1000 } });
  await page.setContent(await readFile(resolve(root, "tests/fixtures/search.html"), "utf8"));
  await page.addScriptTag({ path: resolve(root, "extension/shared.js") });
  await page.addScriptTag({ path: resolve(root, "extension/collector.js") });
  const result = await page.evaluate(() => {
    const sample = MercariCollector.readDocument();
    return { ids: sample.items.map(i => i.id), ignored: sample.ignored, pending: sample.pending, prices: sample.items.map(i => i.price) };
  });
  assert.deepEqual(result.ids, ["m100", "2JWXY4bD3f97JZ5u7U68aR", "m103", "m104", "m105"]);
  assert.equal(result.ignored, 2);
  assert.deepEqual(result.pending, [8]);
  assert.equal(result.prices[1], "¥1,200");
  console.log("DOM collector integration passed: ordinary + Shops, advertisements, duplicates, placeholders, scope.");
  // Render the real dashboard with a local extension-API stub and demo state.
  await page.route("https://watch.test/**", async route => {
    const name = new URL(route.request().url()).pathname.slice(1) || "dashboard.html";
    if (!/^[a-z.-]+$/.test(name)) return route.abort();
    const body = await readFile(resolve(root, "extension", name));
    await route.fulfill({ body, contentType: name.endsWith("css") ? "text/css" : name.endsWith("js") ? "application/javascript" : "text/html" });
  });
  await page.addInitScript(() => {
    const empty = keyword => ({ keyword, top: [], lastWindow: [], events: [], pending: [], run: null, initialized: false, lastError: "", failures: 0 });
    const demo = {
      settings: { desktop: true, wechat: "none", hasToken: false },
      recipients: [{ id: "owner", name: "我的微信", enabled: true, isDefault: true, contextReady: true, pending: 0, accepted: 3 },
        { id: "recipient-bob", name: "朋友甲", enabled: true, contextReady: true, pending: 0, accepted: 1 }],
      monitors: [ { id: "watch-a", keyword: "潔世一", scanCount: 5, intervalMinutes: 1, enabled: true },
        { id: "watch-b", keyword: "凪誠士郎", scanCount: 20, intervalMinutes: 5, enabled: true } ],
      states: { "watch-a": empty("潔世一"), "watch-b": empty("凪誠士郎") }
    };
    demo.states["watch-a"].lastWindow = ["item:m123"];
    window.__demo = demo; window.__requests = []; window.__controller = { mode: "local", localSuspended: false };
    window.__bridge = { connected: true, contextReady: true, verified: true, pending: 0, delivered: 1 };
    window.chrome = { permissions: { request: async () => true }, runtime: { sendMessage: async message => {
      window.__requests.push(message);
      if (message.type === "controller-status") return window.__controller;
      if (message.type === "connect-remote") {
        window.__controller = { mode: "remote", baseUrl: message.baseUrl, hasToken: true, localSuspended: true };
        demo.monitors = [{ id: "remote-a", keyword: "潔世一", blockedWords: ["全巻"], scanCount: 5, intervalMinutes: 3, recipientIds: ["remote-user"], enabled: true }];
        demo.states = { "remote-a": empty("潔世一") }; demo.settings = { desktop: false, wechat: "clawbot", hasToken: true };
        demo.recipients = [{ id: "remote-user", name: "服务器用户", enabled: true, contextReady: true, pending: 0, accepted: 2 }];
        return { ok: true };
      }
      if (message.type === "pause-all" || message.type === "start-all") { demo.monitors.forEach(item => item.enabled = message.type === "start-all"); return { ok: true }; }
      if (message.type === "qr-start") { window.__qr = { id: "qr-test", status: "wait", qrUrl: "https://liteapp.weixin.qq.com/q/only-local-test", message: "请使用接收人的微信扫码", expiresAt: Date.now() + 180000 }; return window.__qr; }
      if (message.type === "qr-status") return window.__qr;
      if (message.type === "qr-cancel") { window.__qr.status = "cancelled"; window.__qr.message = "扫码已取消"; return window.__qr; }
      if (message.type === "qr-verify") { window.__qr.status = "connected"; window.__qr.message = "绑定完成"; return window.__qr; }
      if (message.type === "status") {
        const selected = demo.monitors.find(item => item.id === message.monitorId) || demo.monitors[0];
        return structuredClone({ version: "2.0.0", executionMode: window.__controller.mode, controller: window.__controller, recipients: demo.recipients, settings: demo.settings, monitors: demo.monitors, selectedId: selected?.id || null,
          state: selected ? demo.states[selected.id] : null,
          bridge: demo.settings.wechat === "clawbot" ? window.__bridge : null });
      }
      if (message.type === "save-monitor") {
        const monitor = { ...message.monitor, id: message.monitor.id || "watch-new" };
        if (message.monitor.id) demo.monitors = demo.monitors.map(item => item.id === monitor.id ? monitor : item);
        else { demo.monitors.push(monitor); demo.states[monitor.id] = empty(monitor.keyword); }
        return { ok: true, monitorId: monitor.id };
      }
      if (message.type === "toggle") demo.monitors.find(item => item.id === message.monitorId).enabled = !demo.monitors.find(item => item.id === message.monitorId).enabled;
      if (message.type === "delete-monitor") { demo.monitors = demo.monitors.filter(item => item.id !== message.monitorId); delete demo.states[message.monitorId]; }
      if (message.type === "save-settings") demo.settings = { desktop: message.settings.desktop, wechat: message.settings.wechat, hasToken: Boolean(message.settings.token || demo.settings.hasToken) };
      if (message.type === "retry-wechat") return { ok: true, pending: window.__bridge.pending };
      if (message.type === "sync-recipients") return { ok: true, recipients: demo.recipients, imported: 0 };
      if (message.type === "save-recipient") { Object.assign(demo.recipients.find(row => row.id === message.recipient.id), message.recipient); return { ok: true }; }
      if (message.type === "delete-recipient") {
        demo.recipients = demo.recipients.filter(row => row.id !== message.recipient.id);
        for (const monitor of demo.monitors) monitor.recipientIds = (monitor.recipientIds || ["owner"]).filter(id => id !== message.recipient.id);
        return { ok: true, deletedId: message.recipient.id, noticeState: message.recipient.notifyBeforeDelete ? "accepted" : "not-requested" };
      }
      return { ok: true };
    } } };
  });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("https://watch.test/dashboard.html");
  await page.getByRole("heading", { name: "有上新，再提醒你。" }).waitFor();
  await page.locator(".watch-row").first().waitFor();
  assert.equal(await page.locator(".watch-row").count(), 2);
  assert.equal(await page.locator("#interval-minutes").inputValue(), "1");
  await page.locator("#new-monitor").click();
  await page.locator("#keyword").fill("蜂楽廻");
  await page.locator("#interval-minutes").fill("3");
  await page.locator("#scan-count").selectOption("5");
  assert.equal(await page.locator("#dedupe-shops").count(), 0);
  await page.locator("#save-monitor").click();
  await page.waitForFunction(() => document.querySelectorAll(".watch-row").length === 3);
  assert.equal(await page.locator("#watch-label").innerText(), "蜂楽廻 · 每 3 分钟检查");
  await page.locator("#interval-minutes").fill("10");
  await page.locator("#save-monitor").click();
  await page.waitForFunction(() => document.querySelector("#watch-label").textContent.includes("10 分钟"));
  assert.equal(await page.evaluate(() => Object.hasOwn(window.__demo.monitors.find(item => item.keyword === "蜂楽廻"), "dedupeSimilarShops")), false);
  await page.locator(".watch-select").filter({ hasText: "潔世一" }).click();
  assert.equal(await page.locator("#keyword").inputValue(), "潔世一");
  assert.equal(await page.locator("#interval-minutes").inputValue(), "1");
  await page.getByRole("button", { name: "暂停 潔世一", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#toggle").textContent === "开始此关键词");
  assert.equal(await page.locator("#monitor-enabled").isChecked(), false);
  assert.equal(await page.evaluate(() => window.__demo.monitors.find(item => item.keyword === "凪誠士郎").enabled), true);
  assert.deepEqual(await page.evaluate(() => window.__demo.states["watch-a"].lastWindow), ["item:m123"]);
  await page.locator("#wechat").selectOption("clawbot");
  await page.locator("#token").fill("a".repeat(64));
  await page.locator("#settings-form button[type=submit]").click();
  await page.waitForFunction(() => document.querySelector("#clawbot-status").textContent.includes("最近发送请求已被微信接受"));
  assert.equal(await page.evaluate(() => window.__requests.filter(item => item.type === "save-monitor").length), 2);
  assert.equal(await page.locator("#token").inputValue(), "");
  await page.locator("#recipient-management summary").click();
  await page.locator("#sync-recipients").click();
  await page.getByRole("textbox", { name: "接收人备注 朋友甲", exact: true }).fill("朋友乙");
  await page.waitForTimeout(3200);
  assert.equal(await page.getByRole("textbox", { name: "接收人备注 朋友甲", exact: true }).inputValue(), "朋友乙");
  await page.getByRole("button", { name: "保存用户 朋友甲", exact: true }).click();
  await page.waitForFunction(() => window.__demo.recipients.some(row => row.name === "朋友乙"));
  await page.getByRole("checkbox", { name: "接收人 我的微信", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "接收人 朋友乙", exact: true }).check();
  await page.locator("#monitor-form button[type=submit]").click();
  await page.waitForFunction(() => window.__demo.monitors.find(item => item.id === "watch-a").recipientIds?.includes("recipient-bob"));
  assert.deepEqual(await page.evaluate(() => window.__demo.monitors.find(item => item.id === "watch-a").recipientIds), ["recipient-bob"]);
  await page.getByRole("checkbox", { name: "允许接收 朋友乙", exact: true }).uncheck();
  await page.getByRole("button", { name: "保存用户 朋友乙", exact: true }).click();
  await page.waitForFunction(() => window.__demo.recipients.find(row => row.id === "recipient-bob").enabled === false);
  await page.evaluate(() => { window.__bridge = { connected: true, contextReady: false, hasContext: true, needsInteraction: true,
    pending: 6, delivered: 8, error: "微信拒绝发送（-2），请给 ClawBot 发一条新消息后重试" }; });
  await page.waitForFunction(() => !document.querySelector("#delivery-warning").hidden);
  assert.ok((await page.locator("#delivery-warning").innerText()).includes("6 批消息"));
  assert.ok((await page.locator("#clawbot-status").innerText()).includes("微信发送受限"));
  await page.locator("#retry-wechat").click();
  await page.waitForFunction(() => window.__requests.some(item => item.type === "retry-wechat"));
  await page.evaluate(() => {
    Object.assign(window.__demo.recipients.find(row => row.id === "recipient-bob"), { enabled: true, needsLogin: true, pending: 3, contextReady: false });
    window.__bridge = { connected: true, multiRecipient: true, contextReady: true, needsLogin: true, pending: 3, delivered: 8,
      error: "1 位接收人待恢复：微信登录已失效" };
  });
  await page.waitForFunction(() => document.querySelector("#delivery-warning").textContent.includes("其他接收人仍独立发送"));
  assert.ok((await page.locator("#delivery-warning").innerText()).includes("朋友乙"));
  assert.ok((await page.locator("#clawbot-status").innerText()).includes("1/2 位接收人会话可用"));
  await mkdir(resolve(root, "artifacts"), { recursive: true });
  await page.screenshot({ path: resolve(root, "artifacts/dashboard.png"), fullPage: true });
  await page.setViewportSize({ width: 420, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(root, "artifacts/dashboard-mobile.png"), fullPage: true });
  assert.equal(await page.getByRole("checkbox", { name: "删除前通知 朋友乙", exact: true }).isChecked(), false);
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "删除用户 朋友乙", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__demo.recipients.length), 2);
  await page.evaluate(() => { window.__demo.recipients.find(row => row.id === "recipient-bob").needsLogin = true; });
  await page.waitForFunction(() => document.querySelector('input[aria-label="删除前通知 朋友乙"]')?.disabled);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "删除用户 朋友乙", exact: true }).click();
  await page.waitForFunction(() => window.__demo.recipients.length === 1);
  assert.equal(await page.evaluate(() => window.__requests.find(item => item.type === "delete-recipient").recipient.notifyBeforeDelete), false);
  assert.deepEqual(await page.evaluate(() => window.__demo.monitors.find(item => item.id === "watch-a").recipientIds), []);
  assert.equal(await page.getByRole("checkbox", { name: "接收人 我的微信", exact: true }).isChecked(), false, "removing Bob never silently routes the task to owner");
  await page.locator(".watch-select").filter({ hasText: "蜂楽廻" }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#delete-monitor").click();
  await page.waitForFunction(() => document.querySelectorAll(".watch-row").length === 2);
  assert.equal(await page.evaluate(() => window.__demo.monitors.find(item => item.keyword === "凪誠士郎").intervalMinutes), 5);
  await page.getByRole("checkbox", { name: "删除前通知 我的微信", exact: true }).check();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "删除用户 我的微信", exact: true }).click();
  await page.waitForFunction(() => window.__demo.recipients.length === 0);
  assert.equal(await page.evaluate(() => window.__requests.filter(item => item.type === "delete-recipient").at(-1).recipient.notifyBeforeDelete), true);
  await page.locator("#new-monitor").click();
  assert.equal(await page.locator("#monitor-recipients input").count(), 0);
  assert.ok((await page.locator("#monitor-recipients").innerText()).includes("尚无接收人"));
  await page.setViewportSize({ width: 1240, height: 1000 });
  await page.locator("#execution-mode").selectOption("remote");
  await page.locator("#server-url").fill("https://server.example.com");
  await page.locator("#server-token").fill("b".repeat(64));
  await page.locator("#connect-server").click();
  await page.waitForFunction(() => document.querySelector("#execution-label").textContent.includes("远端采集"));
  assert.equal(await page.locator("#server-token").inputValue(), "");
  assert.equal(await page.locator("#local-notification-fields").isHidden(), true);
  assert.equal(await page.locator("#blocked-words").inputValue(), "全巻");
  await page.locator("#blocked-words").fill("全巻\nNovel");
  await page.locator("#save-monitor").click();
  assert.deepEqual(await page.evaluate(() => window.__requests.filter(row => row.type === "save-monitor").at(-1).monitor.blockedWords), ["全巻", "Novel"]);
  await page.locator("#pause-all").click();
  await page.waitForFunction(() => window.__demo.monitors.every(row => !row.enabled));
  assert.ok((await page.locator("#feedback").innerText()).includes("不再发起 Mercari"));
  await page.locator("#start-all").click();
  await page.waitForFunction(() => window.__demo.monitors.every(row => row.enabled));
  await page.locator("#add-recipient").click();
  await page.waitForFunction(() => document.querySelector("#qr-image").src.startsWith("data:image/png"));
  assert.equal(await page.locator("#qr-image").isVisible(), true);
  await page.screenshot({ path: resolve(root, "artifacts/dashboard-remote.png"), fullPage: true });
  await page.evaluate(() => { window.__qr.status = "need_verifycode"; window.__qr.message = "请填写手机显示的验证码"; });
  await page.locator("#qr-verify-form").waitFor({ state: "visible" });
  await page.locator("#qr-code-input").fill("123456");
  await page.locator("#qr-verify-form button").click();
  await page.waitForFunction(() => window.__requests.some(row => row.type === "qr-verify" && row.code === "123456"));
  await page.waitForFunction(() => document.querySelector("#qr-status").textContent === "绑定完成");
  assert.equal(await page.locator("#qr-image").getAttribute("src"), null);
  await page.setViewportSize({ width: 420, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(root, "artifacts/dashboard-remote-mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log("Admin UI passed: local controls; remote connection, blocked words, global pause/start, locally rendered QR, verification code, mobile layout.");
  console.log("Screenshots: artifacts/dashboard.png, artifacts/dashboard-mobile.png");
} finally { await browser.close(); }
