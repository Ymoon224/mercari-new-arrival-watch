#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeReceipt } from '../bridge/receipts.mjs';

const time = value => Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : null;
const load = async (file, fallback) => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
};

// Read only the controller and queue files. Never open administrator secrets,
// WeChat account credentials or context files; never initiate any network call.
export async function inspectDeliveries({ dataDir, productIds = [], messageIds = [], limit = 10 }) {
  if (!path.isAbsolute(dataDir || '') || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid diagnostic options');
  const db = await load(path.join(dataDir, 'monitoring.json'));
  const events = Object.values(db.states || {}).flatMap(state => state.events || []);
  const eventById = new Map(events.map(event => [event.id, event]));
  const wanted = new Set(messageIds);
  const productSet = new Set(productIds);
  for (const event of events) if (event.items?.some(item => productSet.has(item.id))) wanted.add(event.id);
  const files = [path.join(dataDir, 'bridge', 'deliveries.json')];
  const queueDir = path.join(dataDir, 'bridge', 'queues');
  for (const file of await fs.readdir(queueDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (/^[\w-]+\.json$/.test(file)) files.push(path.join(queueDir, file));
  }
  const filtered = productIds.length > 0 || messageIds.length > 0;
  const rows = [];
  for (const [queueIndex, file] of files.entries()) {
    const queue = await load(file, { records: [] });
    if (!Array.isArray(queue.records)) throw new Error('Invalid queue');
    const byId = new Map(queue.records.map(record => [record.id, record]));
    for (const record of queue.records) {
      if (record.sourceIds || filtered && !wanted.has(record.id)) continue;
      const sent = record.bundledInto ? byId.get(record.bundledInto) : record;
      const receipts = (sent?.sendReceipts || []).map(value => {
        const receipt = sanitizeReceipt(value);
        return receipt ? { ...receipt, acceptedAt: time(receipt.acceptedAt), chunkIndex: Number.isSafeInteger(value.chunkIndex) ? value.chunkIndex : null } : null;
      }).filter(Boolean);
      const event = eventById.get(record.id);
      rows.push({
        order: record.createdAt || 0,
        queue: queueIndex + 1, messageId: record.id,
        productIds: event?.items?.map(item => item.id) || [],
        discoveredAt: time(event?.time), recipientCountWhenFound: event?.recipientIds?.length ?? null,
        queuedAt: time(record.createdAt), apiAcceptedAt: time(record.doneAt),
        state: record.doneAt ? 'api-accepted-client-delivery-unconfirmed' : record.skippedAt ? 'skipped' : 'pending',
        bundleId: record.bundledInto || null, bundleBatchCount: sent?.sourceIds?.length || 0,
        attempts: record.attempts || 0,
        errorCode: /^WEIXIN_[A-Z_]+$/.test(record.errorCode || '') ? record.errorCode : '',
        receiptRecord: receipts.length ? 'recorded' : record.doneAt ? 'not-recorded' : 'not-yet-recorded',
        receipts
      });
    }
  }
  rows.sort((a, b) => b.order - a.order);
  const discoveries = events.filter(event => wanted.has(event.id)).map(event => ({
    messageId: event.id, discoveredAt: time(event.time), recipientCountWhenFound: event.recipientIds?.length ?? null
  }));
  return { timeZone: 'Asia/Shanghai', checkedAt: time(Date.now()),
    meaning: 'API acceptance and returned message IDs do not confirm phone delivery. Missing IDs do not by themselves prove failure.',
    historyNote: 'Product lookups use the retained discovery history; older deliveries may require their message ID.',
    requestedProductIds: productIds, requestedMessageIds: messageIds, discoveries,
    totalMatches: rows.length, deliveries: rows.slice(0, limit).map(({ order, ...row }) => row) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = { dataDir: process.env.MERCARI_DATA_DIR || '/var/lib/mercari-watch', productIds: [], messageIds: [], limit: 10 };
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
      console.log('Usage: node tools/inspect-wechat-delivery.mjs [--data-dir ABSOLUTE_DIR] [--limit 1..50] [--product-id m123] [--message-id new-...]');
      console.log('Read-only diagnostic; no network, messages, credential export or queue changes.');
    } else {
      for (let i = 0; i < args.length; i++) {
        const flag = args[i], value = args[++i];
        if (!value) throw new Error('Missing option');
        if (flag === '--data-dir') options.dataDir = value;
        else if (flag === '--limit') options.limit = Number(value);
        else if (flag === '--product-id' && /^(?:m\d+|[A-Za-z0-9]{10,32})$/.test(value)) options.productIds.push(value);
        else if (flag === '--message-id' && /^[\w:.-]{1,200}$/.test(value)) options.messageIds.push(value);
        else throw new Error('Invalid option');
      }
      console.log(JSON.stringify(await inspectDeliveries(options), null, 2));
    }
  } catch {
    console.error('无法读取投递诊断，请检查参数、数据目录和读取权限；不会输出凭证或发送消息。');
    process.exitCode = 1;
  }
}
