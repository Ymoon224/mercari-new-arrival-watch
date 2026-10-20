(() => {
  async function collect(run) {
    const started = Date.now();
    let signature = "";
    let stableSince = 0;
    while (Date.now() - started < 45000) {
      const current = new URL(location.href);
      if (current.pathname !== "/search" || current.searchParams.get("keyword") !== run.keyword ||
          current.searchParams.get("sort") !== "created_time" || current.searchParams.get("order") !== "desc") {
        throw new Error("搜索条件或排序发生变化；旧状态未变");
      }
      const sample = MercariCollector.readDocument();
      if (sample.ready) {
        const selected = sample.items.slice(0, run.scanCount);
        const lastPosition = selected.at(-1)?.position ?? -1;
        const prefixPending = sample.pending.some(index => index <= lastPosition);
        const enough = selected.length === run.scanCount && !prefixPending;
        const nextSignature = selected.map(item => item.key).join(",");
        if (enough && nextSignature === signature && Date.now() - stableSince >= 1500) {
          return { items: selected, ignored: sample.ignored, totalCells: sample.cells.length };
        }
        if (!enough || nextSignature !== signature) { signature = nextSignature; stableSince = Date.now(); }
        if (!enough) {
          const next = sample.pending.find(index => index <= lastPosition || sample.items.length < run.scanCount);
          if (next !== undefined) sample.cells[next]?.scrollIntoView({ block: "center" });
        }
      }
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    throw new Error("45 秒内未完整加载所需商品；可能网络异常、出现验证或结果不足。旧状态未变");
  }
  chrome.runtime.sendMessage({ type: "collector-ready" }).then(async response => {
    if (!response?.run) return; // Ordinary user tabs are never refreshed or sampled.
    const { run } = response;
    try {
      const result = await collect(run);
      await chrome.runtime.sendMessage({ type: "sample", runId: run.id, ...result });
    } catch (error) {
      await chrome.runtime.sendMessage({ type: "sample-error", runId: run.id, error: String(error.message).slice(0, 400) });
    }
  }).catch(() => {});
})();
