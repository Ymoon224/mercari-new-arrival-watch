import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// These are the ordinary anonymous web client's protocol, not a browser or a
// CAPTCHA/anti-bot workaround. Current source evidence (2026-10-20):
// https://web-jp-assets-v2.mercdn.net/_next/static/chunks/51988-f24e3872a8515a77.js
//   modules 15762 / 37800: /v2/entities:search, BaseSerp, search context.
// .../11634-fe8645bdae6fa2c3.js, module 81621: request builder.
// .../15297-2d5aca6b81abd63d.js, modules 61861 / 72325: anonymous DPoP.
// Exact enum strings have prior official-bundle evidence (1459-751f4b8136933678,
// inspected 2026-10-16), and current builders reference those enum names. Their
// current defining modules and a live JSON response were not obtained: the
// local 2026-10-20 API probe timed out connecting. Run the supplied read-only
// probe on the Japan host before enabling monitoring; unit fixtures do not
// establish live compatibility. Keep unknown item types a hard schema failure.
// Search HTML currently contains only the Next.js shell. Never treat it, a
// verification page, an unknown JSON array, or a partial list as valid results.
export const MERCARI_SEARCH_ENDPOINT = "https://api.mercari.jp/v2/entities:search";
const PRODUCT_ORIGIN = "https://jp.mercari.com";
const SCAN_COUNTS = new Set([5, 20, 50, 100]);
const AD_QUERY_KEYS = ["ad_id", "ad_auction_id", "ad_auction_unit_id"];
const ITEM_TYPES = new Map([
  ["ITEM_TYPE_MERCARI", "item"], ["ITEM_TYPE_BEYOND", "product"]
]);

export class MercariCollectorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "MercariCollectorError";
    this.code = code;
    this.requiresAttention = ["MERCARI_SCHEMA", "MERCARI_ACCESS_DENIED", "MERCARI_UNEXPECTED_CONTENT"].includes(code);
    Object.assign(this, details);
  }
}

function schema(message) {
  return new MercariCollectorError("MERCARI_SCHEMA", `Mercari 搜索数据结构无法验证：${message}；旧状态未变`);
}
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function aborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("采集已取消", "AbortError");
}

function waitWithSignal(promise, signal) {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new DOMException("采集已取消", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Normal anonymous DPoP: an ephemeral local P-256 client key, never a login token. */
export function createAnonymousProof({ deviceId = randomUUID(), now = Date.now } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const { kty, crv, x, y } = publicKey.export({ format: "jwk" });
  return {
    deviceId,
    token(url, method = "POST") {
      const header = { typ: "dpop+jwt", alg: "ES256", jwk: { kty, crv, x, y } };
      const payload = { iat: Math.floor(now() / 1000), jti: randomUUID(), htu: url, htm: method, uuid: deviceId };
      const input = [header, payload].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
      const signature = sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" });
      return `${input}.${signature.toString("base64url")}`;
    }
  };
}

export function buildSearchRequest(keyword, { pageToken = "", searchSessionId = randomUUID() } = {}) {
  return {
    userId: "", config: { responseToggles: ["QUERY_SUGGESTION_WEB_1"] },
    pageSize: 120, pageToken, searchSessionId, source: "BaseSerp",
    indexRouting: "INDEX_ROUTING_UNSPECIFIED", thumbnailTypes: [],
    searchCondition: {
      keyword, excludeKeyword: "", sort: "SORT_CREATED_TIME", order: "ORDER_DESC",
      status: [], sizeId: [], categoryId: [], brandId: [], sellerId: [], priceMin: 0, priceMax: 0,
      itemConditionId: [], shippingPayerId: [], shippingFromArea: [], shippingMethod: [], colorId: [],
      hasCoupon: false, attributes: [], itemTypes: [], skuIds: [], shopIds: [], excludeShippingMethodIds: []
    },
    serviceFrom: "suruga", withItemBrand: true, withItemSize: false,
    withItemPromotions: true, withItemSizes: true, withShopname: false, useDynamicAttribute: true,
    withSuggestedItems: true, withOfferPricePromotion: true, withProductSuggest: true,
    withParentProducts: false, withProductArticles: true, withSearchConditionId: false,
    // The official builder uses an independent Laplace telemetry UUID only in
    // its client-side branch, and "" otherwise. This service has no browser
    // telemetry and must not substitute its unrelated DPoP device identity.
    withAuction: true, laplaceDeviceUuid: ""
  };
}

function hasAds(item) {
  if (["promoted", "isPromoted", "isAd"].some(key => item[key] === true)) return true;
  if (item.adType !== undefined && item.adType !== null && ![0, "0", "", "AD_TYPE_UNSPECIFIED"].includes(item.adType)) return true;
  if (["adId", "ad_id", "adAuctionId", "ad_auction_id", "adAuctionUnitId", "ad_auction_unit_id"].some(key => Boolean(item[key]))) return true;
  if (item.clickEvent?.eventData?.adId || item.vimpEvent?.eventData?.adId) return true;
  for (const key of ["url", "uri", "landingUri"]) {
    if (typeof item[key] !== "string") continue;
    let url;
    try { url = new URL(item[key], PRODUCT_ORIGIN); } catch { throw schema("商品链接无效"); }
    if (AD_QUERY_KEYS.some(param => url.searchParams.has(param))) return true;
  }
  return false;
}

function normalizeItem(item, position) {
  if (!object(item)) throw schema("items 含有非商品对象");
  if (hasAds(item)) return null;
  if (typeof item.id !== "string") throw schema("商品缺少 ID");
  const type = ITEM_TYPES.get(item.itemType);
  if (!type) throw schema("未知商品类型");
  if (type === "item" ? !/^m\d+$/.test(item.id) : !/^[A-Za-z0-9]{10,32}$/.test(item.id)) throw schema("商品类型与 ID 不一致");
  if (typeof item.name !== "string" || !item.name.trim()) throw schema("商品缺少名称");
  if (!((typeof item.price === "string" && /^\d{1,15}$/.test(item.price)) ||
    (typeof item.price === "number" && Number.isSafeInteger(item.price) && item.price >= 0))) throw schema("商品价格无效");
  const url = `${PRODUCT_ORIGIN}/${type === "item" ? "item" : "shops/product"}/${item.id}`;
  // If an API also supplies a URL, reject identity disagreement rather than
  // allowing an unrelated/ad link to be substituted into a notification.
  for (const key of ["url", "uri", "landingUri"]) {
    if (typeof item[key] !== "string" || !item[key]) continue;
    const linked = new URL(item[key], PRODUCT_ORIGIN);
    if (linked.origin !== PRODUCT_ORIGIN || `${linked.origin}${linked.pathname.replace(/\/$/, "")}` !== url) throw schema("商品 ID 与链接不一致");
  }
  const numericPrice = BigInt(item.price);
  return { id: item.id, type, key: `${type}:${item.id}`, url, promoted: false,
    title: item.name.trim().slice(0, 240), price: `¥${numericPrice.toLocaleString("en-US")}`, position };
}

export function parseSearchResponse(data, { offset = 0 } = {}) {
  if (!object(data) || !Array.isArray(data.items)) throw schema("缺少顶层 items 数组");
  if (data.error || data.errors || data.code && !["OK", "0", 0].includes(data.code)) throw schema("接口返回错误");
  if (data.items.length > 500) throw schema("返回数量异常");
  if (data.components !== undefined && !Array.isArray(data.components)) throw schema("components 无效");
  if (data.meta !== undefined && !object(data.meta)) throw schema("meta 无效");
  const nextPageToken = data.meta?.nextPageToken ?? "";
  if (typeof nextPageToken !== "string" || nextPageToken.length > 8000) throw schema("分页游标无效");
  let ignoredAds = 0;
  const items = [];
  for (let position = 0; position < data.items.length; position++) {
    const item = normalizeItem(data.items[position], offset + position);
    if (item) items.push(item); else ignoredAds++;
  }
  // components is intentionally NOT searched for items. It holds advertising,
  // editorial content and recommendations, not the ordered organic search list.
  return { items, ignoredAds, nextPageToken, rawCount: data.items.length };
}

async function readBody(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw schema("响应超过大小限制");
    return text;
  }
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw schema("响应超过大小限制"); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

function retryAfter(header, now) {
  if (!header) return undefined;
  const seconds = Number(header);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 24 * 60 * 60 * 1000) : undefined;
}

/** HTTP only. No tab, browser engine, user cookies, or HTML scraping fallback. */
export function createMercariCollector({ fetchImpl = globalThis.fetch, timeoutMs = 30000,
  maxPages = 3, pageGapMs = 5000, maxResponseBytes = 2 * 1024 * 1024, now = Date.now, proof = createAnonymousProof({ now }) } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl 必须是函数");
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5) throw new TypeError("maxPages 需为 1–5");
  if (!Number.isFinite(pageGapMs) || pageGapMs < 0 || pageGapMs > 60000) throw new TypeError("pageGapMs 需为 0–60000");
  // One gate is shared by all collections from this instance, including their
  // pagination. Concurrent keywords cannot bypass the actual HTTP start gap.
  // Cancelled waiters return promptly but keep their place in the chain until
  // the preceding waiter settles, so cancellation cannot release another task
  // ahead of an outstanding request slot.
  let requestGate = Promise.resolve(), nextRequestAt = 0;
  function acquireRequestSlot(signal) {
    const turn = requestGate.then(async () => {
      aborted(signal);
      const remaining = nextRequestAt - performance.now();
      if (remaining > 0) await delay(Math.ceil(remaining), undefined, { signal });
      aborted(signal);
      nextRequestAt = performance.now() + pageGapMs;
    });
    requestGate = turn.catch(() => {});
    return waitWithSignal(turn, signal);
  }
  return async function collect(monitor, { signal } = {}) {
    const keyword = String(monitor?.keyword ?? "").trim();
    const scanCount = Number(monitor?.scanCount);
    if (!keyword || keyword.length > 100 || !SCAN_COUNTS.has(scanCount)) throw new TypeError("采集关键词或数量不正确");
    aborted(signal);
    const timeout = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const searchSessionId = randomUUID();
    const items = [];
    const seen = new Set();
    const pageTokens = new Set();
    let pageToken = "", ignoredAds = 0, offset = 0;
    for (let page = 0; page < maxPages; page++) {
      await acquireRequestSlot(combinedSignal);
      aborted(combinedSignal);
      const request = buildSearchRequest(keyword, { pageToken, searchSessionId });
      let response;
      try {
        response = await fetchImpl(MERCARI_SEARCH_ENDPOINT, {
          method: "POST", redirect: "error", signal: combinedSignal,
          headers: { Accept: "application/json", "Content-Type": "application/json", "Accept-Language": "ja",
            "X-Platform": "web", "X-Country-Code": "", Origin: PRODUCT_ORIGIN,
            Referer: `${PRODUCT_ORIGIN}/`, DPoP: proof.token(MERCARI_SEARCH_ENDPOINT, "POST") },
          body: JSON.stringify(request)
        });
      } catch (error) {
        aborted(signal);
        if (timeout.aborted) throw new MercariCollectorError("MERCARI_TIMEOUT", "Mercari HTTP 采集超时；旧状态未变");
        throw new MercariCollectorError("MERCARI_NETWORK", "无法连接 Mercari 搜索接口，请检查服务器网络；旧状态未变", { cause: error });
      }
      aborted(combinedSignal);
      if (!response.ok) {
        await response.body?.cancel?.();
        if (response.status === 429) throw new MercariCollectorError("MERCARI_RATE_LIMITED", "Mercari 限制访问频率（HTTP 429），请暂停检查并延长间隔；旧状态未变",
          { status: 429, retryAfterMs: retryAfter(response.headers.get("retry-after"), now()) });
        if ([401, 403].includes(response.status)) throw new MercariCollectorError("MERCARI_ACCESS_DENIED", `Mercari 拒绝匿名 HTTP 搜索（HTTP ${response.status}），需要检查服务器可用性；旧状态未变`, { status: response.status });
        throw new MercariCollectorError("MERCARI_HTTP", `Mercari 搜索接口返回 HTTP ${response.status}；旧状态未变`, { status: response.status });
      }
      const contentType = response.headers.get("content-type") || "";
      if (!/^application\/(?:[\w.-]+\+)?json(?:;|$)/i.test(contentType)) {
        await response.body?.cancel?.();
        throw new MercariCollectorError("MERCARI_UNEXPECTED_CONTENT", "Mercari 未返回 JSON 搜索数据，可能需要验证或接口已变化；旧状态未变");
      }
      let body;
      try { body = await readBody(response, maxResponseBytes); }
      catch (error) {
        aborted(signal);
        if (error instanceof MercariCollectorError) throw error;
        if (timeout.aborted) throw new MercariCollectorError("MERCARI_TIMEOUT", "Mercari HTTP 响应读取超时；旧状态未变");
        throw new MercariCollectorError("MERCARI_NETWORK", "Mercari HTTP 响应读取失败，请检查服务器网络；旧状态未变", { cause: error });
      }
      let data;
      try { data = JSON.parse(body); } catch { throw schema("响应不是有效 JSON"); }
      aborted(combinedSignal);
      const parsed = parseSearchResponse(data, { offset });
      ignoredAds += parsed.ignoredAds;
      offset += parsed.rawCount;
      for (const item of parsed.items) {
        if (seen.has(item.key)) continue;
        seen.add(item.key);
        items.push(item);
      }
      if (items.length >= scanCount) return { items: items.slice(0, scanCount), source: MERCARI_SEARCH_ENDPOINT, ignoredAds, observedAt: now() };
      pageToken = parsed.nextPageToken;
      if (!pageToken || pageTokens.has(pageToken)) break;
      pageTokens.add(pageToken);
    }
    throw new MercariCollectorError("MERCARI_INSUFFICIENT_RESULTS", `只获取到 ${items.length} 件非推广商品，需要 ${scanCount} 件；旧状态未变`, { count: items.length, required: scanCount });
  };
}
