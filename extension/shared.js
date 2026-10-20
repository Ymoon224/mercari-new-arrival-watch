// Shared by the isolated content script, background worker, and Node tests.
(() => {
  const defaults = {
    keyword: "潔世一", scanCount: 20, intervalMinutes: 1,
    desktop: true, wechat: "none", token: "", enabled: false
  };
  function searchUrl(keyword) {
    const url = new URL("https://jp.mercari.com/search");
    url.search = new URLSearchParams({ keyword, order: "desc", sort: "created_time" });
    return url.href;
  }
  function parseProduct(href) {
    let url;
    try { url = new URL(href, "https://jp.mercari.com"); } catch { return null; }
    if (url.origin !== "https://jp.mercari.com") return null;
    const item = url.pathname.match(/^\/item\/(m\d+)\/?$/);
    const product = url.pathname.match(/^\/shops\/product\/([A-Za-z0-9]{10,32})\/?$/);
    if (!item && !product) return null;
    const type = item ? "item" : "product";
    const id = (item || product)[1];
    const promoted = ["ad_id", "ad_auction_id", "ad_auction_unit_id"].some(k => url.searchParams.has(k));
    return { type, id, key: `${type}:${id}`, url: `${url.origin}${url.pathname.replace(/\/$/, "")}`, promoted };
  }
  function normalizeItems(items) {
    if (!Array.isArray(items)) throw new Error("商品数据格式不正确，已保留旧状态");
    const unique = new Map();
    for (const entry of items) {
      const item = parseProduct(entry?.url || "");
      if (!item || item.promoted || entry.promoted || entry.adType) continue;
      if (entry.id && entry.id !== item.id) throw new Error("商品 ID 与链接不一致");
      if (!unique.has(item.key)) unique.set(item.key, {
        ...item, title: String(entry.title || item.id).slice(0, 240),
        price: String(entry.price || "").slice(0, 40)
      });
    }
    return [...unique.values()];
  }
  function emptyState(keyword) {
    return {
      keyword, initialized: false, top: [], lastWindow: [],
      lastSuccess: null, lastAttempt: null, lastError: "", failures: 0,
      failureStartedAt: null, failureAlerted: false,
      warning: "", pending: [], events: [], run: null
    };
  }
  function sameSet(a, b) {
    return a.length === b.length && a.every(key => b.includes(key));
  }
  function notificationChannels(settings) {
    const channels = {};
    if (settings.desktop) channels.desktop = false;
    if (settings.wechat !== "none" && (settings.wechat !== "clawbot" || settings.recipientIds?.length !== 0)) channels[settings.wechat] = false;
    return channels;
  }
  function recordFailure(previous, error, settings, now = Date.now()) {
    const state = structuredClone(previous || emptyState(settings.keyword));
    state.lastError = String(error?.message || error || "商品检查失败，未提供具体原因").slice(0, 400);
    state.failures = (Number(state.failures) || 0) + 1;
    state.failureStartedAt ??= now;
    if (state.failures > 5 && !state.failureAlerted) {
      const channels = notificationChannels(settings);
      if (Object.keys(channels).length) {
        const event = { id: `failure-${crypto.randomUUID()}`, type: "monitor-error", time: now,
          keyword: settings.keyword, recipientIds: [...(settings.recipientIds || ["owner"])], failures: state.failures, error: state.lastError,
          failureStartedAt: state.failureStartedAt, lastSuccess: state.lastSuccess,
          url: searchUrl(settings.keyword), items: [], channels, attempts: 0 };
        // An outage alert should not wait behind a backlog of product messages.
        state.pending.unshift(event);
        state.failureAlerted = true;
      }
    }
    return state;
  }
  function advance(previous, input, settings, now = Date.now()) {
    const items = normalizeItems(input);
    if (items.length < settings.scanCount) throw new Error(`只读到 ${items.length} 件非推广商品，需要 ${settings.scanCount} 件；旧状态未变`);
    const window = items.slice(0, settings.scanCount);
    const state = structuredClone(previous || emptyState(settings.keyword));
    if (state.keyword !== settings.keyword) throw new Error("搜索条件与基线不一致");
    const wasInitialized = state.initialized;
    // Compare only with the last successful collection. Older observations and
    // matching Shop titles/prices never suppress a newly entering listing.
    const oldKeys = new Set(state.lastWindow?.length ? state.lastWindow : state.top.map(item => item.key));
    const gap = wasInitialized && !window.some(item => oldKeys.has(item.key));
    const fresh = wasInitialized ? window.filter(item => !oldKeys.has(item.key)) : [];
    delete state.seen; delete state.shopSeen; delete state.suppressedSimilar;
    const top = window.slice(0, 5);
    const topChanged = !sameSet(state.top.map(i => i.key), top.map(i => i.key));
    if (!wasInitialized || topChanged) state.top = top;
    state.initialized = true;
    state.lastWindow = window.map(i => i.key);
    state.lastSuccess = now;
    state.lastError = "";
    state.failures = 0;
    state.failureStartedAt = null;
    state.failureAlerted = false;
    state.warning = gap ? "本轮与上一轮没有重叠，可能有超出扫描范围的上新或页面变化。请核对搜索页。" : "";
    if (fresh.length) {
      const event = { id: `new-${crypto.randomUUID()}`, time: now, keyword: settings.keyword, items: fresh, gap,
        recipientIds: [...(settings.recipientIds || ["owner"])] };
      const channels = notificationChannels(settings);
      state.events = [event, ...state.events].slice(0, 50);
      if (Object.keys(channels).length) state.pending.push({ ...event, channels, attempts: 0 });
    }
    return { state, fresh, baseline: !wasInitialized, topChanged, gap };
  }
  function validateSettings(input, old = defaults) {
    const keyword = String(input.keyword ?? old.keyword).trim();
    if (!keyword || keyword.length > 100) throw new Error("关键词需为 1–100 个字符");
    const scanCount = Number(input.scanCount ?? old.scanCount);
    if (![5, 20, 50, 100].includes(scanCount)) throw new Error("扫描数量不正确");
    const wechat = input.wechat ?? old.wechat;
    if (!["none", "clawbot", "serverchan", "pushplus"].includes(wechat)) throw new Error("微信渠道不正确");
    const token = input.clearToken ? "" : String(input.token || (wechat === old.wechat ? old.token : "") || "").trim();
    if (wechat === "serverchan" && !/^SCT[A-Za-z0-9]+$/.test(token)) throw new Error("请填入 Server酱 Turbo 的 SCT 开头 SendKey");
    if (wechat === "pushplus" && !/^[A-Za-z0-9_-]{10,200}$/.test(token)) throw new Error("请填入 PushPlus token");
    if (wechat === "clawbot" && !/^[a-f0-9]{64}$/.test(token)) throw new Error("请从本机 ClawBot 连接页面复制完整的连接密钥");
    if (!input.desktop && wechat === "none") throw new Error("请至少选择一种通知方式");
    return { ...old, keyword, scanCount, wechat, token, desktop: Boolean(input.desktop), intervalMinutes: 1 };
  }
  globalThis.MercariWatch = { defaults, searchUrl, parseProduct, normalizeItems, emptyState, sameSet, recordFailure, advance, validateSettings };
})();
