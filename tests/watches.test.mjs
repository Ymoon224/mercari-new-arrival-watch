import test from "node:test";
import assert from "node:assert/strict";
import { migrate, validateMonitor, notificationSettings, duplicateKeyword, dueMonitors, removeRecipientReferences } from "../extension/watches.js";
const W = globalThis.MercariWatch;

test("upgrade removes historical suppression and preserves the last window, credentials and pending deliveries", () => {
  const state = W.emptyState("潔世一");
  state.seen = { "item:m123": 100 }; state.lastWindow = ["item:m456"]; state.initialized = true; state.lastAttempt = 1234;
  state.shopSeen = { legacy: 100 }; state.suppressedSimilar = 1;
  state.failures = 6; state.failureAlerted = true;
  state.pending = [{ id: "old-event", channels: { clawbot: false }, items: [] }];
  const saved = { settings: { ...W.defaults, keyword: "潔世一", scanCount: 5, desktop: false,
    wechat: "clawbot", token: "a".repeat(64), enabled: true }, state };
  const snapshot = structuredClone(saved);
  const converted = migrate(saved);
  assert.equal(converted.schemaVersion, 2);
  assert.deepEqual(converted.monitors[0], { id: "watch-legacy", keyword: "潔世一", scanCount: 5, enabled: true, intervalMinutes: 1, recipientIds: ["owner"], blockedWords: [] });
  assert.deepEqual(converted.settings, { desktop: false, wechat: "clawbot", token: "a".repeat(64) });
  assert.deepEqual(converted.states["watch-legacy"].lastWindow, state.lastWindow);
  for (const key of ["seen", "shopSeen", "suppressedSimilar"]) assert.equal(Object.hasOwn(converted.states["watch-legacy"], key), false);
  assert.deepEqual(converted.states["watch-legacy"].pending, state.pending);
  assert.equal(converted.states["watch-legacy"].failureAlerted, true);
  assert.equal(converted.states["watch-legacy"].nextCheckAt, 61234);
  assert.deepEqual(saved, snapshot);
  assert.deepEqual(migrate(converted), converted);
});
test("validates individual intervals and avoids equivalent duplicate keywords", () => {
  for (const value of [0, -1, 1.5, 1441, "no"]) assert.throws(() => validateMonitor({ keyword: "潔世一", intervalMinutes: value }), /检查间隔/);
  for (const value of [1, 5, 1440]) assert.equal(validateMonitor({ keyword: "潔世一", intervalMinutes: value }).intervalMinutes, value);
  const old = validateMonitor({ keyword: "ABC", intervalMinutes: 5 });
  assert.equal(duplicateKeyword([old], validateMonitor({ keyword: "ａｂｃ" })), true);
  assert.equal(duplicateKeyword([old], validateMonitor({ keyword: "ABC" }, old)), false);
  const settings = { desktop: false, wechat: "clawbot", token: "a".repeat(64) };
  assert.equal(notificationSettings({ wechat: "clawbot", token: "" }, settings).token, settings.token);
  assert.throws(() => notificationSettings({ wechat: "pushplus" }, settings), /token/);
});

test("a multi-keyword upgrade keeps the last window and pending channels while removing historical suppression", () => {
  const monitor = { ...validateMonitor({ keyword: "潔世一", scanCount: 5 }), dedupeSimilarShops: true };
  const state = W.advance(null, [1, 2, 3, 4, 5].map(id => ({ url: `/item/m${id}` })), { ...W.defaults, scanCount: 5 }, 1000).state;
  state.seen = { "item:m999": 500, "item:m1": 1000 }; state.shopSeen = { legacy: 500 };
  state.pending = [{ id: "old-event", recipientIds: ["owner"], channels: { desktop: true, clawbot: false } }];
  const saved = { schemaVersion: 2, settings: { desktop: true, wechat: "clawbot", token: "a".repeat(64) }, monitors: [monitor], states: { [monitor.id]: state } };
  const before = structuredClone(saved); const converted = migrate(saved); const nextState = converted.states[monitor.id];
  assert.deepEqual(saved, before);
  assert.equal(nextState.initialized, true);
  assert.deepEqual(nextState.lastWindow, state.lastWindow);
  assert.deepEqual(nextState.pending, state.pending);
  assert.equal(Object.hasOwn(converted.monitors[0], "dedupeSimilarShops"), false);
  assert.equal(Object.hasOwn(nextState, "seen"), false);
  const result = W.advance(nextState, [999, 1, 2, 3, 4].map(id => ({ url: `/item/m${id}` })), { ...W.defaults, scanCount: 5 }, 2000);
  assert.deepEqual(result.fresh.map(item => item.id), ["m999"]);
  assert.deepEqual(migrate(converted), converted);
});

test("simultaneous updates for different keywords cannot collide in the shared WeChat bridge", () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ url: "/item/m" + i }));
  const fresh = [{ url: "/item/m999" }, ...items.slice(0, 4)];
  const a = { ...W.defaults, keyword: "潔世一", scanCount: 5 };
  const b = { ...a, keyword: "凪誠士郎" };
  const baselineA = W.advance(null, items, a, 1000).state;
  const baselineB = W.advance(null, items, b, 1000).state;
  const eventA = W.advance(baselineA, fresh, a, 2000).state.events[0];
  const eventB = W.advance(baselineB, fresh, b, 2000).state.events[0];
  assert.notEqual(eventA.id, eventB.id);
  assert.equal(eventA.keyword, a.keyword);
  assert.equal(eventB.keyword, b.keyword);
});
test("only due enabled keywords run, with bounded concurrency and overdue keywords served first", () => {
  const monitors = Array.from({ length: 5 }, (_, i) => ({ id: "watch-" + i, enabled: true }));
  const states = Object.fromEntries(monitors.map((item, i) => [item.id, { nextCheckAt: i * 1000, run: null }]));
  const db = { monitors, states };
  states["watch-0"].run = { id: "running" };
  monitors[1].enabled = false;
  assert.deepEqual(dueMonitors(db, 10000).map(item => item.id), ["watch-2", "watch-3"]);
  assert.deepEqual(dueMonitors(db, 10000, ["watch-4"]).map(item => item.id), ["watch-4", "watch-2"]);
  states["watch-2"].run = {}; states["watch-3"].run = {};
  assert.deepEqual(dueMonitors(db, 10000), []);
});

test("the same keyword can have different recipients and intervals without duplicate delivery to overlapping users", () => {
  const owner = validateMonitor({ keyword: "潔世一", recipientIds: ["owner"], intervalMinutes: 1 });
  const bob = validateMonitor({ keyword: "潔世一", recipientIds: ["recipient-bob"], intervalMinutes: 5 });
  assert.equal(duplicateKeyword([owner], bob), false);
  assert.equal(duplicateKeyword([owner, bob], validateMonitor({ keyword: "潔世一", recipientIds: ["owner", "recipient-bob"] })), true);
  assert.throws(() => validateMonitor({ keyword: "x", recipientIds: ["../path"] }), /接收人/);
  assert.deepEqual(validateMonitor({ keyword: "x", recipientIds: ["owner", "owner"] }).recipientIds, ["owner"]);
});

test("notification recipients are frozen when found; changing monitor allocation never reroutes an older pending event", () => {
  const config = { ...W.defaults, keyword: "潔世一", scanCount: 5, wechat: "clawbot", desktop: false, recipientIds: ["owner"] };
  const make = n => ({ url: `/item/m${n}` });
  const first = W.advance(null, [1, 2, 3, 4, 5].map(make), config, 1000).state;
  const second = W.advance(first, [6, 1, 2, 3, 4].map(make), config, 2000).state;
  const third = W.advance(second, [7, 6, 1, 2, 3].map(make), { ...config, recipientIds: ["recipient-bob"] }, 3000).state;
  assert.deepEqual(third.pending.map(event => event.recipientIds), [["owner"], ["recipient-bob"]]);
  const historyOnly = W.advance(third, [8, 7, 6, 1, 2].map(make), { ...config, recipientIds: [] }, 4000).state;
  assert.equal(historyOnly.pending.length, 2);
});

test("deleting a recipient removes keyword allocations and pending targets without stopping other users or desktop delivery", () => {
  const makeState = keyword => ({ ...W.emptyState(keyword), run: { id: keyword } });
  const db = { settings: { desktop: false, wechat: "clawbot" }, monitors: [
    { id: "shared", recipientIds: ["owner", "bob"], enabled: true },
    { id: "bob-only", recipientIds: ["bob"], enabled: true }],
    states: { shared: makeState("shared"), "bob-only": makeState("bob-only") } };
  db.states.shared.pending = [{ recipientIds: ["owner", "bob"], channels: { clawbot: false } }];
  db.states["bob-only"].pending = [{ recipientIds: ["bob"], channels: { clawbot: false } }];
  const result = removeRecipientReferences(db, ["bob"]);
  assert.equal(result.changed, true); assert.equal(result.runs.length, 1);
  assert.deepEqual(db.monitors[0].recipientIds, ["owner"]); assert.equal(db.monitors[0].enabled, true);
  assert.deepEqual(db.states.shared.pending[0].recipientIds, ["owner"]);
  assert.equal(db.monitors[1].enabled, false); assert.equal(db.states["bob-only"].pending.length, 0);
  assert.equal(removeRecipientReferences(db, ["bob"]).changed, false);
});
