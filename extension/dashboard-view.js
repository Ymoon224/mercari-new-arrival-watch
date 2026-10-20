const $ = id => document.getElementById(id);
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
const formatTime = value => value == null ? "尚无成功记录" : new Date(value).toLocaleString("zh-CN", { hour12: false });
const shortTime = value => new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
function feedback(text, error = false) { $("feedback").textContent = text; $("feedback").className = error ? "error" : ""; }
async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (result?.error) throw new Error(result.error);
  return result;
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
    const status = !monitor.enabled ? "已暂停" : monitor.running ? "正在检查" : monitor.nextCheckAt && monitor.nextCheckAt > Date.now() ? `下次 ${shortTime(monitor.nextCheckAt)}` : "等待检查";
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
      recipientDrafts.delete(row.id); feedback("用户备注和接收开关已保存。关键词设置权限仍只在本机。");
    }));
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "secondary danger"; remove.textContent = "删除用户";
    remove.setAttribute("aria-label", `删除用户 ${row.name}`);
    remove.addEventListener("click", () => action(async () => {
      const notice = notify.checked ? "将尝试发送停用通知，会话失效或次数用尽时可能无法送达。" : "不会发送停用通知。";
      if (!confirm(`删除微信用户“${row.name}”？\n\n将停止本机推送、移除相关任务接收人，并停止发送该用户的待发消息。已发送的消息无法撤回，其他用户不受影响。\n${notice}\n本机删除不保证清除微信客户端显示的绑定。`)) return;
      const result = await request({ type: "delete-recipient", recipient: { id: row.id, confirmName: row.name, notifyBeforeDelete: notify.checked } });
      recipientDrafts.delete(row.id); recipientChoiceKey = null; editorLoadedKey = null;
      const outcome = result.noticeState === "accepted" ? "停用通知已被微信接口接受，请以手机实际显示为准。" : result.noticeState === "failed" ? "停用通知未发送成功。" : result.noticeState === "not-requested" ? "未发送停用通知。" : "停用通知结果未确认，不会重复发送。";
      feedback(`已删除“${row.name}”，本机连接和推送已停止。${outcome}${result.cleanupWarning || ""}`, Boolean(result.cleanupWarning));
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
  $("check").disabled = !selected.enabled || Boolean(state.run);
  $("search-link").href = `https://jp.mercari.com/search?${new URLSearchParams({ keyword: selected.keyword, order: "desc", sort: "created_time" })}`;
  $("search-link").hidden = false;
  $("activity").textContent = state.lastError || state.warning || `上次成功：${formatTime(state.lastSuccess)}${state.initialized ? "" : " · 首轮只建立基线"}`;
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
  if (result.version !== "1.3.2" || !Array.isArray(result.monitors)) throw new Error("扩展后台仍是旧版，请在扩展管理页重新加载插件，再关闭旧面板重新打开。新版页眉应显示 v1.3.2。");
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
  renderMonitors(); renderEditor(); renderState(result.state);
  renderRecipients(result.recipientsError);
  $("clawbot-status").hidden = settings.wechat !== "clawbot";
  $("retry-wechat").hidden = settings.wechat !== "clawbot";
  const bridge = result.bridge;
  const deliveryError = bridge?.error || (bridge?.needsLogin ? "微信登录已失效，请重新扫码" : bridge?.quotaReached ? "本次微信会话推送次数已用尽，请回复“继续提醒”后自动补发" : bridge?.needsInteraction ? "请在手机微信给 ClawBot 发一条新消息，以刷新发送会话" : "");
  $("delivery-warning").hidden = settings.wechat !== "clawbot" || !deliveryError;
  const affected = bridge?.multiRecipient ? recipients.filter(row => row.enabled && row.pending > 0 && (row.needsLogin || row.needsInteraction || row.error)) : [];
  $("delivery-warning").textContent = affected.length ? `以下接收人需要处理：${affected.map(row => `“${row.name}”（${row.needsLogin ? "微信登录失效" : row.quotaReached ? "次数已用尽" : "会话或发送异常"}，待发 ${row.pending} 批）`).join("；")}。其他接收人仍独立发送，不会因此暂停。` : deliveryError ? `微信接收状态需要处理：${deliveryError}${bridge?.pending ? `。${bridge.pending} 批消息保存在本机等待补发。` : ""}` : "";
  if (bridge) {
    const connection = bridge.multiRecipient && recipients.length ? `${recipients.filter(row => row.enabled && row.contextReady).length}/${recipients.filter(row => row.enabled).length} 位接收人会话可用，各自独立发送` : bridge.needsLogin ? "微信需要重新登录" : bridge.quotaReached ? "本次微信会话推送次数已用尽" : bridge.needsInteraction ? "微信发送受限，请发一条新消息" : bridge.verified ? "最近发送请求已被微信接受" : bridge.contextReady ? "已保存会话，当前投递待验证" : "尚未取得微信会话";
    $("clawbot-status").textContent = bridge.connected ? `${connection} · 本机待发 ${bridge.pending} 批 · 微信接口已接收 ${bridge.delivered} 批` : bridge.error;
  }
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
      recipientIds: [...$("monitor-recipients").querySelectorAll("input:checked")].map(input => input.value) } });
    selectedId = result.monitorId; editingNew = false; editorLoadedKey = null; recipientChoiceKey = null;
    feedback("关键词配置已保存。新增或更改关键词后，首轮只建立基线；调整间隔会保留上一轮结果。");
  });
});
$("delete-monitor").addEventListener("click", () => action(async () => {
  if (!selected || !confirm(`删除“${selected.keyword}”及其本机历史记录？`)) return;
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
$("test-wechat").addEventListener("click", () => action(async () => { await request({ type: "test-notification", channel: settings.wechat, monitorId: selectedId }); feedback(settings.wechat === "clawbot" ? "本机服务已保存测试消息，正在通过 ClawBot 发送；请在微信确认收到。" : "推送服务已接受测试消息，请在微信确认收到。"); }));
$("retry-wechat").addEventListener("click", () => action(async () => { const result = await request({ type: "retry-wechat" }); feedback(`已请求重试 ${result.pending} 批微信待发消息。若提示发送受限，请先在手机微信给 ClawBot 发一条新消息。`); }));
$("clear-pending").addEventListener("click", () => action(async () => { await request({ type: "clear-pending", monitorId: selectedId }); feedback("当前关键词的待发消息已清除，商品历史和其他关键词保留。"); }));
$("sync-recipients").addEventListener("click", () => action(async () => { const result = await request({ type: "sync-recipients" }); feedback(`已同步接收人，新增 ${result.imported || 0} 位。请为对应任务勾选接收人并保存，新用户不会自动收到已有任务。`); }));
refresh().catch(error => feedback(error.message, true));
setInterval(() => { if (!busy) refresh().catch(error => feedback(error.message, true)); }, 3000);
