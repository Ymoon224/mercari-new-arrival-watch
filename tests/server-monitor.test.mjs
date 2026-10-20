import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMonitorService } from '../server/monitor.mjs';

const products = (...ids) => ids.map(id => ({ url: `https://jp.mercari.com/item/m${id}`, title: `商品 ${id}`, price: '¥500' }));
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mercari-server-test-'));
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  let now = 1700000000000, sample = products(1, 2, 3, 4, 5), failure, failAck = false;
  const requests = [], accepted = new Map(), recipients = [{ id: 'owner', name: '我的微信', enabled: true }];
  const hub = {
    admin: async route => { assert.equal(route, '/recipients'); return { ok: true, recipients }; },
    health: async () => ({ contextReady: true, pending: accepted.size, accepted: 0 }),
    retryPending: async () => ({ ok: true, accepted: true, pending: accepted.size }),
    accept: async message => { if (!accepted.has(message.id)) accepted.set(message.id, message); if (failAck) { failAck = false; throw new Error('acknowledgment lost'); } return { accepted: true }; }
  };
  const collector = options.collector || (async (monitor, { signal }) => { requests.push({ monitor, signal }); if (failure) throw failure; return { items: sample, source: 'http-api', ignoredAds: 2 }; });
  const instances = [];
  const start = async () => {
    const engine = await createMonitorService({ directory, collector, hub, clock: () => now, autoSchedule: false, minRequestGapMs: 0, ...options });
    instances.push(engine); return engine;
  };
  t.after(async () => { for (const instance of instances) await instance.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const engine = await start();
  const add = async (keyword = '潔世一', extra = {}) => (await engine.admin({ type: 'save-monitor', monitor: { keyword, scanCount: 5, intervalMinutes: 1, enabled: true, recipientIds: ['owner'], ...extra } })).monitorId;
  const collect = async (instance = engine) => { await instance.tick(); await instance.waitIdle(); };
  return { engine, start, add, collect, hub, accepted, requests, directory, recipients,
    time: value => { now = value; }, advance: value => { now += value; }, sample: value => { sample = value; }, failure: value => { failure = value; }, loseNextAck: () => { failAck = true; } };
}

test('server alone schedules independent keywords, silently baselines and delivers new IDs without a browser', async t => {
  const f = await fixture(t);
  const a = await f.add(); const b = await f.add('凪誠士郎', { intervalMinutes: 5 });
  await f.collect(); await f.collect(); assert.equal(f.requests.length, 2); assert.equal(f.accepted.size, 0);
  f.advance(60000); f.sample(products(9, 1, 2, 3, 4)); await f.collect();
  assert.equal(f.requests.length, 3); assert.equal(f.requests.at(-1).monitor.id, a);
  assert.equal(f.accepted.size, 1); assert.ok([...f.accepted.values()][0].text.includes('/item/m9'));
  assert.deepEqual((await f.engine.status(b)).state.lastWindow, ['item:m1', 'item:m2', 'item:m3', 'item:m4', 'item:m5']);
  assert.equal((await f.engine.status(a)).state.source, 'http-api');
});

test('pausing aborts the in-flight request, ignores its late result and makes no further Mercari requests', async t => {
  const pending = [];
  const f = await fixture(t, { collector: async (monitor, { signal }) => new Promise(resolve => pending.push({ monitor, signal, resolve })) });
  const id = await f.add(); await f.engine.tick(); assert.equal(pending.length, 1);
  await f.engine.admin({ type: 'toggle', monitorId: id });
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve({ items: products(1, 2, 3, 4, 5) }); await f.engine.waitIdle();
  f.advance(3600000); await f.collect();
  assert.equal(pending.length, 1); assert.equal((await f.engine.status(id)).state.initialized, false);
  assert.equal(f.accepted.size, 0);
});

test('pause-all and the global request gap prevent queued keywords from making requests until resumed', async t => {
  const f = await fixture(t, { minRequestGapMs: 5000 });
  await f.add(); await f.add('凪誠士郎');
  await f.collect(); await f.collect(); assert.equal(f.requests.length, 1);
  await f.engine.admin({ type: 'pause-all' }); f.advance(600000); await f.collect(); assert.equal(f.requests.length, 1);
  assert.ok((await f.engine.status()).monitors.every(row => !row.enabled));
  await f.engine.admin({ type: 'start-all' }); await f.collect(); assert.equal(f.requests.length, 2);
  f.advance(5000); await f.collect(); assert.equal(f.requests.length, 3);
});

test('server restart preserves the last window and never replays a first baseline or successful message', async t => {
  const f = await fixture(t); const id = await f.add(); await f.collect();
  f.advance(60000); f.sample(products(9, 1, 2, 3, 4)); await f.collect(); assert.equal(f.accepted.size, 1);
  await f.engine.close(); const restarted = await f.start();
  f.advance(60000); await f.collect(restarted); assert.equal(f.accepted.size, 1);
  const state = (await restarted.status(id)).state; assert.equal(state.initialized, true); assert.equal(state.lastWindow[0], 'item:m9');
  f.advance(60000); f.sample(products(5, 9, 1, 2, 3)); await f.collect(restarted);
  assert.equal(f.accepted.size, 2, 'a returning listing is a new event under previous-round comparison');
});

test('lost relay acknowledgment retries the same durable event ID across a restart', async t => {
  const f = await fixture(t); const id = await f.add(); await f.collect();
  f.advance(60000); f.sample(products(9, 1, 2, 3, 4)); f.loseNextAck(); await f.collect();
  const eventId = (await f.engine.status(id)).state.pending[0].id;
  assert.equal(f.accepted.size, 1); await f.engine.close();
  const restarted = await f.start(); f.advance(600000); await restarted.drain();
  assert.equal((await restarted.status(id)).state.pending.length, 0); assert.equal(f.accepted.size, 1);
  assert.equal([...f.accepted.keys()][0], eventId);
});

test('blocked titles stay in the comparison window but do not generate notifications', async t => {
  const f = await fixture(t); const id = await f.add('潔世一', { blockedWords: ['不要'] }); await f.collect();
  f.advance(60000); f.sample([{ ...products(9)[0], title: '不要的商品' }, ...products(1, 2, 3, 4)]); await f.collect();
  assert.equal(f.accepted.size, 0); assert.equal((await f.engine.status(id)).state.lastWindow[0], 'item:m9');
  f.advance(60000); f.sample(products(10, 9, 1, 2, 3)); await f.collect(); assert.equal(f.accepted.size, 1);
  assert.ok([...f.accepted.values()][0].text.includes('/item/m10'));
});

test('six failed collections alert once, preserve the baseline, and back off without requests before due', async t => {
  const f = await fixture(t); const id = await f.add(); await f.collect();
  f.failure(Object.assign(new Error('服务器 HTTP 响应异常'), { code: 'MERCARI_HTTP_ERROR' }));
  for (let i = 0; i < 6; i++) {
    const due = (await f.engine.status(id)).monitors[0].nextCheckAt; f.time(due); await f.collect();
    const count = f.requests.length; await f.collect(); assert.equal(f.requests.length, count);
  }
  const status = await f.engine.status(id);
  assert.equal(status.state.failures, 6); assert.equal(f.accepted.size, 1);
  assert.ok([...f.accepted.values()][0].title.includes('监控连续异常 6 次'));
  assert.deepEqual(status.state.lastWindow, ['item:m1', 'item:m2', 'item:m3', 'item:m4', 'item:m5']);
});

test('an access challenge requiring attention pauses requests until an explicit administrator resume', async t => {
  const f = await fixture(t); const id = await f.add();
  f.failure(Object.assign(new Error('需要人工处理页面验证'), { code: 'MERCARI_CHALLENGE', requiresAttention: true }));
  await f.collect(); const status = await f.engine.status(id); assert.equal(status.monitors[0].enabled, false);
  f.advance(86400000); await f.collect(); assert.equal(f.requests.length, 1);
  f.failure(null); await f.engine.admin({ type: 'toggle', monitorId: id }); await f.collect(); assert.equal(f.requests.length, 2);
});

test('removing a recipient updates shared tasks without rerouting or stopping other users', async t => {
  const f = await fixture(t); f.recipients.push({ id: 'bob', name: '朋友甲' });
  const id = await f.add('潔世一', { recipientIds: ['owner', 'bob'] }); await f.collect();
  await f.engine.removeRecipients(['bob']);
  const status = await f.engine.status(id); assert.deepEqual(status.monitors[0].recipientIds, ['owner']); assert.equal(status.monitors[0].enabled, true);
  await f.engine.removeRecipients(['owner']); assert.equal((await f.engine.status(id)).monitors[0].enabled, false);
});
