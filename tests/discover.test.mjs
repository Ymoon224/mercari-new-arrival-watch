import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { discover } from "../bridge/discover.mjs";
import { writeJson } from "../bridge/weixin.mjs";

test("updating still works after deleting the original receiving account; administrator identity is independent of WeChat login", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mercari-discover-test-"));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  await writeJson(path.join(root, "installation.json"), { status: "installed", stateDir });
  await writeJson(path.join(stateDir, "openclaw.json"), { gateway: { port: 18789 } });
  await writeJson(path.join(stateDir, "openclaw-weixin/accounts.json"), []);
  await writeJson(path.join(stateDir, "npm/projects/tencent-weixin-openclaw-weixin-test/node_modules/@tencent-weixin/openclaw-weixin/package.json"), { name: "@tencent-weixin/openclaw-weixin" });
  const previous = { accountId: "removed-owner-bot", target: "owner@im.wechat" };
  const result = await discover(root, previous);
  assert.equal(result.accountId, previous.accountId); assert.equal(result.target, previous.target);
  await assert.rejects(discover(root), /默认接收账号/);
});
