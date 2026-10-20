(() => {
  function hasPromotion(card) {
    if ([...card.querySelectorAll("a[href]")].some(a => globalThis.MercariWatch.parseProduct(a.getAttribute("href"))?.promoted)) return true;
    return [...card.querySelectorAll("svg path[fill]")].some(path => {
      const fill = (path.getAttribute("fill") || "").toLowerCase();
      return ["#ffb818", "rgb(255, 184, 24)"].includes(fill);
    });
  }
  function readDocument(doc = document) {
    const grid = doc.querySelector('[data-testid="search-item-grid"]');
    if (!grid) return { ready: false, reason: "未找到搜索结果，可能正在加载、需要验证或页面结构已改变", items: [], cells: [] };
    // The current Mercari grid inserts advertising components alongside organic
    // <li data-testid="item-cell"> entries. Only these organic entries qualify.
    const cells = [...grid.querySelectorAll('li[data-testid="item-cell"]')];
    const items = [];
    const pending = [];
    let ignored = 0;
    const seen = new Set();
    cells.forEach((card, index) => {
      if (hasPromotion(card)) { ignored++; return; }
      const anchor = card.querySelector('a[data-testid="thumbnail-link"]') || card.querySelector('a[href]');
      if (!anchor) { pending.push(index); return; }
      const parsed = globalThis.MercariWatch.parseProduct(anchor.getAttribute("href"));
      if (!parsed) { pending.push(index); return; }
      if (parsed.promoted) { ignored++; return; }
      if (seen.has(parsed.key)) return;
      seen.add(parsed.key);
      const text = card.innerText || card.textContent || "";
      items.push({ ...parsed, title: (card.querySelector("p")?.textContent || card.querySelector("img")?.getAttribute("alt") || parsed.id).trim(),
        price: text.match(/[¥￥]\s*[\d,]+/)?.[0].replace(/\s+/g, "") || "", position: index });
    });
    return { ready: true, items, cells, pending, ignored };
  }
  globalThis.MercariCollector = { readDocument, hasPromotion };
})();
