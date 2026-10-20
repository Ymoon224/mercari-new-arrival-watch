import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteApp } from '../server/app.mjs';

const token = 'A'.repeat(64), origin = 'chrome-extension://' + 'b'.repeat(32);
async function fixture(t, options = {}) {
  const calls = [];
  const monitor = { admin: async input => { calls.push(input); return { version: '2.0.0', executionMode: 'remote', monitors: [] }; }, removeRecipients: async ids => calls.push({ removed: ids }) };
  const hub = { admin: async (route, input) => { calls.push({ route, input }); return { recipients: [], deletedRecipientIds: ['bob'] }; } };
  const login = { start: async () => ({ id: 'safe-id', status: 'wait', qrUrl: 'https://weixin.qq.com/safe-qr', expiresAt: 1700000000000 }),
    status: async () => ({ id: 'safe-id', status: 'connected' }), cancel: async () => ({ status: 'cancelled' }), verify: async () => ({ status: 'wait' }) };
  const app = await createRemoteApp({ config: { token, host: '127.0.0.1', port: 0, allowedOrigins: [origin], ...options.config }, monitor, hub, login, ...options });
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = (body = { type: 'status' }, headers = {}) => fetch(url + '/api/admin', { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { app, calls, url, post, monitor };
}

test('remote health contains no configuration and every management request requires the administrator key', async t => {
  const f = await fixture(t);
  const health = await (await fetch(f.url + '/health')).json();
  assert.deepEqual(health, { ok: true, service: 'mercari-watch-remote', version: '2.0.0' });
  assert.equal((await f.post(undefined, { Authorization: '' })).status, 401);
  assert.equal((await f.post(undefined, { Origin: 'https://evil.test' })).status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.post()).status, 200); assert.equal(f.calls[0].type, 'status');
  assert.equal(JSON.stringify(health).includes(token), false);
  assert.equal((await fetch(f.url + '/setup')).status, 404, 'the old secret-embedding setup page is not published remotely');
});

test('HTTPS proxy trust is explicit, and production origins are denied unless configured', async t => {
  const f = await fixture(t, { config: { token, host: '127.0.0.1', port: 0, allowedOrigins: [], requireHttps: true, trustProxy: false } });
  assert.equal((await f.post(undefined, { Origin: 'https://evil.test', 'X-Forwarded-Proto': 'https' })).status, 403);
  assert.equal((await f.post(undefined, { Origin: origin, 'X-Forwarded-Proto': 'https' })).status, 403);
  const trusted = await fixture(t, { config: { token, host: '127.0.0.1', port: 0, allowedOrigins: [origin], requireHttps: true, trustProxy: true } });
  assert.equal((await trusted.post()).status, 403);
  assert.equal((await trusted.post(undefined, { 'X-Forwarded-Proto': 'https' })).status, 200);
});

test('remote management routes QR binding, verification and deletion without exposing login credentials', async t => {
  const f = await fixture(t);
  const qr = await (await f.post({ type: 'qr-start' })).json(); assert.equal(qr.status, 'wait');
  assert.equal((await (await f.post({ type: 'qr-verify', id: qr.id, code: '123456' })).json()).status, 'wait');
  assert.equal((await (await f.post({ type: 'qr-status', id: qr.id })).json()).status, 'connected');
  assert.equal((await f.post({ type: 'delete-recipient', recipient: { id: 'bob', confirmName: '朋友甲' } })).status, 200);
  assert.deepEqual(f.calls.at(-1), { removed: ['bob'] });
  assert.equal(JSON.stringify(qr).includes(token), false);
  for (const key of ['accountId', 'target', 'context_token', 'bot_token', 'qrcode']) assert.equal(Object.hasOwn(qr, key), false);
});

test('malformed, oversized and unexpected management requests cannot trigger server operations', async t => {
  const f = await fixture(t);
  assert.equal((await f.post({ type: 'unknown' })).status, 400);
  assert.equal((await f.post({ type: 'save-settings', settings: { token: 'do-not-store', wechat: 'pushplus' } })).status, 400);
  assert.equal((await f.post({ type: 'status', padding: 'x'.repeat(132000) })).status, 413);
  assert.equal((await f.post(undefined, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal(f.calls.length, 0);
});

test('authentication throttling does not lock out a valid administrator and unexpected errors hide credentials', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) assert.equal((await f.post(undefined, { Authorization: 'wrong' })).status, 401);
  assert.equal((await f.post(undefined, { Authorization: 'wrong' })).status, 429);
  assert.equal((await f.post()).status, 200);
  f.monitor.admin = async () => { throw new Error('微信异常 token=' + token); };
  const response = await (await f.post()).text(); assert.equal(response.includes(token), false); assert.equal(response.includes('token='), false);
});
