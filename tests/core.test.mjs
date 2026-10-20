import test from "node:test";
import assert from "node:assert/strict";
import "../extension/shared.js";
const W = globalThis.MercariWatch;
const settings = { ...W.defaults, scanCount: 5 };
const make = id => ({ url: `https://jp.mercari.com/item/m${id}`, title: `商品 ${id}`, price: "¥500" });
const items = (...ids) => ids.map(make);
const baseline = () => W.advance(W.emptyState(settings.keyword), items(1, 2, 3, 4, 5), settings, 1000).state;

test("recognizes personal and Shops IDs and separates their types", () => {
  assert.equal(W.parseProduct("/item/m30876823983").key, "item:m30876823983");
  assert.equal(W.parseProduct("/shops/product/2JWXY4bD3f97JZ5u7U68aR").key, "product:2JWXY4bD3f97JZ5u7U68aR");
  assert.equal(W.parseProduct("https://evil.test/item/m30876823983"), null);
  assert.equal(W.parseProduct("/user/profile/12345"), null);
});
test("removes promoted URLs even with empty tracking values", () => {
  for (const param of ["ad_id", "ad_auction_id", "ad_auction_unit_id"]) {
    assert.equal(W.parseProduct(`/item/m1?${param}=`).promoted, true);
    assert.equal(W.normalizeItems([{ url: `/item/m1?${param}=` }]).length, 0);
  }
});
test("deduplicates and excludes ad data while keeping ordinary occurrence", () => {
  assert.deepEqual(W.normalizeItems([...items(1, 1), { ...make(2), adType: "AD_TYPE_MERCARI_C2C" }, make(3)]).map(i => i.id), ["m1", "m3"]);
});
test("first sample establishes all scanned IDs silently", () => {
  const result = W.advance(null, items(1, 2, 3, 4, 5), settings, 1000);
  assert.equal(result.baseline, true);
  assert.equal(result.fresh.length, 0);
  assert.equal(result.state.pending.length, 0);
  assert.deepEqual(result.state.lastWindow, items(1, 2, 3, 4, 5).map(item => W.parseProduct(item.url).key));
  assert.equal(Object.hasOwn(result.state, "seen"), false);
});
test("unchanged set or reorder never sends notification", () => {
  const state = baseline();
  const result = W.advance(state, items(5, 2, 3, 1, 4), settings, 2000);
  assert.equal(result.fresh.length, 0);
  assert.equal(result.topChanged, false);
  assert.deepEqual(result.state.top, state.top);
});
test("new prefix results notify only new IDs", () => {
  const result = W.advance(baseline(), items(6, 7, 1, 2, 3), settings, 2000);
  assert.deepEqual(result.fresh.map(i => i.id), ["m6", "m7"]);
  assert.equal(result.state.pending.length, 1);
  assert.deepEqual(result.state.pending[0].channels, { desktop: false });
});
test("a listing newly entering at the tail is included in the previous-round comparison", () => {
  const result = W.advance(baseline(), items(1, 3, 4, 5, 6), settings, 2000);
  assert.deepEqual(result.fresh.map(item => item.id), ["m6"]);
  assert.equal(result.state.lastWindow.includes("item:m6"), true);
});
test("unknown inserted inside overlapping window can be detected", () => {
  const result = W.advance(baseline(), items(1, 8, 2, 3, 4), settings, 2000);
  assert.deepEqual(result.fresh.map(i => i.id), ["m8"]);
});
test("a listing absent from the previous round notifies again when it returns", () => {
  const second = W.advance(baseline(), items(6, 7, 1, 2, 3), settings, 2000).state;
  const third = W.advance(second, items(4, 6, 7, 1, 2), settings, 3000);
  assert.deepEqual(third.fresh.map(item => item.id), ["m4"]);
});
test("no overlap produces visible gap warning", () => {
  const result = W.advance(baseline(), items(6, 7, 8, 9, 10), settings, 2000);
  assert.equal(result.gap, true);
  assert.equal(result.fresh.length, 5);
  assert.ok(result.state.warning);
});
test("bad or incomplete samples cannot mutate previous baseline", () => {
  const state = baseline(); const snapshot = structuredClone(state);
  assert.throws(() => W.advance(state, items(1, 2), settings), /旧状态/);
  assert.throws(() => W.advance(state, [{ ...make(8), id: "m9" }], settings), /不一致/);
  assert.deepEqual(state, snapshot);
});
test("scans beyond top five, keeps five in panel", () => {
  const config = { ...settings, scanCount: 20 };
  const first = W.advance(null, Array.from({ length: 20 }, (_, i) => make(i + 1)), config, 1000).state;
  const result = W.advance(first, Array.from({ length: 20 }, (_, i) => make(100 + i)), config, 2000);
  assert.equal(result.fresh.length, 20); assert.equal(result.state.top.length, 5);
});
test("retains independent pending channel delivery flags across samples", () => {
  const config = { ...settings, wechat: "serverchan" };
  const second = W.advance(baseline(), items(6, 1, 2, 3, 4), config, 2000).state;
  second.pending[0].channels.desktop = true;
  const third = W.advance(second, items(6, 1, 2, 3, 4), config, 3000).state;
  assert.deepEqual(third.pending[0].channels, { desktop: true, serverchan: false });
});
test("validates tokens locally and does not silently reuse a different provider's key", () => {
  const old = { ...settings, wechat: "serverchan", token: "SCT123456789" };
  assert.equal(W.validateSettings({ ...old, token: "" }, old).token, old.token);
  assert.throws(() => W.validateSettings({ ...settings, desktop: false, wechat: "none" }), /至少/);
  assert.throws(() => W.validateSettings({ ...settings, wechat: "pushplus" }, old), /token/);
});

test("outage alert starts at the sixth consecutive failure and leaves product history unchanged", () => {
  const config = { ...settings, wechat: "clawbot" };
  const original = baseline();
  let state = original;
  for (let i = 1; i <= 5; i++) state = W.recordFailure(state, "搜索页加载失败", config, 2000 + i);
  assert.equal(state.failures, 5);
  assert.equal(state.pending.length, 0);
  assert.deepEqual(original, baseline());
  state = W.recordFailure(state, "搜索页加载失败", config, 3000);
  assert.equal(state.failures, 6);
  assert.equal(state.failureAlerted, true);
  assert.equal(state.pending.length, 1);
  const alert = state.pending[0];
  assert.equal(alert.type, "monitor-error");
  assert.equal(alert.failures, 6);
  assert.deepEqual(alert.channels, { desktop: false, clawbot: false });
  assert.deepEqual(state.top, original.top);
  assert.deepEqual(state.lastWindow, original.lastWindow);
  assert.equal(state.events.length, 0);
  const again = W.recordFailure(state, "仍未加载", config, 4000);
  assert.equal(again.pending.length, 1);
  assert.equal(again.pending[0].id, alert.id);
  assert.equal(again.pending[0].error, "搜索页加载失败");
});

test("successful collection resets an outage episode and a later outage can alert again", () => {
  let state = baseline();
  for (let i = 0; i < 6; i++) state = W.recordFailure(state, "断网", settings, 2000 + i);
  const firstId = state.pending[0].id;
  const persisted = JSON.parse(JSON.stringify(state));
  state = W.recordFailure(persisted, "仍断网", settings, 3000);
  assert.equal(state.pending.length, 1);
  state = W.advance(state, items(1, 2, 3, 4, 5), settings, 4000).state;
  assert.equal(state.failures, 0);
  assert.equal(state.failureAlerted, false);
  assert.equal(state.failureStartedAt, null);
  for (let i = 0; i < 6; i++) state = W.recordFailure(state, "再次断网", settings, 5000 + i);
  assert.equal(state.pending.length, 2);
  assert.notEqual(state.pending[0].id, firstId);
  assert.equal(state.pending[1].id, firstId);
});

test("upgrading a saved failure count still queues exactly one outage alert", () => {
  const legacy = baseline();
  legacy.failures = 8;
  delete legacy.failureAlerted;
  delete legacy.failureStartedAt;
  const state = W.recordFailure(legacy, "超时", settings, 5000);
  assert.equal(state.failures, 9);
  assert.equal(state.pending.length, 1);
  assert.equal(W.recordFailure(state, "超时", settings, 6000).pending.length, 1);
});

const shop = (id, title = "ブルーロック 潔世一 ジャケット", price = "¥7,975") => ({
  url: `https://jp.mercari.com/shops/product/${id.padEnd(20, "x")}`, title, price
});
test("Shop replacements with identical title/price notify for every new ID, including across reloads", () => {
  const first = W.advance(null, [shop("first"), ...items(1, 2, 3, 4)], settings, 1000).state;
  const second = W.advance(JSON.parse(JSON.stringify(first)), [shop("second"), ...items(1, 2, 3, 4)], settings, 2000);
  assert.deepEqual(second.fresh.map(item => item.id), ["second".padEnd(20, "x")]);
  assert.equal(Object.hasOwn(second.state, "shopSeen"), false);
  const third = W.advance(second.state, [shop("third"), shop("fourth"), ...items(1, 2, 3)], settings, 3000);
  assert.equal(third.fresh.length, 2);
});
test("a continuously present listing remains silent regardless of elapsed time or price changes", () => {
  const original = [shop("first"), ...items(1, 2, 3, 4)];
  const first = W.advance(null, original, settings, 1000).state;
  const next = [shop("first", "変更後の商品", "¥7,000"), ...items(1, 2, 3, 4)];
  assert.equal(W.advance(first, next, settings, 8 * 86400000).fresh.length, 0);
});
test("legacy ID and Shop content histories cannot block a returning item or a matching Shop listing", () => {
  const first = baseline();
  first.events.push({ time: 1000, items: [shop("first")] });
  first.seen = { "item:m99": 1000 };
  first.shopSeen = { legacy: 1000 };
  first.suppressedSimilar = 1;
  const next = W.advance(first, [make(99), shop("second"), ...items(1, 2, 3)], { ...settings, dedupeSimilarShops: true }, 2000);
  assert.equal(next.fresh.length, 2);
  for (const key of ["seen", "shopSeen", "suppressedSimilar"]) assert.equal(Object.hasOwn(next.state, key), false);
  const personal = [make(99), make(98)].map(item => ({ ...item, title: "同じ商品", price: "¥500" }));
  assert.equal(W.advance(first, [...personal, ...items(1, 2, 3)], settings, 2000).fresh.length, 2);
});
