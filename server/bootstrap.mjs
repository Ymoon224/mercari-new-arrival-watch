import fs from "node:fs/promises";
import path from "node:path";
import { loadServerConfig } from "./config.mjs";
import { setEnvironment } from "../bridge/discover.mjs";

export const WEIXIN_PLUGIN_VERSION = "2.4.10";

/** No account is required to start a fresh admin service and display its first QR. */
export async function bootstrapServer(options = {}) {
  const config = options.config || await loadServerConfig(options);
  const metadata = JSON.parse(await fs.readFile(path.join(config.pluginRoot, "package.json"), "utf8"));
  if (metadata.name !== "@tencent-weixin/openclaw-weixin" || metadata.version !== WEIXIN_PLUGIN_VERSION) {
    throw new Error(`本版本仅验证了 @tencent-weixin/openclaw-weixin@${WEIXIN_PLUGIN_VERSION}，请安装该版本后启动`);
  }
  for (const file of ["dist/src/api/api.js", "dist/src/auth/accounts.js", "dist/src/storage/sync-buf.js"]) await fs.access(path.join(config.pluginRoot, file));
  await fs.mkdir(path.join(config.stateDir, "tmp"), { recursive: true, mode: 0o700 });
  setEnvironment(config.stateDir);
  // The lightweight relay uses the official SDK and account storage; it does
  // not start a full OpenClaw Gateway or require an LLM configuration.
  return { config, directory: config.bridgeDir, bridgeConfig: {
    token: config.token, stateDir: config.stateDir, pluginRoot: config.pluginRoot,
    gatewayPort: config.gatewayPort, sessionMessageLimit: config.sessionMessageLimit, forceDirect: true,
    accountId: "", target: ""
  } };
}
