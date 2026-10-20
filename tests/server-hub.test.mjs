import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRecipientHub } from '../bridge/recipients.mjs';
import { writeJson } from '../bridge/weixin.mjs';

test('a fresh remote hub starts without a phantom owner or legacy listener and imports a QR-bound account without sending', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercari-empty-hub-'));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  const config = { token: 'A'.repeat(64), stateDir: path.join(root, 'weixin'), accountId: '', target: '' };
  const sent = [], hubs = [];
  const transportFactory = async () => ({
    status: async () => ({ contextReady: true }), send: async (text, id) => sent.push({ text, id }),
    monitor: signal => signal.aborted ? Promise.resolve() : new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  });
  const start = async () => { const hub = await createRecipientHub({ config, directory: path.join(root, 'bridge'), listen: false, allowEmpty: true, transportFactory }); hubs.push(hub); return hub; };
  t.after(async () => { for (const hub of hubs) await hub.close(); await fs.rm(root, { recursive: true, force: true }); });
  const hub = await start(); assert.equal(hub.server, null); assert.equal((await hub.health()).recipientCount, 0);
  assert.deepEqual((await hub.admin('/recipients', {})).recipients, []);
  await writeJson(path.join(config.stateDir, 'openclaw-weixin/accounts.json'), ['test-bot']);
  await writeJson(path.join(config.stateDir, 'openclaw-weixin/accounts/test-bot.json'), { token: 'fake-login', userId: 'test@im.wechat' });
  const result = await hub.admin('/sync-recipients', {});
  assert.equal(result.imported, 1); assert.equal(result.recipients.length, 1); assert.equal(sent.length, 0);
  assert.notEqual(result.recipients[0].id, 'owner');
  await hub.accept({ id: 'new-remote', title: '关键词：发现上新', text: '商品 ¥500\nhttps://jp.mercari.com/item/m1', recipientIds: [result.recipients[0].id] });
  for (let i = 0; i < 60 && (await hub.health()).pending; i++) await delay(20);
  assert.equal(sent.length, 1); assert.equal((await hub.health()).accepted, 1);
  await hub.close(); const restarted = await start();
  assert.equal((await restarted.health()).accepted, 1); assert.equal(sent.length, 1);
});
