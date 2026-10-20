// Local preview only. No Mercari checks or external notifications are started.
(() => {
  const empty = keyword => ({ keyword, top: [], lastWindow: [], events: [], pending: [], run: null, initialized: false, lastError: "", failures: 0 });
  const demo = {
    settings: { desktop: true, wechat: "none", hasToken: false },
    monitors: [{ id: "watch-preview-a", keyword: "潔世一", scanCount: 20, intervalMinutes: 1, enabled: false },
      { id: "watch-preview-b", keyword: "凪誠士郎", scanCount: 5, intervalMinutes: 5, enabled: false }],
    states: { "watch-preview-a": empty("潔世一"), "watch-preview-b": empty("凪誠士郎") }
  };
  window.chrome = { permissions: { request: async () => true }, runtime: { sendMessage: async message => {
    if (message.type === "status") {
      const selected = demo.monitors.find(item => item.id === message.monitorId) || demo.monitors[0];
      return structuredClone({ version: "1.3.2", recipients: [{ id: "owner", name: "我的微信", enabled: true }], settings: demo.settings, monitors: demo.monitors, selectedId: selected?.id || null,
        state: selected ? demo.states[selected.id] : null,
        bridge: demo.settings.wechat === "clawbot" ? { connected: false, error: "界面预览，不连接真实微信" } : null });
    }
    if (message.type === "save-monitor") {
      const monitor = { ...message.monitor, id: message.monitor.id || `watch-preview-${crypto.randomUUID()}` };
      if (message.monitor.id) demo.monitors = demo.monitors.map(item => item.id === monitor.id ? monitor : item);
      else { demo.monitors.push(monitor); demo.states[monitor.id] = empty(monitor.keyword); }
      return { ok: true, monitorId: monitor.id };
    }
    if (message.type === "toggle") { const item = demo.monitors.find(item => item.id === message.monitorId); item.enabled = !item.enabled; }
    if (message.type === "delete-monitor") { demo.monitors = demo.monitors.filter(item => item.id !== message.monitorId); delete demo.states[message.monitorId]; }
    if (message.type === "save-settings") demo.settings = { desktop: message.settings.desktop, wechat: message.settings.wechat, hasToken: Boolean(message.settings.token || demo.settings.hasToken) };
    if (message.type === "test-notification" || message.type === "check") return { error: "这是本地界面预览，不执行真实检查或通知。请从浏览器扩展图标打开正式面板。" };
    return { ok: true };
  } } };
})();
