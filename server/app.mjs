import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { messageFor } from '../extension/notify.js';

const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/;
const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const monitorActions = new Set(['status', 'save-monitor', 'toggle', 'check', 'delete-monitor', 'pause-all', 'start-all', 'save-settings', 'clear-pending', 'retry-wechat', 'save-collection-schedule']);
const recipientActions = new Set(['recipients', 'sync-recipients', 'save-recipient', 'delete-recipient']);
const loginActions = { 'qr-start': 'start', 'qr-status': 'status', 'qr-cancel': 'cancel', 'qr-verify': 'verify' };

function authenticated(header, token) {
  const a = Buffer.from(header || ''), b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function readBody(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 131072) throw Object.assign(new Error('管理请求过大'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw Object.assign(new Error('需要有效的 JSON 管理请求'), { status: 400 }); }
}

// Unlike the old loopback bridge, this is an authenticated remote control API.
// WeChat credentials, QR session secrets and the administrator key are never
// returned by a public health endpoint or embedded into an HTML setup page.
export async function createRemoteApp({ config, monitor, hub, login, clock = Date.now }) {
  if (!/^[a-fA-F0-9]{64}$/.test(config.token || '')) throw new Error('远端管理员密钥格式不正确');
  const denied = new Map();
  const server = http.createServer(async (request, response) => {
    const send = (status, body) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
      response.end(JSON.stringify(body));
    };
    const origin = request.headers.origin;
    const allowed = !origin || config.allowedOrigins?.includes(origin) || (!config.requireHttps && !config.allowedOrigins?.length && extensionOrigin.test(origin));
    if (!allowed) return send(403, { error: '来源不允许访问管理接口' });
    if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
    if (request.method === 'GET' && request.url === '/health') return send(200, { ok: true, service: 'mercari-watch-remote', version: '2.0.0' });
    if (request.url !== '/api/admin') return send(404, { error: '接口不存在' });
    if (config.requireHttps && !request.socket.encrypted && !(config.trustProxy && loopback(request.socket.remoteAddress) && request.headers['x-forwarded-proto'] === 'https')) {
      return send(403, { error: '远端管理需要 HTTPS 连接' });
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600', 'Cache-Control': 'no-store' }); response.end(); return;
    }
    if (request.method !== 'POST') return send(405, { error: '管理接口只接受 POST 请求' });
    const key = request.socket.remoteAddress || '', now = clock();
    for (const [address, entry] of denied) if (now - entry.start >= 60000) denied.delete(address);
    const entry = denied.get(key);
    if (!authenticated(request.headers.authorization, config.token)) {
      if (entry?.count >= 10) { response.setHeader('Retry-After', '60'); return send(429, { error: '管理员验证失败次数过多，请稍后重试' }); }
      if (denied.size > 1000) denied.clear();
      denied.set(key, { start: entry?.start || now, count: (entry?.count || 0) + 1 });
      return send(401, { error: '管理员密钥不正确' });
    }
    denied.delete(key);
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) return send(415, { error: '需要 JSON 管理请求' });
    try {
      const message = await readBody(request), type = message.type;
      let result;
      if (monitorActions.has(type)) {
        if (type === 'save-settings' && (message.settings?.token || message.settings?.wechat && message.settings.wechat !== 'clawbot' || message.settings?.desktop)) {
          throw new Error('远端推送由服务器管理，请通过扫码添加微信接收人');
        }
        result = await monitor.admin(message);
      } else if (recipientActions.has(type)) {
        result = await hub.admin('/' + type, message.recipient || {});
        if (type === 'delete-recipient') await monitor.removeRecipients(result.deletedRecipientIds || [result.deletedId]);
      } else if (Object.hasOwn(loginActions, type)) {
        if (!login || typeof login[loginActions[type]] !== 'function') throw new Error('服务器微信扫码服务尚未配置');
        result = await login[loginActions[type]](message);
      } else if (type === 'test-notification') {
        if (message.channel !== 'clawbot') throw new Error('远端模式使用服务器微信通知');
        const state = await monitor.status(message.monitorId);
        const row = state.monitors.find(item => item.id === state.selectedId);
        if (!row?.recipientIds.length) throw new Error('请先选择微信接收人');
        const event = { id: `test-${randomUUID()}`, keyword: row.keyword, recipientIds: row.recipientIds,
          items: [{ title: '远端服务器微信连接测试，这不是商品上新', price: '', url: 'https://jp.mercari.com/search' }] };
        const formatted = messageFor(event, row.keyword);
        result = await hub.accept({ id: event.id, ...formatted, recipientIds: event.recipientIds });
      } else throw new Error('未知远端管理操作');
      return send(200, { ok: true, ...result });
    } catch (error) {
      const text = String(error.message || '');
      const safe = /管理|关键词|监控|接收人|用户|微信|队列|编号|请求|扫码|二维码|配对|配置|服务器|间隔|扫描|屏蔽|来源|时段|时间|定时/.test(text) &&
        !text.includes(config.token) && !/[a-z/\\]/i.test(text.replace(/\b(?:JSON|HTTP|HTTPS|ID)\b/g, ''));
      return send(error.status || 400, { error: safe ? String(error.message).slice(0, 400) : '服务器处理失败，请查看服务运行状态' });
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port ?? 17870, config.host || '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return { server, close: async () => { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); } };
}
