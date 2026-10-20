import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadServerConfig } from "../server/config.mjs";
import { bootstrapServer } from "../server/bootstrap.mjs";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mercari-remote-config-"));
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const projectRoot = path.join(directory, "checkout"), data = path.join(directory, "runtime"), plugin = path.join(directory, "plugin");
  await fs.mkdir(projectRoot); await fs.mkdir(plugin);
  return { directory, projectRoot, data, plugin,
    env: { MERCARI_DATA_DIR: data, MERCARI_PLUGIN_ROOT: plugin } };
}

test("remote config generates a persistent private administrator secret outside source checkout", async t => {
  const f = await fixture(t);
  const first = await loadServerConfig({ env: f.env, projectRoot: f.projectRoot });
  const second = await loadServerConfig({ env: f.env, projectRoot: f.projectRoot });
  assert.match(first.token, /^[a-f0-9]{64}$/); assert.equal(first.token, second.token);
  assert.equal(first.host, "127.0.0.1"); assert.equal(first.port, 17870);
  assert.equal(first.bridgeDir, path.join(f.data, "bridge"));
  if (process.platform !== "win32") assert.equal((await fs.stat(first.tokenFile)).mode & 0o777, 0o600);
});

test("remote config rejects source-tree data, public plaintext listener, invalid secret, and malformed ports", async t => {
  const f = await fixture(t);
  await assert.rejects(loadServerConfig({ env: { ...f.env, MERCARI_DATA_DIR: path.join(f.projectRoot, "data") }, projectRoot: f.projectRoot }), /代码仓库/);
  for (const env of [{ MERCARI_HOST: "0.0.0.0" }, { MERCARI_ADMIN_TOKEN: "short" }, { MERCARI_PORT: "80" }]) {
    await assert.rejects(loadServerConfig({ env: { ...f.env, ...env }, projectRoot: f.projectRoot }));
  }
  const configured = "A".repeat(64);
  assert.equal((await loadServerConfig({ env: { ...f.env, MERCARI_ADMIN_TOKEN: configured }, projectRoot: f.projectRoot })).token, configured);
});

test("fresh bootstrap requires pinned official modules but no account, CLI login, or Gateway", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.plugin, "package.json"), JSON.stringify({ name: "@tencent-weixin/openclaw-weixin", version: "2.4.10" }));
  for (const file of ["dist/src/api/api.js", "dist/src/auth/accounts.js", "dist/src/storage/sync-buf.js"]) {
    await fs.mkdir(path.dirname(path.join(f.plugin, file)), { recursive: true }); await fs.writeFile(path.join(f.plugin, file), "");
  }
  const previous = { OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH, TEMP: process.env.TEMP, TMP: process.env.TMP, OPENCLAW_LOG_LEVEL: process.env.OPENCLAW_LOG_LEVEL };
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const result = await bootstrapServer({ env: f.env, projectRoot: f.projectRoot });
  assert.equal(result.bridgeConfig.accountId, ""); assert.equal(result.bridgeConfig.target, "");
  assert.equal(result.bridgeConfig.forceDirect, true);
  assert.equal(process.env.OPENCLAW_STATE_DIR, result.config.stateDir);
  await assert.rejects(fs.access(path.join(result.config.stateDir, "openclaw-weixin/accounts.json")), /ENOENT/);
  await fs.writeFile(path.join(f.plugin, "package.json"), JSON.stringify({ name: "@tencent-weixin/openclaw-weixin", version: "99.0.0" }));
  await assert.rejects(bootstrapServer({ config: result.config }), /2.4.10/);
});

test("public service config validates HTTPS root origin and explicit extension origin allowlist", async t => {
  const f = await fixture(t);
  const config = await loadServerConfig({ projectRoot: f.projectRoot, env: { ...f.env,
    MERCARI_PUBLIC_URL: "https://watch.example.com/", MERCARI_TRUST_PROXY: "1",
    MERCARI_ALLOWED_ORIGINS: `chrome-extension://${"a".repeat(32)},https://admin.example.com` } });
  assert.equal(config.publicUrl, "https://watch.example.com"); assert.equal(config.requireHttps, true); assert.equal(config.trustProxy, true);
  assert.equal(config.minRequestGapMs, 5000); assert.equal(config.maxConcurrent, 1);
  assert.deepEqual(config.allowedOrigins, [`chrome-extension://${"a".repeat(32)}`, "https://admin.example.com"]);
  for (const invalid of [{ MERCARI_PUBLIC_URL: "http://watch.example.com" }, { MERCARI_PUBLIC_URL: "https://watch.example.com/api" },
    { MERCARI_ALLOWED_ORIGINS: "*" }, { MERCARI_ALLOWED_ORIGINS: "https://user:password@watch.example.com" },
    { MERCARI_TRUST_PROXY: "true" }, { MERCARI_MAX_CONCURRENT: "10" }]) {
    await assert.rejects(loadServerConfig({ env: { ...f.env, ...invalid }, projectRoot: f.projectRoot }));
  }
});
