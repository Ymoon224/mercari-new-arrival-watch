import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const integer = (value, fallback, min, max, label) => {
  const number = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${label} 设置不正确`);
  return number;
};
const within = (parent, child) => { const relative = path.relative(parent, child); return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
function httpsOrigin(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} 必须是 HTTPS 域名根地址`); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error(`${label} 必须是 HTTPS 域名根地址`);
  return url.origin;
}

/** Runtime state must be outside the checkout, so git updates never overwrite it. */
export async function loadServerConfig({ env = process.env, projectRoot = repository } = {}) {
  if (!env.MERCARI_DATA_DIR || !path.isAbsolute(env.MERCARI_DATA_DIR)) throw new Error("请将 MERCARI_DATA_DIR 设置为仓库以外的绝对数据目录");
  if (!env.MERCARI_PLUGIN_ROOT || !path.isAbsolute(env.MERCARI_PLUGIN_ROOT)) throw new Error("请设置 MERCARI_PLUGIN_ROOT 为已安装腾讯微信插件的绝对目录");
  const dataDir = path.resolve(env.MERCARI_DATA_DIR);
  const pluginRoot = path.resolve(env.MERCARI_PLUGIN_ROOT);
  if (within(path.resolve(projectRoot), dataDir)) throw new Error("数据目录不能位于代码仓库内");
  const host = env.MERCARI_HOST || "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("管理服务仅绑定本机回环地址，请通过 HTTPS 反向代理访问");
  const port = integer(env.MERCARI_PORT, 17870, 1024, 65535, "MERCARI_PORT");
  const publicUrl = env.MERCARI_PUBLIC_URL ? httpsOrigin(env.MERCARI_PUBLIC_URL, "MERCARI_PUBLIC_URL") : "";
  const allowedOrigins = [...new Set((env.MERCARI_ALLOWED_ORIGINS || "").split(",").map(origin => origin.trim()).filter(Boolean).map(origin => {
    if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return origin;
    return httpsOrigin(origin, "MERCARI_ALLOWED_ORIGINS");
  }))];
  if (env.MERCARI_TRUST_PROXY !== undefined && !["0", "1", ""].includes(env.MERCARI_TRUST_PROXY)) throw new Error("MERCARI_TRUST_PROXY 只能设置为 0 或 1");
  const trustProxy = env.MERCARI_TRUST_PROXY === "1";
  const minRequestGapMs = integer(env.MERCARI_MIN_REQUEST_GAP_MS, 5000, 1000, 60000, "MERCARI_MIN_REQUEST_GAP_MS");
  const maxConcurrent = integer(env.MERCARI_MAX_CONCURRENT, 1, 1, 3, "MERCARI_MAX_CONCURRENT");
  const collectionTimeoutMs = integer(env.MERCARI_COLLECTION_TIMEOUT_MS, 45000, 5000, 90000, "MERCARI_COLLECTION_TIMEOUT_MS");
  const stateDir = path.join(dataDir, "weixin");
  const bridgeDir = path.join(dataDir, "bridge");
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  // Resolve symlinks before creating the secret: an outside-looking data path
  // must not point back into the Git checkout.
  const actualData = await fs.realpath(dataDir);
  const actualProject = await fs.realpath(projectRoot).catch(() => path.resolve(projectRoot));
  if (within(actualProject, actualData)) throw new Error("数据目录不能通过链接指向代码仓库内");
  for (const directory of [stateDir, bridgeDir]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const tokenFile = path.join(dataDir, "admin-token");
  let token = env.MERCARI_ADMIN_TOKEN?.trim();
  if (token !== undefined && !/^[a-fA-F0-9]{64}$/.test(token)) throw new Error("MERCARI_ADMIN_TOKEN 必须是 64 位十六进制密钥");
  if (!token) {
    try { await fs.writeFile(tokenFile, `${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const info = await fs.lstat(tokenFile);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("管理员密钥文件必须是普通文件");
    if (process.platform !== "win32" && (info.mode & 0o077)) throw new Error("管理员密钥文件权限过宽，请设置为 600");
    token = (await fs.readFile(tokenFile, "utf8")).trim();
    if (!/^[a-fA-F0-9]{64}$/.test(token)) throw new Error("管理员密钥文件内容不正确，请保留原文件并检查");
  }
  return { dataDir, bridgeDir, stateDir, pluginRoot, token, tokenFile, host, port,
    publicUrl, allowedOrigins, trustProxy, requireHttps: Boolean(publicUrl),
    minRequestGapMs, maxConcurrent, collectionTimeoutMs,
    gatewayPort: integer(env.MERCARI_GATEWAY_PORT, 18789, 1024, 65535, "MERCARI_GATEWAY_PORT"),
    sessionMessageLimit: 10 };
}
