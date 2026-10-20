import fs from "node:fs/promises";
import path from "node:path";
import { readJson } from "./weixin.mjs";

export async function discover(root = "D:\\OpenClaw", previous = {}) {
  const installation = await readJson(path.join(root, "installation.json"));
  if (installation.status !== "installed") throw new Error("OpenClaw 尚未安装完成");
  const stateDir = installation.stateDir;
  const ids = await readJson(path.join(stateDir, "openclaw-weixin/accounts.json"));
  const accountId = previous.accountId && previous.target ? previous.accountId : ids.length === 1 ? ids[0] : null;
  if (!accountId || !/^[a-zA-Z0-9_-]+$/.test(accountId)) throw new Error("无法确定默认接收账号，请保留原有转发配置后再运行安装");
  const account = await readJson(path.join(stateDir, "openclaw-weixin/accounts", `${accountId}.json`), {});
  if ((!account.token || !account.userId) && !(previous.accountId === accountId && previous.target)) throw new Error("请先扫码登录微信 ClawBot");
  const projects = path.join(stateDir, "npm/projects");
  const plugins = [];
  for (const folder of await fs.readdir(projects)) {
    if (!folder.startsWith("tencent-weixin-openclaw-weixin-")) continue;
    const candidate = path.join(projects, folder, "node_modules/@tencent-weixin/openclaw-weixin");
    const metadata = await readJson(path.join(candidate, "package.json"), {});
    if (metadata.name === "@tencent-weixin/openclaw-weixin") plugins.push(candidate);
  }
  if (plugins.length !== 1) throw new Error("无法唯一确定已安装的腾讯微信插件目录");
  const openclawConfig = await readJson(path.join(stateDir, "openclaw.json"));
  return { stateDir, pluginRoot: plugins[0], accountId, target: account.userId || previous.target,
    gatewayPort: openclawConfig.gateway?.port || 18789 };
}
export function setEnvironment(stateDir) {
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
  process.env.TEMP = path.join(stateDir, "tmp");
  process.env.TMP = process.env.TEMP;
  process.env.OPENCLAW_LOG_LEVEL = "WARN";
}
