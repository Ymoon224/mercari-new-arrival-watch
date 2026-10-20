import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./weixin.mjs";
import { setEnvironment } from "./discover.mjs";
import { createRecipientHub } from "./recipients.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const config = await readJson(path.join(directory, "config.json"));
setEnvironment(config.stateDir);
const bridge = await createRecipientHub({ config, directory });
console.log(`Mercari 微信转发服务已启动：http://127.0.0.1:${bridge.server.address().port}/setup`);
async function stop() { await bridge.close(); process.exit(0); }
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
