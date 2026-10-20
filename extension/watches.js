import "./shared.js";
const W = globalThis.MercariWatch;
export const MAX_MONITORS = 20;
export const MAX_ACTIVE = 3;
export const ALARM = "mercari-scheduler";

export function validateMonitor(input, old = {}) {
  const keyword = String(input.keyword ?? old.keyword ?? "").trim();
  if (!keyword || keyword.length > 100) throw new Error("关键词需为 1–100 个字符");
  const scanCount = Number(input.scanCount ?? old.scanCount ?? 20);
  if (![5, 20, 50, 100].includes(scanCount)) throw new Error("扫描数量不正确");
  const intervalMinutes = Number(input.intervalMinutes ?? old.intervalMinutes ?? 1);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) throw new Error("检查间隔需为 1–1440 的整数，单位为分钟");
  const recipientIds = input.recipientIds ?? old.recipientIds ?? ["owner"];
  if (!Array.isArray(recipientIds) || recipientIds.length > 20 || recipientIds.some(id => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id))) throw new Error("微信接收人选择不正确");
  const blockedWords = input.blockedWords ?? old.blockedWords ?? [];
  if (!Array.isArray(blockedWords) || blockedWords.length > 100 || blockedWords.some(word => typeof word !== "string" || !word.trim() || word.trim().length > 100)) throw new Error("屏蔽词最多 100 个，每个需为 1–100 个字符");
  return { id: old.id || `watch-${crypto.randomUUID()}`, keyword, scanCount, intervalMinutes,
    blockedWords: [...new Set(blockedWords.map(word => word.trim()))],
    recipientIds: [...new Set(recipientIds)],
    enabled: Boolean(input.enabled ?? old.enabled ?? true) };
}
export function duplicateKeyword(monitors, candidate) {
  const key = text => text.normalize("NFKC").toLowerCase();
  return monitors.some(item => item.id !== candidate.id && key(item.keyword) === key(candidate.keyword) &&
    (item.recipientIds || ["owner"]).some(id => (candidate.recipientIds || ["owner"]).includes(id)));
}
export function notificationSettings(input, old = W.defaults) {
  const next = W.validateSettings({ ...input, desktop: input.desktop ?? old.desktop,
    keyword: W.defaults.keyword, scanCount: W.defaults.scanCount }, { ...W.defaults, ...old });
  return { desktop: next.desktop, wechat: next.wechat, token: next.token };
}
export function settingsFor(db, monitor) { return { ...db.settings, ...monitor, monitorId: monitor.id }; }
function removeLegacyDedup(db) {
  for (const monitor of db.monitors) delete monitor.dedupeSimilarShops;
  for (const state of Object.values(db.states)) {
    if (!state.lastWindow?.length && state.initialized) state.lastWindow = state.top.map(item => item.key);
    delete state.seen; delete state.shopSeen; delete state.suppressedSimilar;
  }
  return db;
}
export function migrate(saved) {
  if (saved.schemaVersion === 2) return removeLegacyDedup(structuredClone({ schemaVersion: 2, settings: saved.settings,
    monitors: saved.monitors, states: saved.states }));
  const old = { ...W.defaults, ...saved.settings };
  const monitor = validateMonitor({ ...old, intervalMinutes: 1 }, { id: "watch-legacy" });
  const state = saved.state?.keyword === monitor.keyword ? structuredClone(saved.state) : W.emptyState(monitor.keyword);
  state.nextCheckAt = state.lastAttempt == null ? null : state.lastAttempt + 60000;
  return removeLegacyDedup({ schemaVersion: 2, settings: { desktop: old.desktop, wechat: old.wechat, token: old.token },
    monitors: [monitor], states: { [monitor.id]: state } });
}
export function dueMonitors(db, now, forceIds = []) {
  const slots = Math.max(0, MAX_ACTIVE - db.monitors.filter(item => db.states[item.id]?.run).length);
  return db.monitors.filter(item => item.enabled && !db.states[item.id].run &&
    (forceIds.includes(item.id) || (db.states[item.id].nextCheckAt || 0) <= now))
    .sort((a, b) => Number(forceIds.includes(b.id)) - Number(forceIds.includes(a.id)) ||
      (db.states[a.id].nextCheckAt || 0) - (db.states[b.id].nextCheckAt || 0)).slice(0, slots);
}

export function removeRecipientReferences(db, ids) {
  const removed = new Set(ids || []); const runs = []; let changed = false;
  for (const monitor of db.monitors) {
    const current = monitor.recipientIds || ["owner"];
    const remaining = current.filter(id => !removed.has(id));
    if (remaining.length !== current.length) {
      monitor.recipientIds = remaining; changed = true;
      if (!remaining.length && !db.settings.desktop && db.settings.wechat === "clawbot") {
        monitor.enabled = false;
        const state = db.states[monitor.id]; if (state.run) runs.push(state.run); state.run = null;
      }
    }
    const state = db.states[monitor.id];
    for (const event of state.pending) {
      if (!Object.hasOwn(event.channels, "clawbot")) continue;
      const intended = event.recipientIds || ["owner"];
      const kept = intended.filter(id => !removed.has(id));
      if (kept.length === intended.length) continue;
      event.recipientIds = kept; changed = true;
      if (!kept.length) event.channels.clawbot = true;
    }
    const before = state.pending.length;
    state.pending = state.pending.filter(event => !Object.values(event.channels).every(Boolean));
    if (state.pending.length !== before) changed = true;
  }
  return { changed, runs };
}
