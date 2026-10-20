import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

export async function readJson(file, fallback) {
  try { return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "")); }
  catch (error) { if (error.code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
}
export async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data), { mode: 0o600 });
  await fs.rename(temp, file);
}
export function gatewayOnline(port = 18789) {
  return new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = online => { socket.destroy(); resolve(online); };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}
export function safeWeixinError(error) {
  const text = String(error?.message || error);
  if (/ret=-14|errcode=-14/.test(text)) return "微信登录已失效，请重新扫码登录";
  if (/(?:ret|errcode)=-2\b/.test(text)) return "微信拒绝发送（-2），可能是会话失效或发送受限。请给 ClawBot 发一条新消息后重试";
  const code = text.match(/(?:ret|errcode)=(-?\d+)/)?.[1];
  return code ? `微信接口拒绝请求（错误码 ${code}）` : "微信网络请求失败，请检查网络后重试";
}

export async function createWeixin(config, dependencies = {}) {
  const api = dependencies.api || await import(pathToFileURL(path.join(config.pluginRoot, "dist/src/api/api.js")));
  const sync = dependencies.sync || await import(pathToFileURL(path.join(config.pluginRoot, "dist/src/storage/sync-buf.js")));
  const accountFile = path.join(config.stateDir, "openclaw-weixin/accounts", `${config.accountId}.json`);
  const contextFile = path.join(config.stateDir, "openclaw-weixin/accounts", `${config.accountId}.context-tokens.json`);
  const syncFile = sync.getSyncBufFilePath(config.accountId);
  const healthFile = path.join(config.stateDir, `mercari-weixin-health-${config.accountId}.json`);
  const hash = value => value ? createHash("sha256").update(value).digest("hex") : "";
  let sendHealth = await readJson(healthFile, {});
  let healthError = "";
  let healthChain = Promise.resolve();
  async function updateHealth(patch) {
    const task = healthChain.then(async () => {
      const next = { ...sendHealth, ...(typeof patch === "function" ? patch(sendHealth) : patch) };
      sendHealth = next;
      try { await writeJson(healthFile, next); healthError = ""; }
      catch (error) { healthError = "微信状态保存失败，请检查 D 盘空间和权限"; throw error; }
    });
    healthChain = task.catch(() => {});
    return task;
  }
  if (config.deliveryFile && sendHealth.sessionAccepted == null && sendHealth.contextUpdatedAt) {
    const queue = await readJson(config.deliveryFile, { records: [] });
    const sessionAccepted = queue.records.filter(record => record.doneAt >= sendHealth.contextUpdatedAt && !record.bundledInto).length;
    await updateHealth({ sessionAccepted });
  }
  let lastPollError = "";
  let lastPollAt = null;
  let lastPollFailureCode = "";
  let mode = "direct";
  const sessionMessageLimit = Number.isInteger(config.sessionMessageLimit) && config.sessionMessageLimit > 0 ? config.sessionMessageLimit : 10;
  async function credentials() {
    const account = await readJson(accountFile);
    if (!account.token || account.userId !== config.target) throw new Error("微信扫码账号发生变化，请重新配置本机转发服务");
    const baseUrl = new URL(account.baseUrl || "https://ilinkai.weixin.qq.com");
    if (baseUrl.protocol !== "https:" || !(baseUrl.hostname === "weixin.qq.com" || baseUrl.hostname.endsWith(".weixin.qq.com"))) {
      throw new Error("微信登录文件中的接口地址不正确");
    }
    return { token: account.token, baseUrl: baseUrl.href };
  }
  async function context() { return (await readJson(contextFile, {}))[config.target]; }
  async function observeContext() {
    const token = await context();
    const fingerprint = hash(token);
    if (fingerprint && fingerprint !== sendHealth.contextHash) {
      const modified = (await fs.stat(contextFile)).mtimeMs;
      await updateHealth(previous => previous.contextHash === fingerprint ? {} : {
        contextHash: fingerprint, contextUpdatedAt: modified, rejectedContextHash: null,
        lastSendError: "", lastFailureCode: null, sessionAccepted: 0, sessionRevision: (previous.sessionRevision || 0) + 1
      });
    }
    return { token, fingerprint };
  }
  async function pollOnce(signal) {
    // If the full Gateway owns getUpdates, use its persisted context instead.
    // This small notification bridge never dispatches inbound text to an LLM.
    if (await (dependencies.gatewayOnline || gatewayOnline)(config.gatewayPort)) { mode = "gateway"; return; }
    mode = "direct";
    const response = await api.getUpdates({ ...await credentials(),
      get_updates_buf: sync.loadGetUpdatesBuf(syncFile) || "", timeoutMs: 35000, abortSignal: signal });
    if (response.ret && response.ret !== 0 || response.errcode && response.errcode !== 0) {
      throw new Error(`ret=${response.ret || response.errcode}`);
    }
    // Ignore message text and all other senders; only retain the scanner's context.
    const tokens = await readJson(contextFile, {});
    let changed = false;
    let inboundKey = null;
    for (const message of response.msgs || []) {
      if (message.from_user_id === config.target && message.context_token) {
        tokens[config.target] = message.context_token; changed = true;
        inboundKey = hash(`${message.message_id || message.seq || message.create_time_ms || ""}:${message.context_token}`);
      }
    }
    if (changed) {
      await writeJson(contextFile, tokens);
      const fingerprint = hash(tokens[config.target]);
      await updateHealth(previous => previous.lastInboundKey === inboundKey ? {} : {
        contextHash: fingerprint, contextUpdatedAt: Date.now(), lastInboundKey: inboundKey,
        rejectedContextHash: null, lastSendError: "", lastFailureCode: null, sessionAccepted: 0, sessionRevision: (previous.sessionRevision || 0) + 1
      });
    }
    // Commit the cursor after context persistence, so failures can safely replay.
    if (response.get_updates_buf) sync.saveGetUpdatesBuf(syncFile, response.get_updates_buf);
    lastPollAt = Date.now(); lastPollError = ""; lastPollFailureCode = "";
  }
  async function send(text, clientId, options = {}) {
    const { token, fingerprint } = await observeContext();
    if (!token) throw new Error("请先在微信给 ClawBot 发一条“上新提醒”，等待几秒后再测试微信");
    if ((sendHealth.sessionAccepted || 0) >= sessionMessageLimit) throw Object.assign(new Error("本次微信会话推送次数已用尽，请回复“继续提醒”后自动补发"), { code: "WEIXIN_CONTEXT_REJECTED" });
    const revision = sendHealth.sessionRevision;
    const previousHint = sendHealth.messageHints?.[clientId];
    const finalSlot = previousHint?.finalSlot ?? ((sendHealth.sessionAccepted || 0) + 1 >= sessionMessageLimit);
    if (!previousHint) await updateHealth(previous => ({ messageHints: Object.fromEntries(Object.entries({ ...previous.messageHints,
      [clientId]: { finalSlot, time: Date.now() } }).filter(([, hint]) => Date.now() - hint.time < 14 * 86400000).slice(-1000)) }));
    const outgoing = text + (finalSlot && options.renewalReminder !== false ? "\n\n微信每次互动后的主动推送次数有限。若后续提醒暂停，请回复“继续提醒”；未发消息会保留。" : "");
    try {
      const response = await api.sendMessage({ ...await credentials(), timeoutMs: 15000,
        body: { msg: { from_user_id: "", to_user_id: config.target, client_id: clientId,
          message_type: 2, message_state: 2, context_token: token,
          item_list: [{ type: 1, text_item: { text: outgoing } }] } } });
      if (!response || typeof response !== "object") throw new Error("invalid response");
      if (response.ret != null && Number(response.ret) !== 0 || response.errcode != null && Number(response.errcode) !== 0) {
        throw new Error(`ret=${response.errcode || response.ret}`);
      }
      // The official transport also accepts success responses with no ret field.
      await updateHealth(previous => ({ lastAcceptedAt: Date.now(), acceptedContextHash: fingerprint,
        ...(previous.sessionRevision === revision ? { sessionAccepted: (previous.sessionAccepted || 0) + 1 } : {}),
        rejectedContextHash: null, lastSendError: "", lastFailureCode: null })).catch(() => {});
      return { accepted: true };
    } catch (error) {
      const safeMessage = safeWeixinError(error);
      const code = String(error.message).match(/(?:ret|errcode)=(-?\d+)/)?.[1];
      await updateHealth({ lastSendError: safeMessage, lastFailureCode: code || null, lastRejectedAt: Date.now(),
        ...(code === "-2" ? { rejectedContextHash: fingerprint } : {}) }).catch(() => {});
      const failure = new Error(safeMessage);
      failure.code = code === "-2" ? "WEIXIN_CONTEXT_REJECTED" : code === "-14" ? "WEIXIN_LOGIN_EXPIRED" : "WEIXIN_SEND_FAILED";
      throw failure;
    }
  }
  async function monitor(signal) {
    let failures = 0;
    while (!signal.aborted) {
      try { await pollOnce(signal); failures = 0; }
      catch (error) { lastPollError = safeWeixinError(error); lastPollFailureCode = String(error.message).match(/(?:ret|errcode)=(-?\d+)/)?.[1] || ""; failures++; }
      if (!signal.aborted) await new Promise(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, failures ? Math.min(60000, 2000 * 2 ** Math.min(failures, 5)) : mode === "gateway" ? 3000 : 500);
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }
  async function disconnect({ notifyRemote = true } = {}) {
    let remoteStopped = false;
    try {
      if (!notifyRemote) throw new Error("Local cleanup only");
      const account = await credentials();
      const response = await api.notifyStop({ ...account, timeoutMs: 2000 });
      remoteStopped = Boolean(response && (!response.ret || Number(response.ret) === 0) && (!response.errcode || Number(response.errcode) === 0));
    } catch { /* Offline/expired accounts must still be removed locally. */ }
    const accounts = dependencies.accounts || await import(pathToFileURL(path.join(config.pluginRoot, "dist/src/auth/accounts.js")));
    accounts.unregisterWeixinAccountId(config.accountId);
    accounts.clearWeixinAccount(config.accountId);
    const indexed = await readJson(path.join(config.stateDir, "openclaw-weixin/accounts.json"), []);
    const remaining = await readJson(accountFile, {});
    return { remoteStopped, localCredentialsRemoved: !remaining.token && !indexed.includes(config.accountId) };
  }
  return { send, pollOnce, monitor, disconnect, status: async () => {
    const { token, fingerprint } = await observeContext();
    const rejected = Boolean(fingerprint && sendHealth.rejectedContextHash === fingerprint);
    const quotaReached = (sendHealth.sessionAccepted || 0) >= sessionMessageLimit;
    const needsLogin = sendHealth.lastFailureCode === "-14" || lastPollFailureCode === "-14";
    return { hasContext: Boolean(token), contextReady: Boolean(token) && !rejected && !needsLogin && !quotaReached,
      needsInteraction: !token || rejected || quotaReached, quotaReached,
      sessionAccepted: sendHealth.sessionAccepted || 0, sessionMessageLimit,
      needsLogin,
      verified: Boolean(fingerprint && sendHealth.acceptedContextHash === fingerprint && !sendHealth.lastSendError && !rejected && !quotaReached && sendHealth.lastAcceptedAt >= sendHealth.contextUpdatedAt),
      sessionRevision: sendHealth.sessionRevision || 0, contextUpdatedAt: sendHealth.contextUpdatedAt || null,
      lastAcceptedAt: sendHealth.lastAcceptedAt || null, lastSendError: sendHealth.lastSendError || "",
      mode, lastPollAt, lastPollError, healthError };
  } };
}
