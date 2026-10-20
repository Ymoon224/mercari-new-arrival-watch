import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const API_BASE = "https://ilinkai.weixin.qq.com";
const ACTIVE = new Set(["starting", "wait", "scanned", "need_verifycode"]);
const MESSAGES = {
  starting: "正在生成微信连接二维码", wait: "请用接收人的手机微信扫码",
  scanned: "已扫码，请在手机微信确认", need_verifycode: "请输入手机微信显示的数字配对码",
  connected: "绑定已保存，请由管理员分配关键词；接收人需给 ClawBot 发一条消息以建立推送会话",
  expired: "二维码已过期，请重新添加接收人", cancelled: "本次扫码已取消",
  failed: "微信连接失败，请检查服务器网络后重试", already_connected: "此微信已连接当前服务，请同步或查看已有接收人"
};

function weixinUrl(value, { hostOnly = false, allowHttp = false } = {}) {
  if (typeof value !== "string" || value.length > 4096) throw new Error("微信返回的连接地址不正确");
  const url = new URL(hostOnly ? `https://${value}` : value);
  if (!(url.protocol === "https:" || allowHttp && url.protocol === "http:") || url.username || url.password ||
      url.port || !(url.hostname === "weixin.qq.com" || url.hostname.endsWith(".weixin.qq.com")) ||
      hostOnly && (url.pathname !== "/" || url.search || url.hash)) throw new Error("微信返回的连接地址不正确");
  return url.href;
}

async function loadOfficial(config) {
  const api = await import(pathToFileURL(path.join(config.pluginRoot, "dist/src/api/api.js")));
  const accounts = await import(pathToFileURL(path.join(config.pluginRoot, "dist/src/auth/accounts.js")));
  const require = createRequire(path.join(config.pluginRoot, "package.json"));
  const sdk = await import(pathToFileURL(require.resolve("openclaw/plugin-sdk/account-id")));
  return { api, accounts, normalizeAccountId: sdk.normalizeAccountId };
}

/**
 * Server adaptation of the Tencent 2.4.10 QR protocol. Its CLI login helper reads
 * stdin for phone pairing codes, so use the same exported HTTP and state helpers
 * here. Only this manager retains qrcode/pairing secrets; admin responses contain
 * the short-lived display URL and an unrelated opaque session ID.
 */
export async function createWeixinLogin({ config, onBound = async () => {}, dependencies = {} }) {
  const official = dependencies.api && dependencies.accounts && dependencies.normalizeAccountId ? dependencies : await loadOfficial(config);
  const { api, accounts, normalizeAccountId } = { ...official, ...dependencies };
  const now = dependencies.now || Date.now;
  const ttlMs = dependencies.ttlMs || 5 * 60_000;
  const pollMs = dependencies.pollMs ?? 1000;
  const sessions = new Map();
  let active = null;
  let stopped = false;

  function expire(session) {
    if (ACTIVE.has(session.status) && now() >= session.expiresAt) finish(session, "expired");
  }
  function finish(session, status, message = MESSAGES[status]) {
    session.status = status; session.message = message;
    session.qrcode = undefined; session.verifyCode = undefined; session.qrUrl = undefined;
    session.controller.abort();
    if (active === session) active = null;
    session.wake?.();
  }
  function view(session) {
    expire(session);
    return { id: session.id, status: session.status, expiresAt: session.expiresAt,
      ...(session.qrUrl ? { qrUrl: session.qrUrl } : {}), message: session.message,
      ...(session.syncPending ? { syncPending: true } : {}) };
  }
  function lookup(input) {
    if (typeof input?.id !== "string" || !sessions.has(input.id)) throw new Error("扫码会话不存在，请重新添加接收人");
    return sessions.get(input.id);
  }
  function pending(session) { expire(session); return !stopped && ACTIVE.has(session.status) && !session.controller.signal.aborted; }
  async function request(session, operation, timeoutMs) {
    let timer; let abort;
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        abort = () => reject(new Error("QR request cancelled"));
        session.controller.signal.addEventListener("abort", abort, { once: true });
        if (session.controller.signal.aborted) abort();
        timer = setTimeout(() => reject(new Error("QR request timeout")), timeoutMs);
      })]);
    } finally {
      clearTimeout(timer);
      session.controller.signal.removeEventListener("abort", abort);
    }
  }
  async function delay(session, ms) {
    if (!pending(session)) return;
    await new Promise(resolve => {
      const timer = setTimeout(done, ms);
      function done() { clearTimeout(timer); session.wake = undefined; resolve(); }
      session.wake = done;
    });
  }
  async function confirm(session, response) {
    if (!pending(session)) return;
    const rawId = response.ilink_bot_id;
    const token = response.bot_token;
    const userId = response.ilink_user_id;
    if (typeof rawId !== "string" || !/^[a-zA-Z0-9_.@-]{1,160}$/.test(rawId) ||
        typeof token !== "string" || !token.trim() || token.length > 8192 ||
        typeof userId !== "string" || !userId.trim() || userId.length > 256) throw new Error("Invalid confirmed response");
    const accountId = normalizeAccountId(rawId);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(accountId) || ["default", "__proto__", "constructor", "prototype"].includes(accountId)) throw new Error("Invalid account ID");
    const baseUrl = response.baseurl ? weixinUrl(response.baseurl) : API_BASE;
    // Official state writes are synchronous. Cancel cannot interleave between
    // this final check and saving/registering the confirmed credentials.
    if (!pending(session)) return;
    try {
      accounts.saveWeixinAccount(accountId, { token: token.trim(), baseUrl, userId: userId.trim() });
      accounts.registerWeixinAccountId(accountId);
    } catch {
      finish(session, "failed", "微信绑定信息保存未完成，请检查服务器数据目录权限后重新添加接收人");
      return;
    }
    finish(session, "connected");
    try { await onBound({ accountId }); }
    catch {
      // Do not roll back a successful official binding or resave it on polling.
      // The admin's normal sync action can retry importing the durable account.
      session.syncPending = true;
      session.message = "微信绑定已保存，但接收人同步未完成；请点击同步用户，并检查是否已存在同一微信用户";
    }
  }
  async function poll(session) {
    while (pending(session)) {
      if (session.status === "need_verifycode" && !session.verifyCode) { await delay(session, pollMs); continue; }
      try {
        const submittedCode = session.verifyCode;
        const endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.qrcode)}` +
          (submittedCode ? `&verify_code=${encodeURIComponent(submittedCode)}` : "");
        const response = JSON.parse(await request(session, api.apiGetFetch({ baseUrl: session.baseUrl, endpoint,
          timeoutMs: Math.min(5000, Math.max(1, session.expiresAt - now())), label: "mercariQrStatus",
          abortSignal: session.controller.signal }), 5500));
        if (!pending(session)) return;
        if (response.errcode || response.ret) throw new Error("Official QR request rejected");
        if (response.status === "confirmed") { await confirm(session, response); return; }
        if (response.status === "expired") { finish(session, "expired"); return; }
        if (response.status === "binded_redirect") { finish(session, "already_connected"); return; }
        if (response.status === "verify_code_blocked") { finish(session, "failed", "配对码多次输入错误，请稍后重新添加接收人"); return; }
        if (response.status === "scaned_but_redirect") {
          session.baseUrl = weixinUrl(response.redirect_host, { hostOnly: true });
          session.status = "scanned";
        } else if (response.status === "need_verifycode") {
          if (submittedCode) session.verifyCode = undefined;
          session.status = "need_verifycode";
        } else if (response.status === "scaned") {
          session.verifyCode = undefined; session.status = "scanned";
        } else if (response.status === "wait") session.status = "wait";
        else throw new Error("Unknown official QR state");
        session.message = MESSAGES[session.status];
        session.failures = 0;
      } catch {
        if (!pending(session)) return;
        // GET's own timeout is short. The official 2.4.10 helper cannot abort a
        // GET externally; logical cancellation still prevents all later saves.
        session.failures++;
        if (session.failures >= 5) { finish(session, "failed"); return; }
        session.message = "微信连接状态暂时读取失败，正在重试；可取消后检查服务器网络";
      }
      await delay(session, pollMs);
    }
  }
  async function start() {
    if (stopped) throw new Error("服务正在停止");
    if (active) { expire(active); if (active) return view(active); }
    for (const [id, session] of sessions) if (now() - session.expiresAt > ttlMs) sessions.delete(id);
    // Keep the in-memory status history bounded, including rapid cancel/restart.
    while (sessions.size >= 20) sessions.delete(sessions.keys().next().value);
    const session = { id: randomUUID(), status: "starting", message: MESSAGES.starting,
      expiresAt: now() + ttlMs, baseUrl: API_BASE, failures: 0, controller: new AbortController() };
    sessions.set(session.id, session); active = session;
    const creating = (async () => {
      try {
        const tokens = accounts.listIndexedWeixinAccountIds().slice().reverse().map(id => accounts.loadWeixinAccount(id)?.token?.trim()).filter(Boolean).slice(0, 10);
        const response = JSON.parse(await request(session, api.apiPostFetch({ baseUrl: API_BASE,
          endpoint: "ilink/bot/get_bot_qrcode?bot_type=3", body: JSON.stringify({ local_token_list: tokens }),
          label: "mercariQrStart", timeoutMs: 15000, abortSignal: session.controller.signal }), 15500));
        if (!pending(session)) return;
        if (response.errcode || response.ret || typeof response.qrcode !== "string" || !response.qrcode || response.qrcode.length > 8192) throw new Error("Invalid QR response");
        session.qrUrl = weixinUrl(response.qrcode_img_content, { allowHttp: true });
        session.qrcode = response.qrcode;
        session.status = "wait"; session.message = MESSAGES.wait;
        session.polling = poll(session);
      } catch { if (pending(session)) finish(session, "failed"); }
    })();
    session.creating = creating;
    await creating;
    return view(session);
  }
  return {
    start,
    status(input) { return view(lookup(input)); },
    verify(input) {
      const session = lookup(input); expire(session);
      if (session.status !== "need_verifycode") throw new Error("此会话当前无需输入配对码");
      if (typeof input.code !== "string" || !/^\d{4,12}$/.test(input.code)) throw new Error("请输入手机微信显示的 4–12 位数字配对码");
      session.verifyCode = input.code; session.status = "scanned"; session.message = "正在验证配对码"; session.wake?.();
      return view(session);
    },
    cancel(input) {
      const session = lookup(input);
      if (ACTIVE.has(session.status)) finish(session, "cancelled");
      return view(session);
    },
    async close() {
      stopped = true;
      for (const session of sessions.values()) if (ACTIVE.has(session.status)) finish(session, "cancelled");
      await Promise.allSettled([...sessions.values()].flatMap(session => [session.creating, session.polling]).filter(Boolean));
    }
  };
}
