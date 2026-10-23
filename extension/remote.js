// The controller connection is separate from all saved local monitoring data.
export const REMOTE_KEY = "remoteController";
export const REMOTE_TYPES = new Set(["status", "save-monitor", "toggle", "check", "delete-monitor", "pause-all", "start-all", "save-collection-schedule", "save-settings", "clear-pending", "recipients", "sync-recipients", "save-recipient", "delete-recipient", "qr-start", "qr-status", "qr-cancel", "qr-verify", "retry-wechat", "test-notification"]);
export function remoteUrl(input) {
  let url; try { url = new URL(String(input || "").trim()); } catch { throw new Error("请填写完整的服务器 HTTPS 地址"); }
  const loopback = ["localhost", "127.0.0.1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) throw new Error("服务器须使用 HTTPS；仅本机测试允许 HTTP，地址不能包含账号、查询参数或片段");
  if (url.pathname !== "/") throw new Error("服务器地址只填写域名和端口，不要包含页面路径或接口路径");
  return url.origin;
}
export function remotePermission(input) { const url = new URL(remoteUrl(input)); return `${url.protocol}//${url.hostname}/*`; }
export async function readController() { return (await chrome.storage.local.get(REMOTE_KEY))[REMOTE_KEY] || { mode: "local", localSuspended: false }; }
export function safeController(config) { return { mode: config.mode, baseUrl: config.baseUrl || "", hasToken: Boolean(config.token), localSuspended: Boolean(config.localSuspended) }; }
export function qrPresentation(session = {}) {
  const messages = { starting: "正在生成二维码", wait: "请用接收人的微信扫码", scanned: "已扫码，请在手机确认", need_verifycode: "请填写手机显示的验证码", connected: "绑定完成，请在任务中选择接收人", already_connected: "此微信已绑定，请在任务中选择接收人", expired: "二维码已过期，请重新添加", cancelled: "扫码已取消", failed: "绑定失败，请重试" };
  const status = Object.hasOwn(messages, session.status) ? session.status : "failed";
  return { status, message: String(session.message || messages[status]).slice(0, 500),
    active: ["starting", "wait", "scanned", "need_verifycode"].includes(status),
    connected: ["connected", "already_connected"].includes(status),
    showQr: Boolean(session.qrUrl) && ["wait", "scanned"].includes(status),
    verify: status === "need_verifycode" };
}
export async function remoteRequest(config, message) {
  if (!REMOTE_TYPES.has(message.type)) throw new Error("远端模式不支持此操作");
  if (!config.token || !config.baseUrl) throw new Error("尚未连接远端服务器；本机采集保持暂停");
  const baseUrl = remoteUrl(config.baseUrl);
  if (!await chrome.permissions.contains({ origins: [remotePermission(baseUrl)] })) throw new Error("请重新连接并允许访问此服务器");
  const abort = new AbortController(); const timeout = setTimeout(() => abort.abort(), message.type === "delete-recipient" ? 45000 : 20000);
  try {
    const response = await fetch(`${baseUrl}/api/admin`, { method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" }, body: JSON.stringify(message), signal: abort.signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
    if (response.status === 401) throw new Error("服务器拒绝管理员密钥，请检查连接设置");
    if (response.status === 403) throw new Error("服务器拒绝连接，请检查管理员密钥、HTTPS 及服务器允许来源设置");
    const raw = await response.text(); if (raw.length > 3000000) throw new Error("服务器响应过大");
    let data; try { data = JSON.parse(raw); } catch { throw new Error(`服务器未返回有效数据（HTTP ${response.status || 200}）`); }
    if (data?.error) throw new Error(String(data.error).slice(0, 400));
    if (!response.ok) throw new Error(`服务器请求失败（HTTP ${response.status}）`);
    return data;
  } catch (error) { if (error.name === "AbortError") throw new Error("服务器请求超时；服务端可能已执行操作，请先查看状态"); throw error; }
  finally { clearTimeout(timeout); }
}
