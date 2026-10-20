import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import { readJson, writeJson, createWeixin } from "./weixin.mjs";
import { createBridge, createEndpoint, notification } from "./service.mjs";

export const OWNER = "owner";
export const MAX_RECIPIENTS = 20;
export const REMOVAL_NOTICE = "上新提醒服务已停用。管理员已将你移出接收列表，后续不再发送商品提醒。如需恢复，请联系管理员。";
const tokenHash = token => token ? createHash("sha256").update(token).digest("hex") : "";
const validId = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
export function recipientIds(input) {
  const ids = input === undefined ? [OWNER] : input;
  if (!Array.isArray(ids) || ids.length > MAX_RECIPIENTS || ids.some(id => !validId(id))) throw new Error("接收人选择不正确");
  return [...new Set(ids)];
}

// This registry has no chat-command entry point. Only the authenticated local
// administrator can import accounts, rename recipients, or pause delivery.
export async function createRecipientHub({ config, directory, port = config.port, transportFactory = createWeixin, queueFactory = createBridge }) {
  const registryFile = path.join(directory, "recipients.json");
  let registry = await readJson(registryFile, null);
  if (registry === null) {
    registry = { schemaVersion: 1, recipients: [{ id: OWNER, accountId: config.accountId,
      target: config.target, name: "我的微信", enabled: true }] };
    await writeJson(registryFile, registry);
  }
  registry.deleted ??= [];
  if (!Array.isArray(registry.deleted) || registry.deleted.some(row => !validId(row.id) || !validId(row.accountId) || !row.target || !Number.isFinite(row.deletedAt))) throw new Error("已删除接收人记录不正确，请保留原文件后检查");
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.recipients) || registry.recipients.length > MAX_RECIPIENTS ||
      registry.recipients.some(row => !validId(row.id) || !validId(row.accountId) || typeof row.target !== "string" || !row.target ||
        typeof row.enabled !== "boolean" || typeof row.name !== "string" || !row.name.trim() || row.name.length > 40) ||
      new Set(registry.recipients.map(row => row.id)).size !== registry.recipients.length ||
      new Set(registry.recipients.map(row => row.accountId)).size !== registry.recipients.length ||
      new Set(registry.recipients.map(row => row.target)).size !== registry.recipients.length ||
      ![...registry.recipients, ...registry.deleted].some(row => row.id === OWNER && row.accountId === config.accountId && row.target === config.target)) {
    throw new Error("接收人配置不正确，请保留原文件后检查");
  }
  const runtimes = new Map(); const controller = new AbortController();
  let chain = Promise.resolve(); let stopped = false;
  const exclusive = fn => { const task = chain.then(fn); chain = task.catch(() => {}); return task; };
  function queueFile(row) { return row.id === OWNER ? path.join(directory, "deliveries.json") : path.join(directory, "queues", `${row.id}.json`); }
  function rowById(id) { return registry.recipients.find(row => row.id === id); }
  const deletedIds = () => registry.deleted.map(row => row.id);
  async function commit(next) { await writeJson(registryFile, next); registry = next; }
  async function updateDeletion(id, patch) {
    await commit({ ...registry, deleted: registry.deleted.map(row => row.id === id ? { ...row, ...patch } : row) });
  }
  async function start(row) {
    const stateFile = queueFile(row);
    const transport = await transportFactory({ ...config, accountId: row.accountId, target: row.target, deliveryFile: stateFile });
    const status = async () => {
      const health = await transport.status();
      return rowById(row.id)?.enabled ? health : { ...health, disabled: true, needsInteraction: true, contextReady: false };
    };
    const queue = await queueFactory({ token: config.token, stateFile, send: transport.send, status, listen: false });
    const localController = new AbortController();
    const polling = transport.monitor(AbortSignal.any([controller.signal, localController.signal]));
    runtimes.set(row.id, { queue, transport, polling, controller: localController });
  }
  try { for (const row of registry.recipients) await start(row); }
  catch (error) { controller.abort(); await Promise.allSettled([...runtimes.values()].map(runtime => runtime.queue.close())); throw error; }
  async function list() {
    return Promise.all(registry.recipients.map(async row => {
      const health = await runtimes.get(row.id).queue.health();
      return { id: row.id, name: row.name, enabled: row.enabled, isDefault: row.id === OWNER,
        pending: health.pending, accepted: health.accepted, suppressed: health.suppressed,
        contextReady: health.contextReady, needsInteraction: health.needsInteraction,
        needsLogin: health.needsLogin, quotaReached: health.quotaReached,
        verified: health.verified, sessionAccepted: health.sessionAccepted, sessionMessageLimit: health.sessionMessageLimit,
        error: health.healthError || health.lastError || health.lastSendError || health.lastPollError || "" };
    }));
  }
  async function health() {
    const rows = await list(); const enabled = rows.filter(row => row.enabled);
    const blocked = enabled.filter(row => row.pending && (row.needsInteraction || row.needsLogin || row.error));
    const sum = key => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
    return { ok: true, service: "mercari-weixin-bridge", version: "1.3.2", multiRecipient: true,
      recipientCount: rows.length, blockedCount: blocked.length,
      contextReady: enabled.some(row => row.contextReady), needsInteraction: blocked.some(row => row.needsInteraction),
      needsLogin: blocked.some(row => row.needsLogin), quotaReached: blocked.some(row => row.quotaReached),
      verified: enabled.some(row => row.verified), pending: sum("pending"), accepted: sum("accepted"), delivered: sum("accepted"), suppressed: sum("suppressed"),
      lastError: blocked.length ? `${blocked.length} 位接收人待恢复：${blocked[0].error || "请在各自微信给 ClawBot 发一条新消息"}` : "" };
  }
  async function accept(input) {
    return exclusive(async () => {
      notification(input);
      const intended = recipientIds(input.recipientIds);
      if (!intended.length) throw new Error("消息未指定微信接收人");
      const ids = intended.filter(id => !deletedIds().includes(id));
      // Deleted recipients are durably revoked. A stale extension cannot revive
      // them or prevent a shared notification from reaching the remaining users.
      if (ids.some(id => !rowById(id) || !runtimes.has(id))) throw new Error("接收人不存在，请在本机管理面板重新选择");
      const results = [];
      for (const id of ids) results.push(await runtimes.get(id).queue.accept(input));
      return { ok: true, accepted: true, recipients: ids.length, removedRecipients: intended.length - ids.length,
        duplicate: results.every(result => result.duplicate), discarded: ids.length === 0 };
    });
  }
  async function syncAccounts() {
    const ids = await readJson(path.join(config.stateDir, "openclaw-weixin/accounts.json"), []);
    if (!Array.isArray(ids) || ids.some(id => !validId(id))) throw new Error("微信账号列表不正确");
    const additions = [];
    for (const accountId of ids) {
      if (registry.recipients.some(row => row.accountId === accountId)) continue;
      const account = await readJson(path.join(config.stateDir, "openclaw-weixin/accounts", `${accountId}.json`), {});
      if (!account.token || !account.userId) continue;
      if (registry.deleted.some(row => row.accountId === accountId && row.credentialHash === tokenHash(account.token))) continue;
      if ([...registry.recipients, ...additions].some(row => row.target === account.userId)) throw new Error("同一微信用户有重复登录，请先处理旧账号，再同步接收人");
      if (registry.recipients.length + additions.length >= MAX_RECIPIENTS) throw new Error(`最多支持 ${MAX_RECIPIENTS} 位接收人`);
      additions.push({ id: `recipient-${randomUUID()}`, accountId, target: account.userId, name: `接收人 ${registry.recipients.length + additions.length + 1}`, enabled: true });
    }
    const next = { ...registry, recipients: [...registry.recipients, ...additions] };
    // New queues stay paused until the registry has been durably committed.
    try {
      for (const row of additions) await start(row);
      await writeJson(registryFile, next); registry = next;
    } catch (error) {
      for (const row of additions) {
        const runtime = runtimes.get(row.id); if (!runtime) continue;
        runtime.controller.abort(); await runtime.queue.close(); await runtime.polling; runtimes.delete(row.id);
      }
      throw error;
    }
    return { ok: true, recipients: await list(), deletedRecipientIds: deletedIds(), imported: additions.length };
  }
  async function cleanupDeleted(row, runtime) {
    if (runtime) {
      runtime.controller.abort(); await runtime.queue.close(); await runtime.polling; runtimes.delete(row.id);
    }
    let noticeState = row.noticeState || "not-requested";
    // An optional notice is attempted only by the delete request itself. A crash
    // must never cause an unsolicited duplicate notice during startup recovery.
    if (runtime && row.notifyBeforeDelete && noticeState === "pending") {
      await updateDeletion(row.id, { noticeState: "attempting" });
      try { await runtime.transport.send(REMOVAL_NOTICE, `removed-${tokenHash(`${row.id}:${row.deletedAt}`).slice(0, 32)}`, { renewalReminder: false }); noticeState = "accepted"; }
      catch { noticeState = "failed"; }
    } else if (["pending", "attempting"].includes(noticeState)) noticeState = "unknown";
    let disconnect = { remoteStopped: false, localCredentialsRemoved: false };
    let cleanupError = "";
    try {
      const current = await readJson(path.join(config.stateDir, "openclaw-weixin/accounts", `${row.accountId}.json`), {});
      if (current.token && tokenHash(current.token) !== row.credentialHash) {
        // Never erase a later, independently authorized QR login while recovering
        // an older deletion. It still needs explicit import and keyword allocation.
        disconnect = { remoteStopped: false, localCredentialsRemoved: true };
      } else {
        const transport = runtime?.transport || await transportFactory({ ...config, accountId: row.accountId, target: row.target, deliveryFile: queueFile(row) });
        disconnect = await transport.disconnect({ notifyRemote: Boolean(runtime) });
      }
      if (!disconnect.localCredentialsRemoved) cleanupError = "本机登录信息尚未完全清理，请重启转发服务后重试";
    } catch { cleanupError = "本机登录信息清理失败，推送资格已撤销，请重启转发服务后重试"; }
    try {
      const source = path.resolve(queueFile(row));
      const destination = path.resolve(directory, "deleted-queues", `${row.id}-${row.deletedAt}.json`);
      const root = path.resolve(directory);
      for (const target of [source, destination]) {
        const relative = path.relative(root, target);
        if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("Invalid queue archive path");
      }
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(source, destination);
    } catch (error) { if (error.code !== "ENOENT") cleanupError ||= "队列归档未完成，推送资格已撤销，请检查 D 盘空间后重启服务"; }
    await updateDeletion(row.id, { noticeState, remoteStopped: Boolean(disconnect.remoteStopped),
      localCredentialsRemoved: Boolean(disconnect.localCredentialsRemoved), cleanupError, cleanupPending: Boolean(cleanupError) });
    return { noticeState, remoteStopped: Boolean(disconnect.remoteStopped), localCredentialsRemoved: Boolean(disconnect.localCredentialsRemoved), cleanupWarning: cleanupError };
  }
  // Recover an interrupted deletion before accepting any new requests. Revoked
  // rows are never started as receiving accounts, even if credential cleanup fails.
  for (const row of [...registry.deleted]) if (row.cleanupPending) await cleanupDeleted(row);
  const responseList = async extra => ({ ok: true, recipients: await list(), deletedRecipientIds: deletedIds(),
    cleanupWarnings: registry.deleted.filter(row => row.cleanupPending).map(row => ({ id: row.id, name: row.name, message: row.cleanupError || "推送资格已撤销，本机登录清理待完成" })), ...extra });
  async function admin(route, input) {
    return exclusive(async () => {
      if (stopped) throw new Error("接收人服务已停止");
      if (route === "/recipients") return responseList({});
      if (route === "/sync-recipients") return syncAccounts();
      if (route === "/save-recipient") {
        const row = rowById(input.id);
        if (!row) throw new Error("接收人不存在");
        const name = String(input.name ?? row.name).trim();
        if (!name || name.length > 40) throw new Error("接收人备注需为 1–40 个字符");
        if (input.enabled != null && typeof input.enabled !== "boolean") throw new Error("接收人启用状态不正确");
        const next = { ...registry, recipients: registry.recipients.map(item => item.id === row.id ? { ...item, name, enabled: input.enabled ?? row.enabled } : item) };
        await writeJson(registryFile, next); registry = next;
        if (input.enabled === true) await runtimes.get(row.id).queue.retryPending();
        return responseList({});
      }
      if (route === "/delete-recipient") {
        const row = rowById(input.id);
        if (!row) {
          const deleted = registry.deleted.find(item => item.id === input.id);
          if (deleted) return responseList({ deletedId: deleted.id, noticeState: deleted.noticeState, cleanupWarning: deleted.cleanupError || "" });
          throw new Error("接收人不存在");
        }
        if (input.confirmName !== row.name) throw new Error("接收人备注已变化，请重新确认要删除的用户");
        if (input.notifyBeforeDelete != null && typeof input.notifyBeforeDelete !== "boolean") throw new Error("删除通知选项不正确");
        const account = await readJson(path.join(config.stateDir, "openclaw-weixin/accounts", `${row.accountId}.json`), {});
        const deleted = { ...row, deletedAt: Date.now(), credentialHash: tokenHash(account.token), cleanupPending: true,
          notifyBeforeDelete: input.notifyBeforeDelete === true, noticeState: input.notifyBeforeDelete ? "pending" : "not-requested" };
        // Revoke and persist first. Subsequent retries, startup and stale clients
        // all see the tombstone even if cleanup or optional notice delivery fails.
        await commit({ ...registry, recipients: registry.recipients.filter(item => item.id !== row.id), deleted: [...registry.deleted, deleted] });
        const result = await cleanupDeleted(deleted, runtimes.get(row.id));
        return responseList({ deletedId: row.id, ...result });
      }
      throw new Error("未知接收人操作");
    });
  }
  const retryPending = async () => {
    const results = await Promise.all([...runtimes.values()].map(runtime => runtime.queue.retryPending()));
    return { ok: true, accepted: true, pending: results.reduce((total, result) => total + result.pending, 0) };
  };
  let server;
  try { server = await createEndpoint({ token: config.token, accept, health, retryPending, admin, port }); }
  catch (error) {
    controller.abort(); await Promise.allSettled([...runtimes.values()].map(async runtime => { await runtime.queue.close(); await runtime.polling; })); throw error;
  }
  return { server, accept, health, admin, retryPending, close: async () => {
    stopped = true; controller.abort(); await new Promise(resolve => server.close(resolve)); await chain;
    await Promise.all([...runtimes.values()].map(async runtime => { await runtime.queue.close(); await runtime.polling; }));
  } };
}
