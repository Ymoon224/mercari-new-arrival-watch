import path from 'node:path';
import { randomUUID } from 'node:crypto';
import '../extension/shared.js';
import { validateMonitor, duplicateKeyword, removeRecipientReferences, MAX_MONITORS } from '../extension/watches.js';
import { messageFor } from '../extension/notify.js';
import { readJson, writeJson } from '../bridge/weixin.mjs';

const W = globalThis.MercariWatch;
const idPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const notificationSettings = monitor => ({ ...monitor, desktop: false, wechat: 'clawbot' });

// Collection never holds the administration lock: pause can abort a request
// immediately, and a late result cannot overwrite the last successful window.
export async function createMonitorService({ directory, collector, hub, clock = Date.now,
  autoSchedule = true, minRequestGapMs = 5000, maxConcurrent = 1, collectionTimeoutMs = 45000 }) {
  if (typeof collector !== 'function' || !hub?.accept || !hub?.admin) throw new Error('采集服务配置不完整');
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 3 || !Number.isFinite(minRequestGapMs) || minRequestGapMs < 0) throw new Error('采集频率配置不正确');
  const file = path.join(directory, 'monitoring.json');
  let db = await readJson(file, { schemaVersion: 2, settings: { desktop: false, wechat: 'clawbot' }, monitors: [], states: {} });
  if (db.schemaVersion !== 2 || !Array.isArray(db.monitors) || db.monitors.length > MAX_MONITORS || !db.states ||
    new Set(db.monitors.map(m => m.id)).size !== db.monitors.length) throw new Error('服务器监控数据格式不正确，请保留原数据后检查');
  db = structuredClone(db);
  for (const monitor of db.monitors) {
    if (!idPattern.test(monitor.id || '')) throw new Error('服务器监控编号不正确');
    Object.assign(monitor, validateMonitor(monitor, monitor));
    const state = db.states[monitor.id];
    if (!state || state.keyword !== monitor.keyword || ['top', 'lastWindow', 'pending', 'events'].some(k => !Array.isArray(state[k]))) throw new Error('服务器监控基线不正确，请保留原数据后检查');
    state.run = null;
    delete state.seen; delete state.shopSeen; delete state.suppressedSimilar;
  }
  let chain = Promise.resolve(), stopped = false, tickTask, drainTask, closing, timer;
  let nextRequestAt = 0, storageError = '';
  const active = new Map(), runningTasks = new Set();
  const serial = fn => { const task = chain.then(fn); chain = task.catch(() => {}); return task; };
  async function commit(next) {
    try { await writeJson(file, next); db = next; storageError = ''; }
    catch { storageError = '服务器监控数据保存失败，请检查数据目录空间和权限'; throw new Error(storageError); }
  }
  await commit(db);
  const wake = () => { if (autoSchedule && !stopped) void tick().catch(() => {}); };
  function find(id) { const row = db.monitors.find(m => m.id === id); if (!row) throw new Error('此关键词已不存在，请刷新面板'); return row; }
  async function recipients() { return hub.admin('/recipients', {}); }
  async function ensureRecipients(ids) {
    const available = (await recipients()).recipients;
    if (ids.some(id => !available.some(row => row.id === id))) throw new Error('所选接收人已不存在，请重新选择');
  }
  function abort(id) { active.get(id)?.controller.abort(new Error('监控已暂停或设置已变化')); }

  async function finish(monitor, runId, result, error) {
    await serial(async () => {
      const current = db.monitors.find(m => m.id === monitor.id);
      if (stopped || !current?.enabled || db.states[monitor.id]?.run?.id !== runId) return;
      const next = structuredClone(db), previous = next.states[monitor.id];
      let state;
      if (error) {
        const message = /^(MERCARI_|COLLECTOR_)/.test(error.code || '') ? String(error.message).slice(0, 400) : 'HTTP 采集失败，请检查服务器网络或站点响应';
        state = W.recordFailure(previous, message, notificationSettings(current), clock());
        const backoff = Math.min(30 * 60000, 60000 * 2 ** Math.min(state.failures - 1, 5));
        state.nextCheckAt = clock() + Math.max(current.intervalMinutes * 60000, backoff, Math.min(Number(error.retryAfterMs) || 0, 24 * 3600000));
        if (error.requiresAttention) {
          next.monitors.find(m => m.id === monitor.id).enabled = false;
          state.lastError += '；已暂停该关键词，请处理后手动恢复';
        }
      } else {
        try {
          state = W.advance(previous, result.items, notificationSettings(current), clock()).state;
          state.source = String(result.source || 'http').slice(0, 120);
          state.ignoredAds = Number(result.ignoredAds) || 0;
          state.nextCheckAt = clock() + current.intervalMinutes * 60000;
        } catch (failure) {
          state = W.recordFailure(previous, failure, notificationSettings(current), clock());
          state.nextCheckAt = clock() + Math.max(current.intervalMinutes * 60000, Math.min(30 * 60000, 60000 * 2 ** Math.min(state.failures - 1, 5)));
        }
      }
      state.run = null; next.states[monitor.id] = state;
      await commit(next);
    });
  }

  async function launch(monitor, runId, controller) {
    let timeout;
    try {
      const deadline = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const error = Object.assign(new Error('HTTP 采集超时，上一轮结果已保留'), { code: 'COLLECTOR_TIMEOUT' });
          controller.abort(error); reject(error);
        }, collectionTimeoutMs);
      });
      const result = await Promise.race([collector(structuredClone(monitor), { signal: controller.signal }), deadline]);
      await finish(monitor, runId, result, null);
    } catch (error) { await finish(monitor, runId, null, error); }
    finally { clearTimeout(timeout); if (active.get(monitor.id)?.id === runId) active.delete(monitor.id); }
    await drain();
    wake();
  }

  function drain() {
    if (drainTask) return drainTask;
    if (stopped) return Promise.resolve();
    drainTask = (async () => {
      const candidates = await serial(() => db.monitors.flatMap(monitor => db.states[monitor.id].pending.map(event => ({ monitorId: monitor.id, event: structuredClone(event) })))
        .filter(({ event }) => !event.channels.clawbot && (event.nextDeliveryAt || 0) <= clock())
        .sort((a, b) => Number(b.event.type === 'monitor-error') - Number(a.event.type === 'monitor-error') || a.event.time - b.event.time).slice(0, 3));
      for (const candidate of candidates) {
        if (stopped) break;
        let delivered = false;
        try {
          const message = messageFor(candidate.event, candidate.event.keyword, { remote: true, timeZone: 'Asia/Shanghai' });
          const result = await hub.accept({ id: candidate.event.id, title: message.title, text: message.text, recipientIds: candidate.event.recipientIds || [] });
          delivered = result?.accepted === true;
        } catch { /* The durable controller outbox retains the original event ID. */ }
        await serial(async () => {
          const next = structuredClone(db), state = next.states[candidate.monitorId];
          const event = state?.pending.find(row => row.id === candidate.event.id);
          if (!event) return;
          if (delivered) state.pending = state.pending.filter(row => row.id !== event.id);
          else {
            event.attempts = (event.attempts || 0) + 1;
            event.lastError = '微信转发队列尚未接受消息，请检查接收人状态和服务器数据目录';
            event.nextDeliveryAt = clock() + Math.min(300000, 5000 * 2 ** Math.min(event.attempts, 6));
          }
          await commit(next);
        });
      }
    })().finally(() => { drainTask = null; });
    return drainTask;
  }

  function tick() {
    if (tickTask) return tickTask;
    if (stopped) return Promise.resolve();
    tickTask = (async () => {
      const started = await serial(async () => {
        if (stopped || active.size >= maxConcurrent || clock() < nextRequestAt) return null;
        const monitor = db.monitors.filter(m => m.enabled && !db.states[m.id].run && !active.has(m.id) && (db.states[m.id].nextCheckAt || 0) <= clock())
          .sort((a, b) => (db.states[a.id].nextCheckAt || 0) - (db.states[b.id].nextCheckAt || 0))[0];
        if (!monitor) return null;
        const next = structuredClone(db), state = next.states[monitor.id], runId = randomUUID();
        state.run = { id: runId, startedAt: clock() }; state.lastAttempt = clock();
        await commit(next);
        if (stopped) return null;
        const controller = new AbortController();
        active.set(monitor.id, { id: runId, controller, promise: null });
        nextRequestAt = clock() + minRequestGapMs;
        return { monitor: structuredClone(monitor), runId, controller };
      });
      if (started) {
        const task = launch(started.monitor, started.runId, started.controller).catch(() => {});
        runningTasks.add(task); void task.finally(() => runningTasks.delete(task));
        const runtime = active.get(started.monitor.id); if (runtime?.id === started.runId) runtime.promise = task;
      }
      await drain();
    })().finally(() => { tickTask = null; });
    return tickTask;
  }

  async function admin(message) {
    const type = message?.type;
    if (type === 'status') return status(message.monitorId);
    if (type === 'retry-wechat') { await serial(async () => { if (stopped) throw new Error('监控服务已停止'); const next = structuredClone(db); for (const state of Object.values(next.states)) for (const event of state.pending) event.nextDeliveryAt = 0; await commit(next); }); await drain(); return hub.retryPending(); }
    const result = await serial(async () => {
      if (stopped) throw new Error('监控服务已停止');
      const next = structuredClone(db);
      if (type === 'save-monitor') {
        const input = message.monitor || {}, old = input.id ? find(input.id) : null;
        if (!old && next.monitors.length >= MAX_MONITORS) throw new Error(`最多添加 ${MAX_MONITORS} 个关键词`);
        const monitor = validateMonitor({ ...input, recipientIds: input.recipientIds ?? old?.recipientIds ?? [] }, old || {});
        if (duplicateKeyword(next.monitors, monitor)) throw new Error('这些接收人已有相同关键词，请修改原任务');
        await ensureRecipients(monitor.recipientIds);
        const previous = old ? next.states[old.id] : null;
        if (old && old.keyword !== monitor.keyword && previous.pending.length) throw new Error('该关键词仍有待发消息，请先处理后再更改关键词');
        const state = !old || old.keyword !== monitor.keyword ? W.emptyState(monitor.keyword) : previous;
        const interrupted = old && (!monitor.enabled || old.keyword !== monitor.keyword || old.scanCount !== monitor.scanCount);
        if (interrupted) state.run = null;
        if (!old || old.keyword !== monitor.keyword || old.scanCount !== monitor.scanCount || !old.enabled && monitor.enabled) state.nextCheckAt = clock();
        else if (old.intervalMinutes !== monitor.intervalMinutes) state.nextCheckAt = (state.lastAttempt || clock()) + monitor.intervalMinutes * 60000;
        if (old) next.monitors = next.monitors.map(row => row.id === old.id ? monitor : row); else next.monitors.push(monitor);
        next.states[monitor.id] = state; await commit(next);
        if (interrupted) abort(monitor.id);
        return { ok: true, monitorId: monitor.id };
      }
      if (type === 'pause-all' || type === 'start-all') {
        for (const monitor of next.monitors) { monitor.enabled = type === 'start-all'; const state = next.states[monitor.id]; if (monitor.enabled) state.nextCheckAt = clock(); else state.run = null; }
        await commit(next); if (type === 'pause-all') for (const id of active.keys()) abort(id);
        return { ok: true };
      }
      if (type === 'save-settings') return { ok: true }; // Remote WeChat credentials are managed solely on the server.
      const monitor = find(message.monitorId), state = next.states[monitor.id];
      if (type === 'toggle') {
        const row = next.monitors.find(m => m.id === monitor.id); row.enabled = !row.enabled;
        if (row.enabled) state.nextCheckAt = clock(); else state.run = null;
        await commit(next); if (!row.enabled) abort(monitor.id); return { ok: true };
      }
      if (type === 'check') {
        if (!monitor.enabled) throw new Error('请先开始此关键词的监控');
        if (!state.run) state.nextCheckAt = clock(); await commit(next); return { ok: true };
      }
      if (type === 'clear-pending') { state.pending = []; await commit(next); return { ok: true }; }
      if (type === 'delete-monitor') {
        if (state.pending.length) throw new Error('该关键词仍有待发消息，请先处理队列');
        next.monitors = next.monitors.filter(m => m.id !== monitor.id); delete next.states[monitor.id]; await commit(next); abort(monitor.id); return { ok: true };
      }
      throw new Error('未知监控操作');
    });
    wake(); return result;
  }

  async function removeRecipients(ids) {
    await serial(async () => {
      if (stopped) return;
      const next = structuredClone(db), result = removeRecipientReferences(next, ids);
      if (result.changed) { await commit(next); for (const [id, runtime] of active) if (result.runs.some(run => run.id === runtime.id)) abort(id); }
    });
  }
  async function status(monitorId) {
    const recipientResult = await recipients();
    await removeRecipients(recipientResult.deletedRecipientIds || []);
    return serial(async () => {
      const monitor = db.monitors.find(row => row.id === monitorId) || db.monitors[0];
      const health = await hub.health();
      return { version: '2.0.0', executionMode: 'remote', settings: { desktop: false, wechat: 'clawbot', hasToken: true },
        recipients: recipientResult.recipients, recipientsError: recipientResult.cleanupWarnings?.map(row => row.message).join('；') || '',
        monitors: db.monitors.map(row => { const state = db.states[row.id]; return { ...row, running: Boolean(state.run), lastSuccess: state.lastSuccess,
          lastError: state.lastError, failures: state.failures, nextCheckAt: state.nextCheckAt, pendingCount: state.pending.length }; }),
        selectedId: monitor?.id || null, state: monitor ? structuredClone(db.states[monitor.id]) : null,
        bridge: { connected: true, ...health, error: String(health.healthError || health.lastError || health.lastPollError || health.lastSendError || '').slice(0, 400) },
        server: { collector: 'http', running: !stopped, activeRequests: active.size, storageError, minRequestGapMs, maxConcurrent } };
    });
  }
  if (autoSchedule) { timer = setInterval(wake, 1000); wake(); }
  return { admin, status, tick, drain, removeRecipients, waitIdle: async () => { await tickTask; await Promise.all([...runningTasks]); await drainTask; await chain; },
    close: () => closing ||= (async () => {
      stopped = true; clearInterval(timer); for (const id of active.keys()) abort(id);
      await tickTask; await Promise.all([...runningTasks]); await drainTask; await chain;
      await serial(async () => { const next = structuredClone(db); for (const state of Object.values(next.states)) state.run = null; await commit(next); });
    })() };
}
