import { sendChannel, origins, bridgeStatus, retryBridge, recipientAdmin } from "./notify.js";
import { migrate, validateMonitor, duplicateKeyword, notificationSettings, settingsFor, dueMonitors, removeRecipientReferences, ALARM, MAX_MONITORS } from "./watches.js";
const W = globalThis.MercariWatch;
let chain = Promise.resolve();
const enqueue = fn => { const task = chain.then(fn); chain = task.catch(() => {}); return task; };
async function save(db) { await chrome.storage.local.set(db); }
async function applyRemovedRecipients(db, ids) {
  const result = removeRecipientReferences(db, ids);
  if (result.changed) {
    await save(db); for (const run of result.runs) await closeOwned(run);
    await reconcile(db); await badge(db);
  }
}
async function read() {
  const saved = await chrome.storage.local.get(["schemaVersion", "settings", "monitors", "states", "state"]);
  const db = migrate(saved);
  const legacyDedup = saved.monitors?.some(item => Object.hasOwn(item, "dedupeSimilarShops")) ||
    Object.values(saved.states || {}).some(state => ["seen", "shopSeen", "suppressedSimilar"].some(key => Object.hasOwn(state, key)));
  if (saved.schemaVersion !== 2 || legacyDedup) {
    await save(db); // Preserve the last sample, pending messages and credentials.
    await chrome.storage.local.remove("state");
  }
  return db;
}
async function badge(db) {
  const states = Object.values(db.states);
  const failures = db.monitors.some(item => item.enabled && db.states[item.id].lastError);
  await chrome.action.setBadgeText({ text: failures ? "!" : states.some(item => item.run) ? "…" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: failures ? "#c14635" : "#167a68" });
}
async function closeOwned(run) {
  if (run?.tabId === undefined) return;
  const tab = await chrome.tabs.get(run.tabId).catch(() => null);
  try {
    const url = new URL(tab?.url);
    if (url.origin === "https://jp.mercari.com" && url.pathname === "/search" && url.hash === `#mercari-watch=${run.id}`) await chrome.tabs.remove(run.tabId);
  } catch {}
}
async function reconcile(db) {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await chrome.alarms.clear("mercari-check");
  const needed = db.monitors.some(item => item.enabled || db.states[item.id].pending.length);
  const alarm = await chrome.alarms.get(ALARM);
  if (needed && !alarm) await chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
  if (!needed && alarm) await chrome.alarms.clear(ALARM);
}
async function drain(db) {
  const queued = db.monitors.flatMap(monitor => db.states[monitor.id].pending.map(batch => ({ monitor, batch })))
    .sort((a, b) => (a.batch.lastTriedAt || 0) - (b.batch.lastTriedAt || 0) ||
      Number(b.batch.type === "monitor-error") - Number(a.batch.type === "monitor-error") || a.batch.time - b.batch.time).slice(0, 3);
  for (const { monitor, batch } of queued) {
    batch.attempts++; batch.lastTriedAt = Date.now();
    for (const channel of Object.keys(batch.channels)) {
      if (batch.channels[channel]) continue;
      try { await sendChannel(channel, batch, settingsFor(db, monitor)); batch.channels[channel] = true; batch.lastError = ""; }
      catch (error) { batch.lastError = error.message; }
      await save(db);
    }
    db.states[monitor.id].pending = db.states[monitor.id].pending.filter(item => !Object.values(item.channels).every(Boolean));
    await save(db);
  }
}
async function tick(forceIds = []) {
  const db = await read();
  const now = Date.now();
  for (const monitor of db.monitors) {
    const state = db.states[monitor.id];
    if (!state.run || now - state.run.startedAt < 90000) continue;
    const run = state.run;
    db.states[monitor.id] = W.recordFailure(state, "上一轮检查超时，旧基线已保留，将按该关键词的间隔重试", settingsFor(db, monitor), now);
    db.states[monitor.id].run = null;
    await save(db);
    await closeOwned(run);
  }
  for (const monitor of dueMonitors(db, now, forceIds)) {
    let state = db.states[monitor.id];
    state.lastAttempt = now;
    state.nextCheckAt = now + monitor.intervalMinutes * 60000;
    const id = crypto.randomUUID();
    try {
      const tab = await chrome.tabs.create({ url: `${W.searchUrl(monitor.keyword)}#mercari-watch=${id}`, active: false });
      state.run = { id, tabId: tab.id, startedAt: now };
    } catch (error) {
      state = W.recordFailure(state, `无法创建监控标签页：${error.message || "浏览器未能打开搜索页"}`, settingsFor(db, monitor), now);
      db.states[monitor.id] = state;
    }
    await save(db);
  }
  await drain(db);
  await reconcile(db);
  await badge(db);
}
function senderMonitor(db, sender) {
  const monitor = db.monitors.find(item => db.states[item.id].run?.tabId === sender.tab?.id);
  if (!monitor || sender.frameId !== 0) return null;
  try {
    const url = new URL(sender.url);
    return url.origin === "https://jp.mercari.com" && url.pathname === "/search" &&
      url.searchParams.get("keyword") === monitor.keyword && url.searchParams.get("sort") === "created_time" &&
      url.searchParams.get("order") === "desc" && url.hash === `#mercari-watch=${db.states[monitor.id].run.id}` ? monitor : null;
  } catch { return null; }
}
function selectedMonitor(db, id) {
  const monitor = db.monitors.find(item => item.id === id);
  if (!monitor) throw new Error("此关键词已不存在，请刷新面板");
  return monitor;
}
async function handle(message, sender) {
  const db = await read();
  if (["collector-ready", "sample", "sample-error"].includes(message.type)) {
    const monitor = senderMonitor(db, sender);
    if (message.type === "collector-ready") return monitor ? { run: { id: db.states[monitor.id].run.id, keyword: monitor.keyword, scanCount: monitor.scanCount } } : {};
    if (!monitor || db.states[monitor.id].run.id !== message.runId) return { ignored: true };
    const state = db.states[monitor.id];
    const run = state.run;
    let next;
    try {
      if (message.type === "sample-error") throw new Error(String(message.error || "页面采集失败").slice(0, 400));
      next = W.advance(state, message.items, settingsFor(db, monitor)).state;
    } catch (error) { next = W.recordFailure(state, error, settingsFor(db, monitor)); }
    next.run = null;
    // Avoid catch-up bursts after a delayed result or a sleeping computer.
    if ((next.nextCheckAt || 0) <= Date.now()) next.nextCheckAt = Date.now() + monitor.intervalMinutes * 60000;
    db.states[monitor.id] = next;
    await save(db);
    await closeOwned(run);
    await tick();
    return { ok: true };
  }
  if (!sender.url?.startsWith(chrome.runtime.getURL(""))) throw new Error("不允许来自网页的配置请求");
  if (message.type === "status") {
    const { token, ...safeSettings } = db.settings;
    const monitor = db.monitors.find(item => item.id === message.monitorId) || db.monitors[0];
    let recipients = []; let recipientsError = "";
    if (db.settings.wechat === "clawbot") {
      try {
        const result = await recipientAdmin(db.settings, "recipients"); recipients = result.recipients;
        await applyRemovedRecipients(db, result.deletedRecipientIds);
        if (result.cleanupWarnings?.length) recipientsError = `有 ${result.cleanupWarnings.length} 位已删除用户的本机登录清理待完成；推送已停止，请重启转发服务重试。`;
      }
      catch (error) { recipientsError = error.message; }
    }
    return { version: "1.3.2", recipients, recipientsError, settings: { ...safeSettings, hasToken: Boolean(token) }, selectedId: monitor?.id || null,
      monitors: db.monitors.map(item => { const state = db.states[item.id]; return { ...item,
        running: Boolean(state.run), lastSuccess: state.lastSuccess, lastError: state.lastError, failures: state.failures,
        nextCheckAt: state.nextCheckAt, pendingCount: state.pending.length }; }),
      state: monitor ? db.states[monitor.id] : null, bridge: db.settings.wechat === "clawbot" ? await bridgeStatus() : null };
  }
  if (message.type === "sync-recipients") return recipientAdmin(db.settings, "sync-recipients");
  if (message.type === "save-recipient") return recipientAdmin(db.settings, "save-recipient", message.recipient);
  if (message.type === "delete-recipient") {
    const result = await recipientAdmin(db.settings, "delete-recipient", message.recipient);
    await applyRemovedRecipients(db, result.deletedRecipientIds || [result.deletedId]);
    return result;
  }
  if (message.type === "retry-wechat") return retryBridge(db.settings);
  if (message.type === "save-settings") {
    if (message.settings.keyword != null || message.settings.scanCount != null) throw new Error("监控面板已更新，请关闭旧面板后重新打开");
    const next = notificationSettings(message.settings, db.settings);
    if (next.wechat !== "none" && !await chrome.permissions.contains({ origins: [origins[next.wechat]] })) throw new Error("请允许所选微信服务的访问权限");
    if (next.wechat !== db.settings.wechat && Object.values(db.states).some(state => state.pending.some(batch => Object.keys(batch.channels).some(channel => channel !== "desktop" && !batch.channels[channel])))) {
      throw new Error("还有未成功发送的微信消息，请先重试或清除相应关键词的待发消息，再切换渠道");
    }
    db.settings = next; await save(db); await tick(); return { ok: true };
  }
  if (message.type === "save-monitor") {
    const old = message.monitor.id ? selectedMonitor(db, message.monitor.id) : null;
    if (!old && db.monitors.length >= MAX_MONITORS) throw new Error(`最多添加 ${MAX_MONITORS} 个关键词`);
    const next = validateMonitor(message.monitor, old || {});
    if (duplicateKeyword(db.monitors, next)) throw new Error("这些接收人已有相同关键词，请修改原任务，或选择不同接收人");
    if (db.settings.wechat === "clawbot" && (old == null || JSON.stringify(old.recipientIds || ["owner"]) !== JSON.stringify(next.recipientIds))) {
      const available = (await recipientAdmin(db.settings, "recipients")).recipients;
      if (next.recipientIds.some(id => !available.some(row => row.id === id))) throw new Error("所选接收人已不存在，请同步用户后重新选择");
    }
    const previous = old ? db.states[old.id] : null;
    if (old && old.keyword !== next.keyword && previous.pending.length) throw new Error("该关键词仍有待发消息，请先重试或清除队列后再更改关键词");
    const state = !old || old.keyword !== next.keyword ? W.emptyState(next.keyword) : previous;
    const run = previous?.run;
    const interrupt = run && (!next.enabled || old.keyword !== next.keyword || old.scanCount !== next.scanCount);
    if (interrupt) state.run = null;
    if (!old || old.keyword !== next.keyword || old.scanCount !== next.scanCount || !old.enabled && next.enabled) state.nextCheckAt = Date.now();
    else if (old.intervalMinutes !== next.intervalMinutes) state.nextCheckAt = state.lastAttempt == null ? Date.now() : state.lastAttempt + next.intervalMinutes * 60000;
    if (old) db.monitors = db.monitors.map(item => item.id === old.id ? next : item); else db.monitors.push(next);
    db.states[next.id] = state;
    await save(db);
    if (interrupt) await closeOwned(run);
    await tick(); return { ok: true, monitorId: next.id };
  }
  if (message.type === "toggle" || message.type === "check") {
    const monitor = selectedMonitor(db, message.monitorId);
    const state = db.states[monitor.id];
    if (message.type === "check") {
      if (!monitor.enabled) throw new Error("请先开始此关键词的监控");
      if (!state.run) { state.nextCheckAt = Date.now(); await save(db); }
      await tick([monitor.id]); return { ok: true };
    }
    monitor.enabled = !monitor.enabled;
    const run = state.run;
    if (!monitor.enabled) state.run = null; else state.nextCheckAt = Date.now();
    await save(db);
    if (!monitor.enabled) await closeOwned(run);
    await tick(); return { ok: true };
  }
  if (message.type === "delete-monitor") {
    const monitor = selectedMonitor(db, message.monitorId);
    const state = db.states[monitor.id];
    if (state.pending.length) throw new Error("该关键词仍有待发消息，请先重试或清除队列再删除");
    db.monitors = db.monitors.filter(item => item.id !== monitor.id); delete db.states[monitor.id];
    await save(db); await closeOwned(state.run); await tick(); return { ok: true };
  }
  if (message.type === "clear-pending") {
    const monitor = selectedMonitor(db, message.monitorId);
    db.states[monitor.id].pending = []; await save(db); await reconcile(db); return { ok: true };
  }
  if (message.type === "test-notification") {
    const monitor = db.monitors.find(item => item.id === message.monitorId) || db.monitors[0];
    const keyword = monitor?.keyword || W.defaults.keyword;
    const event = { id: `test-${crypto.randomUUID()}`, recipientIds: monitor?.recipientIds || ["owner"], items: [{ title: "这是一条测试通知，不代表实际商品上新", price: "", url: W.searchUrl(keyword) }] };
    if (message.channel !== "desktop" && (message.channel !== db.settings.wechat || db.settings.wechat === "none")) throw new Error("请先保存推送配置");
    await sendChannel(message.channel, event, { ...db.settings, keyword }); return { ok: true };
  }
  throw new Error("未知操作");
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  enqueue(() => handle(message, sender)).then(respond, error => respond({ error: error.message })); return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM || alarm.name === "mercari-check") return enqueue(() => tick()).catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => enqueue(() => tick()));
chrome.runtime.onStartup.addListener(() => enqueue(async () => {
  const db = await read();
  const runs = Object.values(db.states).map(state => state.run).filter(Boolean);
  for (const state of Object.values(db.states)) state.run = null;
  await save(db);
  for (const run of runs) await closeOwned(run);
  await tick();
}));
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.notifications.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.tabs.onRemoved.addListener(tabId => enqueue(async () => {
  const db = await read();
  const monitor = db.monitors.find(item => db.states[item.id].run?.tabId === tabId);
  if (!monitor) return;
  const state = W.recordFailure(db.states[monitor.id], "监控标签页被关闭；将按该关键词的间隔重试，旧状态已保留", settingsFor(db, monitor));
  state.run = null; db.states[monitor.id] = state;
  await save(db); await tick();
}));
enqueue(() => tick()).catch(() => {});
