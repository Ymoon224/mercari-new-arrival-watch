// Read-only check of the installed service. No test notifications are sent.
import { readJson } from "../bridge/weixin.mjs";
const config = await readJson("D:/OpenClaw/mercari-bridge/config.json");
const base = `http://127.0.0.1:${config.port}`;
const health = await (await fetch(`${base}/health`)).json();
const unauthorized = await fetch(`${base}/recipients`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
const unauthorizedRemoval = await fetch(`${base}/delete-recipient`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
const privateResult = await (await fetch(`${base}/recipients`, { method: "POST", headers: {
  "Content-Type": "application/json", Authorization: `Bearer ${config.token}` }, body: "{}" })).json();
if (health.version !== "1.3.2" || !health.multiRecipient || unauthorized.status !== 401 || unauthorizedRemoval.status !== 401 || privateResult.ok !== true) throw new Error("Installed administrator endpoint verification failed");
if (JSON.stringify(health).includes(config.token) || JSON.stringify(privateResult).includes(config.target)) throw new Error("Unexpected credential exposure");
console.log(JSON.stringify({ version: health.version, adminAuthentication: true,
  boundRecipients: privateResult.recipients.length, defaultRecipientPreserved: privateResult.recipients.some(row => row.id === "owner" && row.isDefault),
  deletedRecipients: privateResult.deletedRecipientIds?.length || 0,
  pending: health.pending, accepted: health.accepted, contextReady: health.contextReady, noMessagesSentByThisCheck: true }));
