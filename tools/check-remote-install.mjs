// Verify the installed official SDK and an empty server in an isolated temporary
// data directory. Never starts QR login, contacts Mercari or sends a WeChat message.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { startRemoteServer } from '../server/main.mjs';

if (!process.env.MERCARI_PLUGIN_ROOT) throw new Error('请设置 MERCARI_PLUGIN_ROOT；此检查不会读取现有微信登录数据');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mercari-runtime-check-'));
if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unexpected validation directory');
let instance, outsideCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== '127.0.0.1') { outsideCalls++; return Promise.reject(new Error('Runtime check must not contact external services')); }
  return originalFetch(input, options);
};
try {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  instance = await startRemoteServer({ env: { MERCARI_DATA_DIR: directory, MERCARI_PLUGIN_ROOT: process.env.MERCARI_PLUGIN_ROOT, MERCARI_PORT: String(port) } });
  const base = `http://127.0.0.1:${port}`;
  const health = await (await fetch(base + '/health')).json();
  const response = await fetch(base + '/api/admin', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${instance.config.token}` }, body: JSON.stringify({ type: 'status' }) });
  const status = await response.json();
  if (health.version !== '2.0.0' || response.status !== 200 || status.executionMode !== 'remote' || status.monitors.length || status.recipients.length || outsideCalls) throw new Error('Isolated server validation failed');
  console.log(JSON.stringify({ ok: true, version: health.version, officialSdkLoaded: true, authenticatedAdminReady: true, emptyRecipientsReady: true, externalRequests: outsideCalls, realQrOrWeChatMessagesSent: false, mercariCollectionValidated: false }));
} finally {
  await instance?.close(); globalThis.fetch = originalFetch;
  await fs.rm(directory, { recursive: true, force: true });
}
