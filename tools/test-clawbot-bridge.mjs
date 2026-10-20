import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readJson } from "../bridge/weixin.mjs";
import { sendChannel } from "../extension/notify.js";
const config = await readJson("D:\\OpenClaw\\mercari-bridge\\config.json");
const health = () => fetch("http://127.0.0.1:17869/health").then(response => response.json());
const before = await health();
await sendChannel("clawbot", { id: `bridge-test-${randomUUID()}`,
  items: [{ title: "扩展 → 本机转发服务 → 微信 ClawBot 全链路连接测试。这不是实际商品上新。", price: "",
    url: "https://jp.mercari.com/search?keyword=%E6%BD%94%E4%B8%96%E4%B8%80&order=desc&sort=created_time" }] },
  { keyword: "连接测试（非真实上新）", wechat: "clawbot", token: config.token },
  { permissions: { contains: async () => true } });
for (let i = 0; i < 80; i++) {
  await delay(250);
  const current = await health();
  if (current.delivered > before.delivered) {
    console.log(JSON.stringify({ ok: true, contextReady: current.contextReady, queued: current.pending, acceptedByWechat: true }));
    process.exit(0);
  }
  if (current.lastError) throw new Error(current.lastError);
}
throw new Error("消息已保存在本机队列，但尚未确认微信接口接受；请查看本机连接页面");
