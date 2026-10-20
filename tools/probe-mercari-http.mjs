#!/usr/bin/env node
import { createMercariCollector, MERCARI_SEARCH_ENDPOINT } from "../server/mercari-http.mjs";

// Read-only readiness check for the actual deployment host. This never imports
// WeChat credentials, starts a browser, saves a monitor baseline or sends a push.
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: node tools/probe-mercari-http.mjs [--keyword 潔世一] [--count 5|20|50|100]");
  console.log("Performs one ordinary anonymous Mercari search request. No browser or push. Exit 0 = complete validated organic list; exit 1 = unavailable.");
  process.exit(0);
}
const options = { keyword: "潔世一", scanCount: 5 };
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--keyword" && args[i + 1]) options.keyword = args[++i];
  else if (args[i] === "--count" && args[i + 1]) options.scanCount = Number(args[++i]);
  else { console.error("Unknown or incomplete option. Use --help."); process.exit(2); }
}
const start = Date.now();
try {
  const result = await createMercariCollector({ maxPages: 1 })(options);
  console.log(JSON.stringify({ ok: true, keyword: options.keyword, source: result.source,
    transport: "HTTP POST; no browser", observedAt: new Date(result.observedAt).toISOString(),
    elapsedMs: Date.now() - start, ignoredAds: result.ignoredAds,
    items: result.items.map(({ type, id, url }) => ({ type, id, url })) }, null, 2));
} catch (error) {
  const networkCode = error.cause?.cause?.code;
  console.error(JSON.stringify({ ok: false, source: MERCARI_SEARCH_ENDPOINT,
    code: error.code || "PROBE_FAILED", status: error.status, message: error.message,
    elapsedMs: Date.now() - start, retryAfterMs: error.retryAfterMs,
    networkCode: typeof networkCode === "string" && /^[A-Z_0-9]+$/.test(networkCode) ? networkCode : undefined,
    action: "Keep monitoring paused until this check passes on the Japan server. Do not bypass access denial or substitute browser results." }, null, 2));
  process.exitCode = 1;
}
