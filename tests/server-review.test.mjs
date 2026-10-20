import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMonitorService } from "../server/monitor.mjs";

test("shutdown waits for an already running outbox handoff and its final durable acknowledgment", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mercari-close-review-"));
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  let now = 1700000000000, newest = 1, block = false, entered, release;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const hub = {
    admin: async () => ({ recipients: [{ id: "owner", name: "接收人", enabled: true }] }),
    health: async () => ({ pending: 0, accepted: 0 }),
    accept: async () => {
      if (!block) throw new Error("relay temporarily unavailable");
      entered();
      await new Promise(resolve => { release = resolve; });
      return { accepted: true };
    }
  };
  const engine = await createMonitorService({ directory, hub, clock: () => now, autoSchedule: false, minRequestGapMs: 0,
    collector: async () => ({ items: Array.from({ length: 5 }, (_, i) => ({ url: `https://jp.mercari.com/item/m${newest + i}`, title: "商品" })) }) });
  t.after(async () => { release?.(); await engine.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const id = (await engine.admin({ type: "save-monitor", monitor: { keyword: "潔世一", scanCount: 5, recipientIds: ["owner"] } })).monitorId;
  await engine.tick(); await engine.waitIdle();
  now += 60000; newest = 2; await engine.tick(); await engine.waitIdle();
  assert.equal((await engine.status(id)).state.pending.length, 1);
  block = true; now += 60000;
  const draining = engine.drain(); await enteredPromise;
  let closed = false;
  const closing = engine.close().then(() => { closed = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(closed, false, "close must not return while a relay handoff can still write monitoring.json");
  } finally { release(); await Promise.all([draining, closing]); }
  const persisted = JSON.parse(await fs.readFile(path.join(directory, "monitoring.json"), "utf8"));
  assert.equal(persisted.states[id].pending.length, 0);
});
