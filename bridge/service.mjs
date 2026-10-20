import http from "node:http";
import { createHash, timingSafeEqual, randomBytes, randomUUID } from "node:crypto";
import { readJson, writeJson } from "./weixin.mjs";

const DAY = 86400000;
const unfinished = record => !record.doneAt && !record.skippedAt;
const safeToRebuild = record => !record.attempts || record.definitelyRejected || /微信拒绝发送/.test(record.lastError || "");
const digest = text => createHash("sha256").update(text).digest("hex");
const extensionOrigin = value => /^chrome-extension:\/\/[a-p]{32}$/.test(value || "");
const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
export function notification(input) {
  if (!input || typeof input.id !== "string" || !/^[\w:.-]{1,200}$/.test(input.id) ||
      typeof input.title !== "string" || input.title.length > 240 ||
      typeof input.text !== "string" || !input.text.trim() || input.text.length > 40000) {
    throw new Error("消息格式不正确");
  }
  const text = `${input.title}\n\n${input.text}`;
  const characters = Array.from(text);
  const chunks = [];
  for (let index = 0; index < characters.length; index += 2800) chunks.push(characters.slice(index, index + 2800).join(""));
  return { id: input.id, hash: digest(text), chunks };
}
function authorized(header, token) {
  const expected = Buffer.from(`Bearer ${token}`);
  const provided = Buffer.from(header || "");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
async function bodyJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw new Error("消息过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function setupPage(token, nonce) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>微信 ClawBot 连接</title>
<style>body{font:16px "Segoe UI","Microsoft YaHei",sans-serif;background:#f3f6f3;color:#17352e;max-width:720px;margin:60px auto;padding:24px}main{background:white;border:1px solid #dde5dd;padding:32px;border-radius:18px}p{line-height:1.8}input{width:100%;box-sizing:border-box;padding:12px;font:14px Consolas,monospace}button{background:#1c7358;color:white;padding:12px 20px;border:0;border-radius:8px;margin-top:16px;cursor:pointer}.muted{font-size:13px;color:#60736b}</style>
<main><h1>连接微信 ClawBot</h1><p id="status">正在检查微信连接…</p><p>在 Mercari 上新提醒面板选择「微信 ClawBot」，粘贴下面的连接密钥，然后保存配置并测试微信。</p>
<input id="key" readonly value="${escape(token)}" aria-label="本机连接密钥"><button id="copy">复制连接密钥</button>
<p class="muted">密钥只用于连接这台电脑的转发服务。微信登录凭证仍留在 D 盘，无需粘贴到扩展。电脑、浏览器和本机转发服务需要保持运行。</p></main>
<script nonce="${nonce}">document.getElementById('copy').onclick=async()=>{await navigator.clipboard.writeText(document.getElementById('key').value);document.getElementById('copy').textContent='已复制'};async function refresh(){try{const s=await(await fetch('/health')).json();const state=s.needsLogin?'微信登录已失效，请重新扫码。':s.quotaReached?'本次微信会话推送次数已用尽，请回复“继续提醒”后自动补发。':s.needsInteraction?'微信发送受限，请在手机给 ClawBot 发一条新消息；收到后自动补发。':s.verified?'最近发送请求已被微信接受，请在手机核对送达。':s.contextReady?'已保存微信会话，当前发送能力待验证。':'请先在手机微信给 ClawBot 发一条“上新提醒”。';document.getElementById('status').textContent='v'+s.version+' · '+state+' 待发 '+s.pending+' 批，微信接口已接收 '+s.accepted+' 批。'+(s.lastError||s.lastSendError||s.lastPollError||'')}catch{document.getElementById('status').textContent='转发服务已停止，请重新启动'}}refresh();setInterval(refresh,3000)</script></html>`;
}

export async function createBridge({ token, stateFile, send, status, port = 17869, clock = Date.now, listen = true }) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("本机连接密钥不正确");
  let state = await readJson(stateFile, { records: [] });
  if (!Array.isArray(state.records)) throw new Error("转发队列文件损坏，请先保留该文件并检查");
  let chain = Promise.resolve();
  let stopping = false;
  let timer;
  let worker = Promise.resolve();
  let storageError = "";
  let sessionRevision = null;
  const transaction = fn => {
    const task = chain.then(fn);
    chain = task.catch(() => {});
    return task;
  };
  async function persist(next) {
    next.records = next.records.filter(record => unfinished(record) || clock() - (record.doneAt || record.skippedAt) < 14 * DAY);
    const completed = next.records.filter(record => !unfinished(record)).slice(-10000);
    next.records = [...completed, ...next.records.filter(unfinished)];
    try { await writeJson(stateFile, next); state = next; storageError = ""; }
    catch (error) { storageError = "本机队列保存失败，请检查 D 盘空间和目录权限"; throw error; }
  }
  async function accept(input) {
    const message = notification(input);
    return transaction(async () => {
      const existing = state.records.find(record => record.id === message.id);
      if (existing) {
        if (existing.hash !== message.hash) throw new Error("同一消息编号对应了不同内容");
        return { ok: true, accepted: true, duplicate: true, delivered: Boolean(existing.doneAt), suppressed: Boolean(existing.skippedAt) };
      }
      if (state.records.filter(item => !item.sourceIds && unfinished(item)).length >= 500) throw new Error("本机待发队列已满，请先恢复微信连接");
      const record = { ...message, nextChunk: 0, createdAt: clock(), nextAttempt: 0, attempts: 0, lastError: "" };
      await persist({ records: [...state.records, record] });
      return { ok: true, accepted: true, duplicate: false, delivered: false };
    });
  }
  async function dispatch(record) {
    if (!unfinished(record) || record.sourceIds || record.nextChunk || record.chunks.length !== 1 || !safeToRebuild(record)) return record;
    const selected = [record];
    const prefix = count => `Mercari 积压补发 · 合并 ${count} 批（请以商品当前状态为准）\n\n`;
    const separator = "\n\n────────\n\n";
    let size = Array.from(prefix(99) + record.chunks[0]).length;
    const candidates = await transaction(() => state.records.filter(item => unfinished(item) && !item.bundledInto &&
      !item.sourceIds && item.id !== record.id && !item.nextChunk && item.chunks.length === 1 && safeToRebuild(item) && item.nextAttempt <= clock()));
    for (const candidate of candidates) {
      const addition = Array.from(separator + candidate.chunks[0]).length;
      if (size + addition > 2700) break;
      selected.push(candidate); size += addition;
    }
    if (selected.length < 2) return record;
    return transaction(async () => {
      const text = prefix(selected.length) + selected.map(item => item.chunks[0]).join(separator);
      const bundle = { id: `bundle-${randomUUID()}`, hash: digest(text), chunks: [text], nextChunk: 0,
        createdAt: clock(), nextAttempt: 0, attempts: 0, lastError: "", prepared: true,
        sourceIds: selected.map(item => item.id) };
      await persist({ records: [...state.records.map(item => bundle.sourceIds.includes(item.id) ? { ...item, bundledInto: bundle.id } : item), bundle] });
      return bundle;
    });
  }
  async function tick() {
    if (stopping) return;
    try {
      const connection = await status();
      if (Number.isFinite(connection.sessionRevision) && connection.sessionRevision !== sessionRevision) {
        const previousRevision = sessionRevision;
        sessionRevision = connection.sessionRevision;
        if (previousRevision !== null || connection.contextReady) await retryPending();
      }
      const candidate = !connection.needsInteraction && !connection.needsLogin && await transaction(() => state.records.find(item => unfinished(item) && !item.bundledInto && item.nextAttempt <= clock()));
      const record = candidate ? await dispatch(candidate) : null;
      if (record && unfinished(record)) {
        try {
          const clientId = `mercari-${digest(`${record.id}:${record.deliveryHash || record.hash}:${record.nextChunk}`).slice(0, 32)}`;
          await send(record.chunks[record.nextChunk], clientId);
          await transaction(async () => {
            const updated = { ...record, nextChunk: record.nextChunk + 1, lastError: "", errorCode: "", attempts: 0, nextAttempt: 0 };
            if (updated.nextChunk === updated.chunks.length) { updated.doneAt = clock(); delete updated.chunks; }
            await persist({ records: state.records.map(item => {
              if (item.id === record.id) return updated;
              if (updated.doneAt && record.sourceIds?.includes(item.id)) {
                const complete = { ...item, doneAt: updated.doneAt, nextChunk: item.chunks.length,
                  attempts: 0, nextAttempt: 0, lastError: "", errorCode: "" };
                delete complete.chunks; return complete;
              }
              return item;
            }) });
          });
        } catch (error) {
          await transaction(async () => {
            const updated = { ...record, attempts: record.attempts + 1, lastError: storageError || String(error.message).slice(0, 240),
              definitelyRejected: ["WEIXIN_CONTEXT_REJECTED", "WEIXIN_LOGIN_EXPIRED"].includes(error.code),
              errorCode: /^WEIXIN_[A-Z_]+$/.test(error.code || "") ? error.code : "" };
            updated.nextAttempt = clock() + Math.min(300000, 5000 * 2 ** Math.min(updated.attempts, 6));
            await persist({ records: state.records.map(item => item.id === record.id ? updated : item) });
          });
        }
      }
    } catch { /* Storage errors remain visible in health; no acknowledgement is lost. */ }
    if (!stopping) timer = setTimeout(() => { worker = tick(); }, 500);
  }
  async function health() {
    return transaction(async () => ({ ok: true, service: "mercari-weixin-bridge", version: "1.3.2", ...await status(),
      pending: state.records.filter(item => !item.sourceIds && unfinished(item)).length,
      delivered: state.records.filter(item => !item.sourceIds && item.doneAt).length,
      accepted: state.records.filter(item => !item.sourceIds && item.doneAt).length,
      sendRequests: state.records.filter(item => item.doneAt && !item.bundledInto).length,
      suppressed: state.records.filter(item => item.skippedAt).length,
      lastDeliveryAt: Math.max(0, ...state.records.map(item => item.doneAt || 0)) || null,
      lastError: storageError || state.records.find(item => unfinished(item) && item.lastError)?.lastError || "" }));
  }
  async function retryPending() {
    return transaction(async () => {
      const count = state.records.filter(item => !item.sourceIds && unfinished(item)).length;
      if (count) await persist({ records: state.records.map(item => unfinished(item) ? { ...item, nextAttempt: 0,
        definitelyRejected: Boolean(item.definitelyRejected || /微信拒绝发送/.test(item.lastError || "")), lastError: "", errorCode: "" } : item) });
      return { ok: true, accepted: true, pending: count };
    });
  }
  const server = listen ? await createEndpoint({ token, accept, health, retryPending, port }) : null;
  timer = setTimeout(() => { worker = tick(); }, 100);
  return { server, accept, health, retryPending,
    close: async () => { stopping = true; clearTimeout(timer); if (server) await new Promise(resolve => server.close(resolve)); await worker; await chain; } };
}

export async function createEndpoint({ token, accept, health, retryPending, admin, port = 17869 }) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("本机连接密钥不正确");
  const server = http.createServer(async (request, response) => {
    const origin = request.headers.origin;
    const host = request.headers.host;
    const ownOrigin = `http://${host}`;
    function result(code, data) {
      response.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify(data));
    }
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (!/^127\.0\.0\.1:\d+$/.test(host || "")) return result(403, { error: "仅允许本机访问" });
    if (origin && origin !== ownOrigin && !extensionOrigin(origin)) return result(403, { error: "来源不允许" });
    if (origin) { response.setHeader("Access-Control-Allow-Origin", origin); response.setHeader("Vary", "Origin"); }
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Private-Network": "true", "Access-Control-Max-Age": "600" });
      return response.end();
    }
    try {
      if (request.method === "GET" && request.url === "/health") return result(200, await health());
      if (request.method === "GET" && ["/", "/setup"].includes(request.url)) {
        if (origin && origin !== ownOrigin || ![undefined, "none", "same-origin"].includes(request.headers["sec-fetch-site"])) return result(403, { error: "请在本机浏览器直接打开连接页面" });
        const nonce = randomBytes(16).toString("base64");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
          "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
          "Referrer-Policy": "no-referrer" });
        return response.end(setupPage(token, nonce));
      }
      if (request.method !== "POST" || !["/notify", "/retry", ...(admin ? ["/recipients", "/sync-recipients", "/save-recipient", "/delete-recipient"] : [])].includes(request.url)) return result(404, { error: "接口不存在" });
      if (!authorized(request.headers.authorization, token)) return result(401, { error: "本机连接密钥不正确，请重新复制并保存" });
      if (!request.headers["content-type"]?.startsWith("application/json")) return result(415, { error: "需要 JSON 消息" });
      if (request.url === "/retry") { await bodyJson(request); return result(200, await retryPending()); }
      if (request.url !== "/notify") return result(200, await admin(request.url, await bodyJson(request)));
      return result(200, await accept(await bodyJson(request)));
    } catch (error) {
      // Never expose OS paths, stack traces, WeChat credentials or raw API errors.
      const message = /消息|队列|编号|接收人|用户|默认|账号/.test(error.message) ? error.message : "本机转发服务处理失败，请检查 D 盘空间和服务日志";
      result(400, { error: message });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return server;
}
