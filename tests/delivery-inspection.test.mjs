import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inspectDeliveries } from '../tools/inspect-wechat-delivery.mjs';
import { receiptFromResponse } from '../bridge/receipts.mjs';

test('inspection traces bundle receipts to original discoveries and exports no credentials, message text or raw response', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mercari-receipts-'));
  assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const secret = 'PRIVATE-DO-NOT-EXPORT';
  await fs.mkdir(path.join(dir, 'bridge', 'queues'), { recursive: true });
  await fs.writeFile(path.join(dir, 'admin-token'), secret);
  await fs.writeFile(path.join(dir, 'monitoring.json'), JSON.stringify({ states: { test: { events: [
    { id: 'new-a', time: 1700000000000, recipientIds: ['r'], items: [{ id: 'm123', title: secret }] },
    { id: 'new-old', time: 1699999990000, recipientIds: ['r'], items: [{ id: 'm124' }] }
  ] } } }));
  await fs.writeFile(path.join(dir, 'bridge', 'queues', 'r.json'), JSON.stringify({ token: secret, records: [
    { id: 'new-old', createdAt: 1699999990000, doneAt: 1699999991000, hash: secret },
    { id: 'new-a', createdAt: 1700000000000, doneAt: 1700000001000, bundledInto: 'bundle-a', chunks: [secret] },
    { id: 'bundle-a', createdAt: 1700000000500, doneAt: 1700000001000, sourceIds: ['new-a'],
      sendReceipts: [{ ...receiptFromResponse({ ret: 0, message_id: '123456789', token: secret }, 'client-a', 1700000001000), chunkIndex: 0, rawResponse: secret }] }
  ] }));
  const before = await fs.readFile(path.join(dir, 'bridge', 'queues', 'r.json'), 'utf8');
  const result = await inspectDeliveries({ dataDir: dir, productIds: ['m123'] });
  assert.equal(result.totalMatches, 1); assert.equal(result.deliveries[0].bundleId, 'bundle-a');
  assert.equal(result.deliveries[0].receipts[0].serverMessageId, '123456789');
  assert.equal(result.deliveries[0].state, 'api-accepted-client-delivery-unconfirmed');
  assert.equal(result.deliveries[0].receiptRecord, 'recorded');
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(await fs.readFile(path.join(dir, 'bridge', 'queues', 'r.json'), 'utf8'), before, 'inspection must not mutate a queue');
  const old = await inspectDeliveries({ dataDir: dir, messageIds: ['new-old'] });
  assert.equal(old.deliveries[0].receiptRecord, 'not-recorded');
  assert.deepEqual(old.deliveries[0].receipts, []);
  const unavailable = await inspectDeliveries({ dataDir: dir, productIds: ['m999'] });
  assert.equal(unavailable.totalMatches, 0);
  assert.equal(unavailable.deliveries.length, 0, 'an unmatched product must not silently return unrelated recent messages');
});

test('receipt sanitization distinguishes absent and malformed IDs without persisting arbitrary response values', () => {
  const invalid = receiptFromResponse({ ret: 0, message_id: 'private-token', errcode: 0 }, 'client', 1700000000000);
  assert.equal(invalid.serverMessageIdStatus, 'invalid'); assert.equal(invalid.serverMessageId, null);
  const absent = receiptFromResponse({}, 'client', 1700000000000);
  assert.equal(absent.ret, null); assert.equal(absent.errcode, null); assert.equal(absent.serverMessageIdStatus, 'missing');
  const imprecise = receiptFromResponse({ message_id: Number.MAX_SAFE_INTEGER + 1 }, 'client', 1700000000000);
  assert.equal(imprecise.serverMessageIdStatus, 'invalid');
});
