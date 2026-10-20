// Replay a COPY of a real queue using a fake sender; never contact WeChat.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createBridge } from "../bridge/service.mjs";
import { readJson, writeJson } from "../bridge/weixin.mjs";
const input = process.argv[2];
if (!input) throw new Error("Pass the queue JSON path to replay. The original is read only.");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mercari-replay-"));
if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error("Unexpected temporary directory");
let bridge; let sends = 0;
try {
  const snapshot = await readJson(input);
  const pendingBefore = snapshot.records.filter(item => !item.sourceIds && !item.doneAt && !item.skippedAt).length;
  const acceptedBefore = snapshot.records.filter(item => item.doneAt).length;
  if (process.argv.includes("--inspect")) {
    const queued = snapshot.records.filter(item => !item.doneAt && !item.skippedAt && !item.bundledInto);
    console.log(JSON.stringify({ inspectionOnly: true, pendingBefore, queuedSendUnits: queued.length,
      remainingChunks: queued.reduce((sum, item) => sum + Math.max(0, (item.chunks?.length || 0) - (item.nextChunk || 0)), 0) }));
  } else {
  for (const item of snapshot.records) if (!item.doneAt && !item.skippedAt) item.nextAttempt = 0;
  const stateFile = path.join(directory, "queue.json");
  await writeJson(stateFile, snapshot);
  bridge = await createBridge({ token: "a".repeat(64), stateFile, port: 0,
    status: async () => ({ contextReady: true }), send: async text => {
      if (Array.from(text).length > 2800) throw new Error("Replay exceeded the chunk limit");
      sends++;
    } });
  const deadline = Date.now() + 90000;
  let health;
  while ((health = await bridge.health()).pending && Date.now() < deadline) await delay(200);
  if (health.pending) throw new Error("Replay did not finish");
  console.log(JSON.stringify({ replayOnly: true, pendingBefore, fakeSendCalls: sends,
    newAcceptedBatches: health.accepted - acceptedBefore, remaining: health.pending }));
  }
} finally { if (bridge) await bridge.close(); await fs.rm(directory, { recursive: true, force: true }); }
