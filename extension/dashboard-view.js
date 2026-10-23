import { remotePermission, qrPresentation } from "./remote.js";
import QRCode from "./qr-code.js";
const $ = id => document.getElementById(id);
let executionMode = "local";
let controller = { mode: "local" };
let connectionLoaded = false;
let qrSession = null;
let qrPolling = false;
let settings = null;
let monitors = [];
let recipients = [];
let recipientsKnown = false;
let recipientChoiceKey = null;
let recipientChoiceStamp = "";
const recipientDrafts = new Map();
let selectedId = localStorage.getItem("mercari-selected-monitor") || null;
let selected = null;
let editingNew = false;
let editorLoadedKey = null;
let notificationsLoaded = false;
let busy = false;
let collectionSchedule = null;
let scheduleStatus = null;
let scheduleLoadedKey = null;
let scheduleSavedStamp = "";
let scheduleDirty = false;
let scheduleSupported = false;
const formatTime = value => value == null ? "尚无成功记录" : new Date(value).toLocaleString("zh-CN", { hour12: false });
const shortTime = value => new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
const schedulePaused = () => executionMode === "remote" && collectionSchedule?.enabled && scheduleStatus?.allowed === false;
const scheduleTime = value => new Date(value).toLocaleString("zh-CN", { timeZone: collectionSchedule?.timeZone || "Asia/Shanghai", hour12: false });
const scheduleZoneName = () => collectionSchedule?.timeZone === "Asia/Tokyo" ? "日本时间" : "北京时间";
function feedback(text, error = false) { $("feedback").textContent = text; $("feedback").className = error ? "error" : ""; }
async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (result?.error) throw new Error(result.error);
  return result;
}
function resetSchedule() {
  collectionSchedule = null; scheduleStatus = null; scheduleLoadedKey = null; scheduleSavedStamp = ""; scheduleDirty = false; scheduleSupported = false;
  $("collection-schedule").hidden = true;
}
function scheduleControls() {
  const enabled = $("schedule-enabled").checked;
  $("schedule-timezone").disabled = !enabled;
  const rows = [...$("schedule-windows").children];
  for (const row of rows) {
    for (const input of row.querySelectorAll("input")) input.disabled = !enabled;
    row.querySelector("button").disabled = !enabled || rows.length <= 1;
  }
  $("add-schedule-window").disabled = !enabled || rows.length >= 8;
  $("schedule-draft").hidden = !scheduleDirty;
}
function scheduleChanged() { scheduleDirty = true; scheduleControls(); }
function scheduleDraft() {
  return { enabled: $("schedule-enabled").checked, timeZone: $("schedule-timezone").value,
    windows: [...$("schedule-windows").children].map(row => ({ start: row.querySelector('[data-boundary="start"]').value, end: row.querySelector('[data-boundary="end"]').value })) };
}
function addScheduleWindow(window = { start: "09:00", end: "23:00" }) {
  const index = $("schedule-windows").children.length;
  const row = document.createElement("div"); row.className = "schedule-window";
  for (const [key, caption] of [["start", "开始时间"], ["end", "结束时间"]]) {
    const label = document.createElement("label"); label.textContent = caption;
    const input = document.createElement("input"); input.type = "time"; input.step = "60"; input.required = true; input.value = window[key]; input.dataset.boundary = key;
    input.setAttribute("aria-label", `时段 ${index + 1} ${caption}`);
    input.addEventListener("input", () => { input.setCustomValidity(""); scheduleChanged(); });
    label.append(input); row.append(label);
  }
  const remove = document.createElement("button"); remove.type = "button"; remove.className = "secondary danger"; remove.textContent = "删除时段"; remove.setAttribute("aria-label", `删除时段 ${index + 1}`);
  remove.addEventListener("click", () => { row.remove(); renumberScheduleWindows(); scheduleChanged(); });
  row.append(remove); $("schedule-windows").append(row);
}
function renumberScheduleWindows() {
  [...$("schedule-windows").children].forEach((row, index) => {
    row.querySelector('[data-boundary="start"]').setAttribute("aria-label", `时段 ${index + 1} 开始时间`);
    row.querySelector('[data-boundary="end"]').setAttribute("aria-label", `时段 ${index + 1} 结束时间`);
    row.querySelector("button").setAttribute("aria-label", `删除时段 ${index + 1}`);
  });
}
function renderSchedule(result) {
  const remote = executionMode === "remote";
  if (!remote) { resetSchedule(); return; }
  const key = `${executionMode}:${controller.baseUrl || ""}`;
  if (scheduleLoadedKey !== key) {
    resetSchedule(); scheduleLoadedKey = key;
  }
  $("collection-schedule").hidden = false;
  const saved = result.collectionSchedule;
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  scheduleSupported = Boolean(saved && typeof saved.enabled === "boolean" && ["Asia/Shanghai", "Asia/Tokyo"].includes(saved.timeZone) && Array.isArray(saved.windows) && saved.windows.length >= 1 && saved.windows.length <= 8 && saved.windows.every(row => row && timePattern.test(row.start) && timePattern.test(row.end) && row.start !== row.end) && typeof result.scheduleStatus?.allowed === "boolean");
  $("schedule-fields").disabled = !scheduleSupported;
  $("schedule-form").hidden = !scheduleSupported;
  $("schedule-unavailable").hidden = scheduleSupported;
  $("schedule-unavailable").textContent = scheduleSupported ? "" : "当前服务器尚不支持采集时段，请更新服务器代码并重启 mercari-watch 后再设置。";
  if (!scheduleSupported) {
    collectionSchedule = null; scheduleStatus = null;
    $("schedule-status").textContent = "需要更新服务器"; $("schedule-status").className = "pill";
    return;
  }
  const stamp = JSON.stringify(saved);
  if (!scheduleDirty && stamp !== scheduleSavedStamp) {
    $("schedule-enabled").checked = saved.enabled; $("schedule-timezone").value = saved.timeZone;
    $("schedule-windows").replaceChildren(); saved.windows.forEach(addScheduleWindow);
  }
  scheduleSavedStamp = stamp; collectionSchedule = saved; scheduleStatus = result.scheduleStatus;
  scheduleControls();
  const summary = !saved.enabled ? "全天按间隔采集" : scheduleStatus.allowed ? "当前在采集时段" : "当前在休息时段";
  if ($("schedule-status").textContent !== summary) $("schedule-status").textContent = summary;
  $("schedule-status").className = `pill${saved.enabled && scheduleStatus.allowed ? " running" : ""}`;
  const next = Number.isFinite(scheduleStatus.nextChangeAt) ? `${scheduleTime(scheduleStatus.nextChangeAt)}（${scheduleZoneName()}）` : "";
  $("schedule-next").textContent = !saved.enabled ? "未限制采集时间，已启用的关键词全天按各自间隔检查。" : scheduleStatus.allowed ? next ? `本时段结束：${next}。到时暂停 Mercari 采集。` : "当前时段允许采集，关键词按各自间隔检查。" : next ? `下次开启：${next}。到时仅恢复已启用的关键词。` : "当前暂停 Mercari 采集，等待下一个已保存时段。";
}
function providerFields() {
  const provider = $("wechat").value;
  const clawbot = provider === "clawbot";
  $("token-box").hidden = provider === "none";
  $("token-label").textContent = clawbot ? "本机连接密钥" : provider === "serverchan" ? "SendKey（SCT 开头）" : "PushPlus token";
  $("provider-link").href = clawbot ? "http://127.0.0.1:17869/setup" : provider === "serverchan" ? "https://sct.ftqq.com/docs/getting-started/sendkey/" : "https://www.pushplus.plus/";
  $("provider-link").textContent = clawbot ? "打开本机 ClawBot 连接页面 ↗" : "获取个人推送密钥 ↗";
  $("provider-hint").textContent = clawbot ? "从本机连接页面复制密钥；微信登录凭证留在 OpenClaw 中。已保存时留空保留。电脑和转发服务需要保持运行。" : "已存密钥时留空保留。切换渠道需要新密钥，商品信息会发往所选服务。";
  $("token").placeholder = settings?.hasToken && settings.wechat === provider ? "已保存；留空保持原密钥" : "粘贴连接密钥，仅保存在本机";
}
function itemNode(item, index) {
  const row = document.createElement("div"); row.className = "item";
  const rank = document.createElement("span"); rank.className = "rank"; rank.textContent = String(index + 1).padStart(2, "0");
  const content = document.createElement("div"); content.className = "item-content";
  const link = document.createElement("a"); link.href = item.url; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = item.title;
  const meta = document.createElement("div"); meta.className = "meta";
  const price = document.createElement("span"); price.className = "price"; price.textContent = item.price;
  const id = document.createElement("code"); id.textContent = `${item.type === "product" ? "Shop · " : ""}${item.id}`;
  meta.append(price, id); content.append(link, meta); row.append(rank, content); return row;
}
function renderMonitors() {
  $("monitor-list").replaceChildren();
  $("monitor-count").textContent = `${monitors.length} / 20 个`;
  if (!monitors.length) { $("monitor-list").textContent = "添加第一个关键词，为它设置检查间隔。"; return; }
  for (const monitor of monitors) {
    const row = document.createElement("div"); row.className = `watch-row${monitor.id === selectedId ? " selected" : ""}`;
    const choose = document.createElement("button"); choose.type = "button"; choose.className = "watch-select";
    choose.setAttribute("aria-pressed", String(monitor.id === selectedId));
    const name = document.createElement("strong"); name.textContent = monitor.keyword;
    const detail = document.createElement("span"); detail.className = "watch-detail";
    const status = !monitor.enabled ? "已暂停" : schedulePaused() ? `休息时段${monitor.nextCheckAt ? ` · 下次 ${scheduleTime(monitor.nextCheckAt)}（${scheduleZoneName()}）` : ""}` : monitor.running ? "正在检查" : monitor.nextCheckAt && monitor.nextCheckAt > Date.now() ? `下次 ${shortTime(monitor.nextCheckAt)}` : "等待检查";
    const names = (monitor.recipientIds || ["owner"]).map(id => recipients.find(row => row.id === id)?.name || (id === "owner" ? "我的微信" : "未加载用户"));
    detail.textContent = `每 ${monitor.intervalMinutes} 分钟 · ${status}${monitor.lastError ? ` · 连续异常 ${monitor.failures} 次` : ""}${settings.wechat === "clawbot" ? ` · 接收：${names.join("、") || "不发微信"}` : ""}`;
    choose.append(name, detail);
    choose.addEventListener("click", () => action(async () => {
      selectedId = monitor.id; localStorage.setItem("mercari-selected-monitor", selectedId);
      editingNew = false; editorLoadedKey = null;
    }));
    const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "secondary watch-toggle";
    toggle.textContent = monitor.enabled ? "暂停" : "开始";
    toggle.setAttribute("aria-label", `${toggle.textContent} ${monitor.keyword}`);
    toggle.addEventListener("click", () => action(async () => {
      await request({ type: "toggle", monitorId: monitor.id });
      if (selectedId === monitor.id && !editingNew) editorLoadedKey = null;
      feedback(`“${monitor.keyword}”的监控状态已更新。`);
    }));
    row.append(choose, toggle); $("monitor-list").append(row);
  }
}
function renderEditor() {
  const isNew = editingNew || !selected;
  const key = isNew ? "new" : selected.id;
  if (editorLoadedKey === key) return;
  editorLoadedKey = key;
  $("editor-title").textContent = isNew ? "添加关键词" : "当前关键词设置";
  $("keyword").value = isNew ? "" : selected.keyword;
  $("blocked-words").value = isNew ? "" : (selected.blockedWords || []).join("\n");
  $("interval-minutes").value = isNew ? 1 : selected.intervalMinutes;
  $("scan-count").value = isNew ? 20 : selected.scanCount;
  $("monitor-enabled").checked = isNew ? true : selected.enabled;
  $("save-monitor").textContent = isNew ? "添加并保存" : "保存此关键词";
  $("delete-monitor").hidden = isNew;
  $("cancel-new").hidden = !isNew || !selected;
  renderRecipientChoices();
}
function renderRecipientChoices() {
  $("recipient-fields").hidden = settings?.wechat !== "clawbot";
  const key = editingNew || !selected ? "new" : selected.id;
  const previousKey = recipientChoiceKey;
  const initial = recipientsKnown ? (recipients.find(row => row.isDefault) || recipients[0])?.id : "owner";
  const checked = recipientChoiceKey === key ? [...$("monitor-recipients").querySelectorAll("input:checked")].map(input => input.value) : (editingNew || !selected ? initial ? [initial] : [] : selected.recipientIds || ["owner"]);
  recipientChoiceKey = key;
  const rows = recipients.length || recipientsKnown ? [...recipients] : [{ id: "owner", name: "我的微信（默认）", enabled: true }];
  for (const id of checked) if (!rows.some(row => row.id === id)) rows.push({ id, name: "已选用户（待连接后加载）", enabled: true });
  const stamp = JSON.stringify(rows.map(row => [row.id, row.name, row.enabled]));
  if (previousKey === key && recipientChoiceStamp === stamp) return;
  recipientChoiceStamp = stamp;
  $("monitor-recipients").replaceChildren();
  if (!rows.length) $("monitor-recipients").textContent = "尚无接收人，请先扫码绑定并同步用户。";
  for (const row of rows) {
    const label = document.createElement("label"); label.className = "checkbox";
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.value = row.id; checkbox.checked = checked.includes(row.id);
    checkbox.setAttribute("aria-label", `接收人 ${row.name}`);
    label.append(checkbox, document.createTextNode(row.name + (row.enabled ? "" : "（已暂停接收）"))); $("monitor-recipients").append(label);
  }
}
function renderRecipients(error) {
  $("recipient-management").hidden = settings.wechat !== "clawbot";
  $("recipients-error").textContent = error || "每位用户独立保存会话和待发消息；暂停接收会保留待发队列。";
  if ($("recipient-list").contains(document.activeElement) && document.activeElement.tagName === "INPUT") { renderRecipientChoices(); return; }
  $("recipient-list").replaceChildren();
  for (const row of recipients) {
    const box = document.createElement("div"); box.className = "recipient-row";
    const name = document.createElement("input"); name.type = "text"; name.maxLength = 40; name.value = recipientDrafts.get(row.id)?.name ?? row.name;
    name.setAttribute("aria-label", `接收人备注 ${row.name}`);
    const enabledLabel = document.createElement("label"); enabledLabel.className = "checkbox";
    const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.checked = recipientDrafts.get(row.id)?.enabled ?? row.enabled;
    enabled.setAttribute("aria-label", `允许接收 ${row.name}`); enabledLabel.append(enabled, document.createTextNode("允许接收"));
    const notifyLabel = document.createElement("label"); notifyLabel.className = "checkbox removal-notice";
    const notify = document.createElement("input"); notify.type = "checkbox"; notify.disabled = Boolean(row.needsLogin);
    notify.checked = !notify.disabled && Boolean(recipientDrafts.get(row.id)?.notifyBeforeDelete);
    notify.setAttribute("aria-label", `删除前通知 ${row.name}`);
    notifyLabel.append(notify, document.createTextNode(row.needsLogin ? "登录已失效，删除时无法发送停用通知" : "删除前通知用户（可选；不能保证送达）"));
    const draft = () => recipientDrafts.set(row.id, { name: name.value, enabled: enabled.checked, notifyBeforeDelete: notify.checked });
    name.addEventListener("input", draft); enabled.addEventListener("change", draft);
    notify.addEventListener("change", draft);
    const status = document.createElement("p"); status.className = "muted";
    const condition = !row.enabled ? "已暂停接收" : row.needsLogin ? "请重新扫码" : row.quotaReached ? "次数已用尽，请回复激活" : row.needsInteraction ? "请在微信回复一条消息激活" : row.contextReady ? "会话可用" : "会话待验证";
    status.textContent = `${condition} · 待发 ${row.pending || 0} 批 · 接口已接收 ${row.accepted || 0} 批${row.error ? ` · ${row.error}` : ""}`;
    const save = document.createElement("button"); save.type = "button"; save.className = "secondary"; save.textContent = "保存用户";
    save.setAttribute("aria-label", `保存用户 ${row.name}`);
    save.addEventListener("click", () => action(async () => {
      await request({ type: "save-recipient", recipient: { id: row.id, name: name.value, enabled: enabled.checked } });
      recipientDrafts.delete(row.id); feedback("用户备注和接收开关已保存。关键词设置权限仍只属于管理员。");
    }));
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "secondary danger"; remove.textContent = "删除用户";
    remove.setAttribute("aria-label", `删除用户 ${row.name}`);
    remove.addEventListener("click", () => action(async () => {
      const notice = notify.checked ? "将尝试发送停用通知，会话失效或次数用尽时可能无法送达。" : "不会发送停用通知。";
      if (!confirm(`删除微信用户“${row.name}”？\n\n将停止${executionMode === "remote" ? "服务器" : "本机"}推送、移除相关任务接收人，并停止发送该用户的待发消息。已发送的消息无法撤回，其他用户不受影响。\n${notice}\n删除不保证清除微信客户端显示的绑定。`)) return;
      const result = await request({ type: "delete-recipient", recipient: { id: row.id, confirmName: row.name, notifyBeforeDelete: notify.checked } });
      recipientDrafts.delete(row.id); recipientChoiceKey = null; editorLoadedKey = null;
      const outcome = result.noticeState === "accepted" ? "停用通知已被微信接口接受，请以手机实际显示为准。" : result.noticeState === "failed" ? "停用通知未发送成功。" : result.noticeState === "not-requested" ? "未发送停用通知。" : "停用通知结果未确认，不会重复发送。";
      feedback(`已删除“${row.name}”，连接和推送已停止。${outcome}${result.cleanupWarning || ""}`, Boolean(result.cleanupWarning));
    }));
    const actions = document.createElement("div"); actions.className = "buttons recipient-actions"; actions.append(save, remove);
    box.append(name, enabledLabel, actions, status, notifyLabel); $("recipient-list").append(box);
  }
  renderRecipientChoices();
}
function renderState(state) {
  $("selected-controls").hidden = !selected;
  $("search-link").hidden = !selected;
  $("snapshot-title").textContent = selected ? `${selected.keyword} · 最新 5 件非推广商品` : "最新商品";
  $("events-title").textContent = selected ? `${selected.keyword} · 发现记录` : "发现记录";
  $("diagnostic").hidden = !selected || !state?.lastError;
  $("pending-box").hidden = !state?.pending.length;
  if (!selected || !state) {
    $("snapshot").className = "empty"; $("snapshot").textContent = "添加关键词并开始监控后，这里会显示商品。";
    $("history-count").textContent = ""; $("events").className = "empty"; $("events").textContent = "暂无记录。"; $("event-count").textContent = "0 次";
    return;
  }
  $("watch-label").textContent = `${selected.keyword} · 每 ${selected.intervalMinutes} 分钟检查`;
  $("toggle").textContent = selected.enabled ? "暂停此关键词" : "开始此关键词";
  $("check").disabled = !selected.enabled || Boolean(state.run) || schedulePaused();
  $("check").title = schedulePaused() ? "当前不在采集时段，暂不访问 Mercari" : "";
  $("search-link").href = `https://jp.mercari.com/search?${new URLSearchParams({ keyword: selected.keyword, order: "desc", sort: "created_time" })}`;
  $("search-link").hidden = false;
  $("activity").textContent = schedulePaused() && selected.enabled ? `当前不在采集时段，暂停访问 Mercari。上次成功：${formatTime(state.lastSuccess)}` : state.lastError || state.warning || `上次成功：${formatTime(state.lastSuccess)}${state.initialized ? "" : " · 首轮只建立基线"}`;
  $("diagnostic").textContent = state.lastError ? `${selected.keyword} · 连续异常 ${state.failures || 0} 次：${state.lastError}${state.failureAlerted ? "。异常提醒已生成。" : "。超过 5 次时会通过已配置渠道提醒。"}` : "";
  $("snapshot").replaceChildren();
  if (state.top.length) { $("snapshot").className = ""; state.top.forEach((item, i) => $("snapshot").append(itemNode(item, i))); }
  else { $("snapshot").className = "empty"; $("snapshot").textContent = "此关键词首轮采集完成后，这里会显示商品。"; }
  $("history-count").textContent = `每轮读取 ${selected.scanCount} 件 · 仅与上一轮结果比较 · 各关键词独立保存`;
  $("event-count").textContent = `${state.events.length} 次`;
  $("events").replaceChildren(); $("events").className = state.events.length ? "" : "empty";
  if (!state.events.length) $("events").textContent = "此关键词有新商品出现时，记录会保存在这里。";
  for (const event of state.events.slice(0, 15)) {
    const row = document.createElement("div"); row.className = "event";
    const time = document.createElement("time"); time.textContent = `${formatTime(event.time)} · ${event.items.length} 件${event.gap ? " · 与上一轮无重叠" : ""}`;
    const list = document.createElement("ul");
    for (const item of event.items) {
      const li = document.createElement("li"); const link = document.createElement("a");
      link.href = item.url; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = `${item.title} ${item.price}`;
      li.append(link); list.append(li);
    }
    row.append(time, list); $("events").append(row);
  }
  $("pending-text").textContent = `“${selected.keyword}”有 ${state.pending.length} 批消息等待发送。${state.pending.at(-1)?.lastError || ""}`;
}
async function refresh() {
  const result = await request({ type: "status", monitorId: selectedId });
  if (result.version !== "2.0.0" || !Array.isArray(result.monitors)) throw new Error("扩展后台仍是旧版，请在扩展管理页重新加载插件，再关闭旧面板重新打开。新版页眉应显示 v2.0.0。");
  executionMode = result.executionMode || "local"; controller = result.controller || { mode: executionMode };
  renderConnection();
  renderSchedule(result);
  $("server-state").hidden = executionMode !== "remote" || !result.server;
  if (result.server) $("server-state").textContent = result.server.storageError || `服务${result.server.running ? "运行中" : "已停止"} · 当前采集 ${result.server.activeRequests || 0} 项 · 已启用 ${result.monitors.filter(item => item.enabled).length} 项`;
  settings = result.settings; monitors = result.monitors;
  recipients = Array.isArray(result.recipients) ? result.recipients : [];
  recipientsKnown = settings.wechat === "clawbot" && !result.recipientsError && Array.isArray(result.recipients);
  selectedId = result.selectedId;
  selected = monitors.find(item => item.id === selectedId) || null;
  if (selectedId) localStorage.setItem("mercari-selected-monitor", selectedId); else localStorage.removeItem("mercari-selected-monitor");
  if (!notificationsLoaded) {
    $("desktop").checked = settings.desktop; $("wechat").value = settings.wechat;
    providerFields(); notificationsLoaded = true;
  }
  const enabled = monitors.filter(item => item.enabled).length;
  const failed = monitors.filter(item => item.enabled && item.lastError).length;
  $("status").textContent = failed ? `${failed} 项异常` : enabled ? `${enabled} 项监控中` : "已暂停";
  $("status").className = `pill ${failed ? "error" : enabled ? "running" : ""}`;
  if (schedulePaused() && enabled) { $("status").textContent = `${enabled} 项等待采集时段`; $("status").className = "pill"; }
  if (executionMode === "local" && controller.localSuspended) { $("status").textContent = "本机采集待启用"; $("status").className = "pill"; }
  renderMonitors(); renderEditor(); renderState(result.state);
  renderRecipients(result.recipientsError);
  $("clawbot-status").hidden = settings.wechat !== "clawbot";
  $("retry-wechat").hidden = settings.wechat !== "clawbot";
  const bridge = result.bridge;
  const deliveryError = bridge?.error || (bridge?.needsLogin ? "微信登录已失效，请重新扫码" : bridge?.quotaReached ? "本次微信会话推送次数已用尽，请回复“继续提醒”后自动补发" : bridge?.needsInteraction ? "请在手机微信给 ClawBot 发一条新消息，以刷新发送会话" : "");
  $("delivery-warning").hidden = settings.wechat !== "clawbot" || !deliveryError;
  const affected = bridge?.multiRecipient ? recipients.filter(row => row.enabled && row.pending > 0 && (row.needsLogin || row.needsInteraction || row.error)) : [];
  $("delivery-warning").textContent = affected.length ? `以下接收人需要处理：${affected.map(row => `“${row.name}”（${row.needsLogin ? "微信登录失效" : row.quotaReached ? "次数已用尽" : "会话或发送异常"}，待发 ${row.pending} 批）`).join("；")}。其他接收人仍独立发送，不会因此暂停。` : deliveryError ? `微信接收状态需要处理：${deliveryError}${bridge?.pending ? `。${bridge.pending} 批消息保存在${executionMode === "remote" ? "服务器" : "本机"}等待补发。` : ""}` : "";
  if (bridge) {
    const connection = bridge.multiRecipient && recipients.length ? `${recipients.filter(row => row.enabled && row.contextReady).length}/${recipients.filter(row => row.enabled).length} 位接收人会话可用，各自独立发送` : bridge.needsLogin ? "微信需要重新登录" : bridge.quotaReached ? "本次微信会话推送次数已用尽" : bridge.needsInteraction ? "微信发送受限，请发一条新消息" : bridge.verified ? "最近发送请求已被微信接受" : bridge.contextReady ? "已保存会话，当前投递待验证" : "尚未取得微信会话";
    $("clawbot-status").textContent = bridge.connected ? `${connection} · ${executionMode === "remote" ? "服务器" : "本机"}待发 ${bridge.pending} 批 · 微信接口已接收 ${bridge.delivered} 批` : bridge.error;
  }
}
function renderConnection() {
  const remote = executionMode === "remote";
  if (!connectionLoaded) {
    $("execution-mode").value = executionMode; $("server-url").value = controller.baseUrl || "";
    $("server-token").placeholder = controller.hasToken ? "已保存；留空保留原密钥" : "粘贴服务器生成的管理员密钥";
    connectionLoaded = true; connectionFields();
  }
  $("execution-label").textContent = remote ? "远端采集 · 本机不访问 Mercari" : "本机浏览器采集";
  $("connection-state").textContent = remote ? controller.baseUrl ? `已连接 ${controller.baseUrl}。断开此面板连接不会暂停服务器，请先使用“暂停全部采集”。` : "尚未连接服务器。本机采集保持暂停。" : controller.localSuspended ? "本机配置已保留，采集尚未恢复。确认远端已暂停后，点击“启用本机采集”。" : "本机模式：浏览器关闭后停止采集。";
  $("disconnect-server").hidden = !remote || !controller.baseUrl;
  $("activate-local").hidden = remote || !controller.localSuspended;
  $("local-notification-fields").hidden = remote; $("save-notification").hidden = remote;
  $("test-desktop").hidden = remote; $("add-recipient").hidden = !remote;
  $("notification-hint").textContent = remote ? "微信绑定和投递由服务器管理；本机只保存管理地址及管理员密钥。" : "共用本机转发连接；每条任务单独选择微信接收人，只有管理员可修改。";
  $("add-recipient-hint").textContent = remote ? "点击“扫码添加接收人”，让新用户用微信扫描二维码。服务器保存登录；绑定完成后请在任务中选择接收人。" : "先运行本机“添加微信接收人.cmd”，让新用户扫码，再点“同步已绑定用户”。新用户不会自动订阅已有任务。";
  $("runtime-hint").textContent = remote ? "服务器独立运行采集和推送，本机浏览器和电脑均可关闭。只有修改设置或查看状态时需要打开本面板。" : "浏览器保持运行，电脑保持唤醒。本机只操作扩展自己创建的采集标签。";
}
function connectionFields() { const remote = $("execution-mode").value === "remote"; $("remote-fields").hidden = !remote; $("connect-server").textContent = remote ? "连接服务器" : "切换到本机模式"; }
async function renderQr(session) {
  qrSession = session; $("qr-box").hidden = false;
  const view = qrPresentation(session);
  $("qr-status").textContent = view.message;
  $("qr-image").hidden = !view.showQr;
  if (!$("qr-image").hidden) $("qr-image").src = await QRCode.toDataURL(String(session.qrUrl), { width: 240, margin: 3, errorCorrectionLevel: "M" });
  else $("qr-image").removeAttribute("src");
  $("qr-verify-form").hidden = !view.verify;
  $("qr-cancel").hidden = !view.active;
}
async function action(fn) {
  if (busy) return;
  busy = true;
  try { await fn(); await refresh(); } catch (error) { feedback(error.message, true); }
  finally { busy = false; }
}
$("new-monitor").addEventListener("click", () => action(async () => { editingNew = true; editorLoadedKey = null; recipientChoiceKey = null; renderEditor(); $("keyword").focus(); }));
$("cancel-new").addEventListener("click", () => action(async () => { editingNew = false; editorLoadedKey = null; }));
$("monitor-form").addEventListener("submit", event => {
  event.preventDefault();
  action(async () => {
    const result = await request({ type: "save-monitor", monitor: { id: editingNew || !selected ? undefined : selected.id,
      keyword: $("keyword").value, intervalMinutes: Number($("interval-minutes").value), scanCount: Number($("scan-count").value), enabled: $("monitor-enabled").checked,
      blockedWords: $("blocked-words").value.split(/\r?\n/).map(word => word.trim()).filter(Boolean),
      recipientIds: [...$("monitor-recipients").querySelectorAll("input:checked")].map(input => input.value) } });
    selectedId = result.monitorId; editingNew = false; editorLoadedKey = null; recipientChoiceKey = null;
    feedback("关键词配置已保存。新增或更改关键词后，首轮只建立基线；调整间隔会保留上一轮结果。");
  });
});
$("delete-monitor").addEventListener("click", () => action(async () => {
  if (!selected || !confirm(`删除“${selected.keyword}”及其${executionMode === "remote" ? "服务器" : "本机"}历史记录？`)) return;
  await request({ type: "delete-monitor", monitorId: selectedId });
  selectedId = null; editorLoadedKey = null; editingNew = false; feedback("该关键词已删除，其他关键词保持不变。");
}));
$("wechat").addEventListener("change", providerFields);
$("settings-form").addEventListener("submit", event => {
  event.preventDefault();
  const provider = $("wechat").value;
  const origin = { clawbot: "http://127.0.0.1/*", serverchan: "https://sctapi.ftqq.com/*", pushplus: "https://www.pushplus.plus/*" }[provider];
  const permission = origin ? chrome.permissions.request({ origins: [origin] }) : Promise.resolve(true);
  action(async () => {
    if (!await permission) throw new Error("未允许微信服务访问，配置尚未保存");
    await request({ type: "save-settings", settings: { desktop: $("desktop").checked, wechat: provider, token: $("token").value } });
    $("token").value = ""; notificationsLoaded = false; feedback("通知设置已保存，所有关键词共用此微信连接。");
  });
});
$("toggle").addEventListener("click", () => action(async () => { await request({ type: "toggle", monitorId: selectedId }); editorLoadedKey = null; feedback("当前关键词的监控状态已更新。"); }));
$("check").addEventListener("click", () => action(async () => { await request({ type: "check", monitorId: selectedId }); feedback("已请求检查此关键词；繁忙时等待其他检查完成。"); }));
$("test-desktop").addEventListener("click", () => action(async () => { await request({ type: "test-notification", channel: "desktop", monitorId: selectedId }); feedback("已请求显示本机测试通知。"); }));
$("test-wechat").addEventListener("click", () => action(async () => { await request({ type: "test-notification", channel: settings.wechat, monitorId: selectedId }); feedback(settings.wechat === "clawbot" ? `${executionMode === "remote" ? "服务器" : "本机服务"}已保存测试消息，正在通过 ClawBot 发送；请在微信确认收到。` : "推送服务已接受测试消息，请在微信确认收到。"); }));
$("retry-wechat").addEventListener("click", () => action(async () => { const result = await request({ type: "retry-wechat" }); feedback(`已请求重试 ${result.pending} 批微信待发消息。若提示发送受限，请先在手机微信给 ClawBot 发一条新消息。`); }));
$("clear-pending").addEventListener("click", () => action(async () => { await request({ type: "clear-pending", monitorId: selectedId }); feedback("当前关键词的待发消息已清除，商品历史和其他关键词保留。"); }));
$("sync-recipients").addEventListener("click", () => action(async () => { const result = await request({ type: "sync-recipients" }); feedback(`已同步接收人，新增 ${result.imported || 0} 位。请为对应任务勾选接收人并保存，新用户不会自动收到已有任务。`); }));
$("execution-mode").addEventListener("change", connectionFields);
$("connection-form").addEventListener("submit", event => {
  event.preventDefault();
  const remote = $("execution-mode").value === "remote";
  let permission;
  try { permission = remote ? chrome.permissions.request({ origins: [remotePermission($("server-url").value)] }) : Promise.resolve(true); }
  catch (error) { feedback(error.message, true); return; }
  action(async () => {
    if (!await permission) throw new Error("未允许访问服务器，连接未保存");
    if (!remote && !confirm("切换到本机模式？远端任务会继续运行，切换不会自动暂停远端。本机配置会保留，采集需要另行启用。")) return;
    await request(remote ? { type: "connect-remote", baseUrl: $("server-url").value, token: $("server-token").value } : { type: "switch-local" });
    $("server-token").value = ""; connectionLoaded = false; notificationsLoaded = false; editorLoadedKey = null; recipientChoiceKey = null; selectedId = null; editingNew = false; qrSession = null; $("qr-box").hidden = true; resetSchedule();
    feedback(remote ? "已连接服务器，本机采集和本机待发重试已停止。原本机配置保留，未自动上传。" : "已切换本机模式，采集尚未恢复。");
  });
});
$("disconnect-server").addEventListener("click", () => action(async () => { if (!confirm("移除本机保存的服务器地址和管理密钥？服务器上的采集仍会继续，需暂停请先取消并使用“暂停全部采集”。")) return; await request({ type: "disconnect-remote" }); connectionLoaded = false; editorLoadedKey = null; selectedId = null; qrSession = null; $("qr-box").hidden = true; resetSchedule(); feedback("已移除本机连接；远端任务状态未变。本机不恢复采集。"); }));
$("activate-local").addEventListener("click", () => action(async () => { if (!confirm("确认远端监控已暂停？启用本机可能与仍运行的远端任务重复推送。")) return; await request({ type: "activate-local" }); feedback("本机采集已启用。"); }));
$("pause-all").addEventListener("click", () => action(async () => { await request({ type: "pause-all" }); editorLoadedKey = null; feedback("全部采集已暂停，不再发起 Mercari 采集请求。微信待发消息独立处理。"); }));
$("start-all").addEventListener("click", () => action(async () => { await request({ type: "start-all" }); editorLoadedKey = null; feedback(schedulePaused() ? "全部关键词已启用，将在下一个采集时段开始访问 Mercari。" : "全部关键词已开始采集。"); }));
$("schedule-enabled").addEventListener("change", scheduleChanged);
$("schedule-timezone").addEventListener("change", scheduleChanged);
$("add-schedule-window").addEventListener("click", () => {
  if ($("schedule-windows").children.length >= 8) return;
  addScheduleWindow(); scheduleChanged();
  $("schedule-windows").lastElementChild.querySelector("input").focus();
});
$("schedule-form").addEventListener("submit", event => {
  event.preventDefault();
  action(async () => {
    if (executionMode !== "remote" || !scheduleSupported) throw new Error("当前服务器尚不支持采集时段，请先更新服务器并重新连接。");
    const schedule = scheduleDraft();
    const { windows } = schedule;
    if (!windows.length || windows.length > 8) throw new Error("请设置 1–8 个采集时段。");
    for (const [index, window] of windows.entries()) {
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(window.start) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(window.end)) throw new Error(`请填写时段 ${index + 1} 的开始和结束时间。`);
      if (window.start === window.end) throw new Error(`时段 ${index + 1} 的开始和结束时间不能相同。需要全天采集时，请取消“启用每日采集时段”。`);
    }
    const submittedStamp = JSON.stringify(schedule);
    await request({ type: "save-collection-schedule", schedule });
    scheduleDirty = JSON.stringify(scheduleDraft()) !== submittedStamp;
    if (!scheduleDirty) scheduleSavedStamp = "";
    feedback(`${schedule.enabled ? "采集时段已保存并在服务器生效。时段外停止访问 Mercari，手动暂停的关键词保持暂停。" : "已取消采集时段限制，已启用的关键词全天按各自间隔采集。"}${scheduleDirty ? "你在保存期间编辑的内容仍待保存。" : ""}`);
  });
});
$("add-recipient").addEventListener("click", () => action(async () => { await renderQr(await request({ type: "qr-start" })); }));
$("qr-cancel").addEventListener("click", () => action(async () => { if (qrSession) await renderQr(await request({ type: "qr-cancel", id: qrSession.id })); }));
$("qr-verify-form").addEventListener("submit", event => { event.preventDefault(); action(async () => { if (qrSession) await renderQr(await request({ type: "qr-verify", id: qrSession.id, code: $("qr-code-input").value })); $("qr-code-input").value = ""; }); });
async function initialize() { controller = await request({ type: "controller-status" }) || controller; executionMode = controller.mode || "local"; renderConnection(); await refresh(); }
initialize().catch(error => feedback(error.message, true));
setInterval(() => { if (!busy) refresh().catch(error => feedback(error.message, true)); }, 3000);
setInterval(async () => {
  if (busy || qrPolling || executionMode !== "remote" || !qrSession || !qrPresentation(qrSession).active) return;
  qrPolling = true; try { const session = await request({ type: "qr-status", id: qrSession.id }); await renderQr(session); if (qrPresentation(session).connected) { recipientChoiceKey = null; await refresh(); } } catch (error) { $("qr-status").textContent = error.message; } finally { qrPolling = false; }
}, 2500);
