import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapServer } from './bootstrap.mjs';
import { createWeixinLogin } from './weixin-login.mjs';
import { createMercariCollector } from './mercari-http.mjs';
import { createRecipientHub } from '../bridge/recipients.mjs';
import { createMonitorService } from './monitor.mjs';
import { createRemoteApp } from './app.mjs';

export async function startRemoteServer(options = {}) {
  const { config, bridgeConfig, directory } = await bootstrapServer(options);
  let hub, monitor, login, app;
  try {
    hub = await createRecipientHub({ config: bridgeConfig, directory, listen: false, allowEmpty: true });
    const collector = createMercariCollector({ timeoutMs: config.collectionTimeoutMs, pageGapMs: config.minRequestGapMs });
    monitor = await createMonitorService({ directory: config.dataDir, collector, hub,
      minRequestGapMs: config.minRequestGapMs, maxConcurrent: config.maxConcurrent, collectionTimeoutMs: config.collectionTimeoutMs });
    login = await createWeixinLogin({ config: bridgeConfig, onBound: () => hub.admin('/sync-recipients', {}) });
    app = await createRemoteApp({ config, monitor, hub, login });
  } catch (error) {
    await Promise.allSettled([app?.close(), monitor?.close(), login?.close()]); await hub?.close(); throw error;
  }
  let closing;
  const close = () => closing ||= (async () => {
    // Stop scheduling synchronously, even if an existing admin request is slow.
    const results = await Promise.allSettled([monitor.close(), app.close(), login.close()]);
    await hub.close();
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  })();
  return { config, app, monitor, hub, login, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const instance = await startRemoteServer();
    console.log(`Mercari 远端管理服务 v2.0.0 已启动，监听 ${instance.config.host}:${instance.app.server.address().port}。管理员密钥不会输出。`);
    const stop = async () => { await instance.close(); process.exitCode = 0; };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch {
    console.error('远端服务启动失败，请检查 Node 版本、环境变量、腾讯微信插件安装以及数据目录权限。');
    process.exitCode = 1;
  }
}
