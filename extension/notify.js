export const origins = {
  clawbot: "http://127.0.0.1/*",
  serverchan: "https://sctapi.ftqq.com/*",
  pushplus: "https://www.pushplus.plus/*"
};
export function messageFor(event, keyword) {
  if (event.type === "monitor-error") {
    const formatTime = value => value == null ? "尚无成功记录" : new Date(value).toLocaleString("zh-CN", { hour12: false });
    const title = `${event.keyword || keyword}：监控连续异常 ${event.failures} 次`;
    const text = [`截至 ${formatTime(event.time)}，监控已连续失败 ${event.failures} 次，暂时无法确认是否有上新。`,
      "请检查电脑网络是否正常，并打开 Mercari 搜索页查看是否出现验证或加载异常。",
      `最近错误：${event.error}`, `上次成功：${formatTime(event.lastSuccess)}`,
      `查看搜索结果：${event.url}`, "程序会继续重试。如消息延迟送达，请以提醒面板的当前状态为准。"].join("\n\n");
    return { title, text, markdown: text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") };
  }
  const title = `${event.keyword || keyword}：发现 ${event.items.length} 件新出现的商品`;
  const lines = event.items.map(item => `${item.title} ${item.price}\n${item.url}`);
  if (event.gap) lines.push("注意：本轮与上一轮没有重叠，可能存在漏报，请核对搜索结果。");
  return { title, text: lines.join("\n\n"), markdown: event.items.map(item =>
    `- [${item.title.replace(/[\[\]<>]/g, "")} ${item.price}](${item.url})`).join("\n") + (event.gap ? "\n\n本轮与上一轮没有重叠，可能存在漏报。" : "") };
}
export async function sendChannel(channel, event, settings, api = chrome, request = fetch) {
  const message = messageFor(event, settings.keyword);
  if (channel === "desktop") {
    if (await api.notifications.getPermissionLevel() !== "granted") throw new Error("浏览器通知未获允许，请检查通知设置");
    await api.notifications.create(event.id, {
      type: "basic", iconUrl: api.runtime.getURL("icon.png"), title: message.title,
      message: message.text.slice(0, 850), contextMessage: event.type === "monitor-error" ? "Mercari 监控异常 · 点击查看状态" : "Mercari 上新提醒 · 点击查看记录", priority: 1
    });
    return;
  }
  if (channel !== settings.wechat || !settings.token) throw new Error("微信渠道已改变或密钥未配置，请重新配置后重试");
  if (!await api.permissions.contains({ origins: [origins[channel]] })) throw new Error("微信推送服务的访问权限未获允许，请重新保存配置");
  if (channel === "clawbot") {
    if (event.recipientIds?.length === 0) throw new Error("当前任务未选择微信接收人，请先勾选并保存");
    let response;
    try {
      response = await request("http://127.0.0.1:17869/notify", { method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.token}` },
        body: JSON.stringify({ id: event.id, title: message.title, text: message.text,
          recipientIds: event.recipientIds || ["owner"] }),
        signal: AbortSignal.timeout(10000), redirect: "error" });
    } catch { throw new Error("本机微信转发服务未连接，请运行 D:\\OpenClaw\\mercari-bridge\\启动微信转发.cmd"); }
    let result;
    try { result = await response.json(); } catch { throw new Error("本机微信转发服务未返回有效响应"); }
    if (!response.ok || result.ok !== true || result.accepted !== true) {
      if (response.status === 401) throw new Error("本机连接密钥不正确，请从连接页面重新复制并保存");
      throw new Error("本机微信转发服务未接受消息，请查看本机连接页面");
    }
    // Ownership transfers only after the bridge has durably stored the message.
    return;
  }
  const serverchan = channel === "serverchan";
  const url = serverchan ? `https://sctapi.ftqq.com/${settings.token}.send` : "https://www.pushplus.plus/send";
  const payload = serverchan ? { title: message.title, desp: message.markdown } :
    { token: settings.token, title: message.title, content: message.markdown, template: "markdown", channel: "wechat" };
  let response;
  try {
    response = await request(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15000), redirect: "error" });
  } catch { throw new Error("微信推送网络请求失败，将在下次检查时重试"); }
  if (!response.ok) throw new Error(`微信推送服务返回 HTTP ${response.status}`);
  let result;
  try { result = await response.json(); } catch { throw new Error("微信推送服务未返回有效 JSON"); }
  if (Number(result.code) !== (serverchan ? 0 : 200)) throw new Error("微信服务未接受消息，请检查密钥、绑定状态和额度");
  // PushPlus code 200 means accepted/queued, not confirmed received by WeChat.
}
export async function bridgeStatus(api = chrome, request = fetch) {
  if (!await api.permissions.contains({ origins: [origins.clawbot] })) return { connected: false, error: "请保存配置并允许本机服务访问" };
  try {
    const response = await request("http://127.0.0.1:17869/health", { signal: AbortSignal.timeout(1500), redirect: "error" });
    const result = await response.json();
    if (!response.ok || result.ok !== true || result.service !== "mercari-weixin-bridge") throw new Error();
    return { connected: true, contextReady: Boolean(result.contextReady), pending: Number(result.pending) || 0,
      hasContext: Boolean(result.hasContext ?? result.contextReady), verified: Boolean(result.verified),
      needsInteraction: Boolean(result.needsInteraction), needsLogin: Boolean(result.needsLogin),
      quotaReached: Boolean(result.quotaReached), sessionAccepted: Number(result.sessionAccepted) || 0,
      sessionMessageLimit: Number(result.sessionMessageLimit) || 10,
      delivered: Number(result.accepted ?? result.delivered) || 0,
      suppressed: Number(result.suppressed) || 0,
      multiRecipient: Boolean(result.multiRecipient), recipientCount: Number(result.recipientCount) || 1,
      error: String(result.healthError || result.lastError || result.lastPollError || result.lastSendError || "").slice(0, 240) };
  } catch { return { connected: false, error: "本机转发服务未运行，请打开启动微信转发.cmd" }; }
}
export async function retryBridge(settings, api = chrome, request = fetch) {
  if (settings.wechat !== "clawbot" || !settings.token) throw new Error("请先保存微信 ClawBot 配置");
  if (!await api.permissions.contains({ origins: [origins.clawbot] })) throw new Error("请允许本机微信服务访问");
  let response;
  try { response = await request("http://127.0.0.1:17869/retry", { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.token}` },
    body: "{}", signal: AbortSignal.timeout(10000), redirect: "error" }); }
  catch { throw new Error("本机微信转发服务未连接，请启动微信转发服务"); }
  if (response.status === 404) throw new Error("本机转发服务仍是旧版，请先更新并重启服务");
  if (response.status === 401) throw new Error("本机连接密钥不正确，请重新复制并保存");
  const result = await response.json();
  if (!response.ok || result.ok !== true || result.accepted !== true) throw new Error("微信待发消息重试请求未被接受");
  return result;
}

export async function recipientAdmin(settings, route, input = {}, api = chrome, request = fetch) {
  if (!["recipients", "sync-recipients", "save-recipient", "delete-recipient"].includes(route)) throw new Error("接收人操作不正确");
  if (settings.wechat !== "clawbot" || !settings.token) throw new Error("请先保存微信 ClawBot 连接配置");
  if (!await api.permissions.contains({ origins: [origins.clawbot] })) throw new Error("请允许访问本机微信转发服务");
  let response;
  try { response = await request(`http://127.0.0.1:17869/${route}`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.token}` },
    body: JSON.stringify(input), signal: AbortSignal.timeout(route === "delete-recipient" ? 45000 : 10000), redirect: "error" }); }
  catch { throw new Error("本机接收人管理服务未连接，请启动微信转发服务"); }
  if (response.status === 404) throw new Error("本机微信转发服务仍是旧版，请升级到 v1.3.2 后重启");
  if (response.status === 401) throw new Error("本机连接密钥不正确，请重新复制并保存");
  let result;
  try { result = await response.json(); } catch { throw new Error("接收人管理服务未返回有效响应"); }
  if (!response.ok || result.ok !== true) throw new Error(typeof result.error === "string" ? result.error.slice(0, 240) : "接收人操作未完成");
  if (!Array.isArray(result.recipients)) throw new Error("接收人服务仍是旧版或响应不正确，请更新本机转发服务");
  return result;
}
