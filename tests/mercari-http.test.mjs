import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { createMercariCollector, createAnonymousProof, buildSearchRequest, parseSearchResponse,
  MercariCollectorError, MERCARI_SEARCH_ENDPOINT } from "../server/mercari-http.mjs";

// Synthetic protocol fixtures. They are not recordings or proof of live access.
const item = (id, more = {}) => ({ id: `m${id}`, name: `商品 ${id}`, price: "500", itemType: "ITEM_TYPE_MERCARI", ...more });
const shop = (id, more = {}) => ({ id, name: "タイトルにキーワードがない商品", price: "7135", itemType: "ITEM_TYPE_BEYOND", ...more });
const monitor = { keyword: "潔世一", scanCount: 5 };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
const five = () => Array.from({ length: 5 }, (_, i) => item(100 + i));

test("Mercari HTTP: normal anonymous DPoP is valid ES256, bound to method/URL, with stable device and fresh jti", () => {
  const proof = createAnonymousProof({ now: () => 1700000000000 });
  const token = proof.token(MERCARI_SEARCH_ENDPOINT, "POST");
  const [head, body, signature] = token.split(".");
  const header = JSON.parse(Buffer.from(head, "base64url"));
  const payload = JSON.parse(Buffer.from(body, "base64url"));
  assert.equal(header.typ, "dpop+jwt");
  assert.equal(header.alg, "ES256");
  assert.equal(header.jwk.crv, "P-256");
  assert.equal(header.jwk.d, undefined);
  assert.equal(payload.htu, MERCARI_SEARCH_ENDPOINT);
  assert.equal(payload.htm, "POST");
  assert.equal(payload.iat, 1700000000);
  assert.equal(payload.uuid, proof.deviceId);
  assert.equal(verify("sha256", Buffer.from(`${head}.${body}`), {
    key: createPublicKey({ key: header.jwk, format: "jwk" }), dsaEncoding: "ieee-p1363"
  }, Buffer.from(signature, "base64url")), true);
  const second = JSON.parse(Buffer.from(proof.token(MERCARI_SEARCH_ENDPOINT).split(".")[1], "base64url"));
  assert.notEqual(second.jti, payload.jti);
  assert.equal(second.uuid, payload.uuid);
});

test("Mercari HTTP: POST uses latest-first web protocol, not any browser or user authentication", async () => {
  const calls = [];
  const collect = createMercariCollector({ now: () => 1700000000000, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return json({ items: [item(1), shop("2JYMfJdf5VodgVWoRiL9HM"), item(2), item(3), item(4)], components: [] });
  } });
  const result = await collect(monitor);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, MERCARI_SEARCH_ENDPOINT);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].init.headers.Cookie, undefined);
  assert.match(calls[0].init.headers.DPoP, /^[\w-]+\.[\w-]+\.[\w-]+$/);
  const request = JSON.parse(calls[0].init.body);
  assert.equal(request.searchCondition.keyword, "潔世一");
  assert.equal(request.searchCondition.sort, "SORT_CREATED_TIME");
  assert.equal(request.searchCondition.order, "ORDER_DESC");
  assert.equal(request.pageSize, 120);
  assert.equal(request.userId, "");
  assert.equal(request.source, "BaseSerp");
  assert.equal(request.laplaceDeviceUuid, "");
  assert.equal(result.observedAt, 1700000000000);
  assert.deepEqual(result.items.map(i => i.id), ["m1", "2JYMfJdf5VodgVWoRiL9HM", "m2", "m3", "m4"]);
  assert.equal(result.items[1].type, "product");
  assert.equal(result.items[1].price, "¥7,135");
  // Matching remains Mercari's search scope; no title-contains-keyword filter.
  assert.equal(result.items[1].title, "タイトルにキーワードがない商品");
});

test("Mercari HTTP: excludes promoted items and never mixes component ads/recommendations into ordered results", () => {
  const parsed = parseSearchResponse({ items: [
    item(1), item(2, { adType: "AD_TYPE_MERCARI_C2C" }),
    item(3, { url: "https://jp.mercari.com/item/m3?ad_id=abc" }),
    item(4, { isPromoted: true }), item(5, { clickEvent: { eventData: { adId: "id" } } }),
    item(6, { promotions: [{ type: "DISCOUNT" }] }),
    shop("2JWXY4bD3f97JZ5u7U68aR")
  ], components: [{ ads: { items: [item(999)] } }, { productSuggest: { items: [item(888)] } }] });
  assert.equal(parsed.ignoredAds, 4);
  assert.deepEqual(parsed.items.map(i => i.id), ["m1", "m6", "2JWXY4bD3f97JZ5u7U68aR"]);
  assert.deepEqual(parsed.items.map(i => i.position), [0, 5, 6]);
});

test("Mercari HTTP: validates organic schema and identity rather than guessing from arbitrary JSON", () => {
  for (const body of [[], { data: { items: five() } }, { products: five() },
    { items: [{ ...item(1), itemType: "NEW_UNKNOWN_TYPE" }] },
    { items: [item(1, { id: "2JWXY4bD3f97JZ5u7U68aR" })] },
    { items: [item(1, { price: "oops" })] }, { items: [item(1, { name: "" })] },
    { items: [item(1, { url: "https://evil.example/item/m1" })] },
    { items: [item(1, { url: "/item/m2" })] },
    { items: five(), meta: { nextPageToken: {} } }, { items: five(), components: {} },
    { items: five(), errors: [{ code: "blocked" }] }]) {
    assert.throws(() => parseSearchResponse(body), error => error.code === "MERCARI_SCHEMA");
  }
});

test("Mercari HTTP: paginates conservatively and preserves first occurrence order after ads and duplicate IDs", async () => {
  const calls = [];
  const collect = createMercariCollector({ pageGapMs: 0, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    if (!body.pageToken) return json({ items: [item(1), item(2), item(50, { promoted: true })], meta: { nextPageToken: "next" } });
    return json({ items: [item(2), item(3), item(4), item(5)] });
  } });
  const result = await collect(monitor);
  assert.equal(result.ignoredAds, 1);
  assert.equal(calls[0].searchSessionId, calls[1].searchSessionId);
  assert.equal(calls[1].pageToken, "next");
  assert.deepEqual(result.items.map(i => i.id), ["m1", "m2", "m3", "m4", "m5"]);
});

test("Mercari HTTP: no false success on empty/partial results, looping page cursor, or exhausted page budget", async () => {
  for (const body of [{ items: [] }, { items: [item(1)] }, { items: [item(1)], meta: { nextPageToken: "loop" } }]) {
    let calls = 0;
    const collect = createMercariCollector({ maxPages: 2, pageGapMs: 0, fetchImpl: async () => { calls++; return json(body); } });
    await assert.rejects(collect(monitor), error => error.code === "MERCARI_INSUFFICIENT_RESULTS");
    assert.ok(calls <= 2);
  }
});

test("Mercari HTTP: a CAPTCHA/SPA HTML response and access denial fail closed without another request", async () => {
  for (const [response, code] of [
    [new Response("<html>Verify CAPTCHA</html>", { headers: { "content-type": "text/html" } }), "MERCARI_UNEXPECTED_CONTENT"],
    [new Response("access denied", { status: 403 }), "MERCARI_ACCESS_DENIED"],
    [new Response("unauthenticated", { status: 401 }), "MERCARI_ACCESS_DENIED"],
    [new Response("redirect", { status: 302 }), "MERCARI_HTTP"],
    [new Response("service unavailable", { status: 503 }), "MERCARI_HTTP"]
  ]) {
    let calls = 0;
    const collect = createMercariCollector({ fetchImpl: async () => { calls++; return response; } });
    await assert.rejects(collect(monitor), error => error.code === code && (code === "MERCARI_HTTP" || error.requiresAttention === true));
    assert.equal(calls, 1);
  }
});

test("Mercari HTTP: HTTP 429 preserves Retry-After and does not automatically retry", async () => {
  let calls = 0;
  const collect = createMercariCollector({ fetchImpl: async () => { calls++; return json({}, 429, { "retry-after": "120" }); } });
  await assert.rejects(collect(monitor), error => error.code === "MERCARI_RATE_LIMITED" && error.retryAfterMs === 120000);
  assert.equal(calls, 1);
});

test("Mercari HTTP: cancellation prevents requests and aborts an in-flight fetch", async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const collect = createMercariCollector({ fetchImpl: async () => { calls++; return json({ items: five() }); } });
  await assert.rejects(collect(monitor, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 0);
  const active = new AbortController();
  const wait = createMercariCollector({ fetchImpl: async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    active.abort();
  }) });
  await assert.rejects(wait(monitor, { signal: active.signal }), { name: "AbortError" });
});

test("Mercari HTTP: corrupt/oversized JSON cannot produce partial valid-looking results", async () => {
  for (const body of ["{", JSON.stringify({ items: five() })]) {
    const collect = createMercariCollector({ maxResponseBytes: 50, fetchImpl: async () => new Response(body, { headers: { "content-type": "application/json" } }) });
    await assert.rejects(collect(monitor), error => error instanceof MercariCollectorError && error.code === "MERCARI_SCHEMA");
  }
});

test("Mercari HTTP: pause cancels a page-delay before the next network request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const collect = createMercariCollector({ pageGapMs: 1000, fetchImpl: async () => {
    calls++;
    setTimeout(() => controller.abort(), 10);
    return json({ items: [item(1)], meta: { nextPageToken: "next" } });
  } });
  await assert.rejects(collect(monitor, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("Mercari HTTP: concurrent keywords and pagination share one cancellable HTTP start gate", async () => {
  const starts = [];
  const controller = new AbortController();
  const collect = createMercariCollector({ pageGapMs: 35, fetchImpl: async (_url, init) => {
    const request = JSON.parse(init.body);
    starts.push({ time: performance.now(), keyword: request.searchCondition.keyword, pageToken: request.pageToken });
    if (request.searchCondition.keyword === "paginated" && !request.pageToken) {
      return json({ items: [item(1)], meta: { nextPageToken: "next" } });
    }
    return json({ items: five() });
  } });
  const first = collect({ ...monitor, keyword: "paginated" });
  const cancelled = collect({ ...monitor, keyword: "cancelled" }, { signal: controller.signal });
  const second = collect({ ...monitor, keyword: "second" });
  const cancelCheck = assert.rejects(cancelled, { name: "AbortError" });
  controller.abort();
  await Promise.all([first, second, cancelCheck]);
  assert.equal(starts.length, 3);
  assert.equal(starts.some(start => start.keyword === "cancelled"), false);
  assert.equal(starts.filter(start => start.keyword === "paginated").length, 2);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i].time - starts[i - 1].time >= 28, "actual fetch starts must respect the shared gap");
});

test("Mercari HTTP: interrupted response stream is a retryable network failure, not a schema pause", async () => {
  const stream = new ReadableStream({ start(controller) { controller.error(new Error("socket closed")); } });
  const collect = createMercariCollector({ fetchImpl: async () => new Response(stream, { headers: { "content-type": "application/json" } }) });
  await assert.rejects(collect(monitor), error => error.code === "MERCARI_NETWORK" && error.requiresAttention === false);
});

test("Mercari HTTP: rejects unsupported scan counts and never calls the network", async () => {
  const collect = createMercariCollector({ fetchImpl: () => { throw new Error("must not fetch"); } });
  await assert.rejects(collect({ keyword: "", scanCount: 5 }), TypeError);
  await assert.rejects(collect({ keyword: "x", scanCount: 6 }), TypeError);
  const request = buildSearchRequest("x");
  assert.equal(request.searchCondition.status.length, 0);
});
