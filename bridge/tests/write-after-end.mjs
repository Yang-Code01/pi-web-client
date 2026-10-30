/**
 * Regression: answering a ui_request whose pi child already closed stdin must not kill the
 * process. This is how the 7864 server died on 2026-10-30 18:28Z:
 *
 *   Error [ERR_STREAM_WRITE_AFTER_END]: write after end
 *       at RpcChild.write -> RpcChild.uiRespond -> Session.onUiRequest
 *
 * Run: node bridge/tests/write-after-end.mjs   (needs bridge/dist built)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RpcChild } from "../dist/rpc.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-wae-"));
const logPath = path.join(tmp, "rpc.log");
let failures = 0;

const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** A stand-in for `pi --mode rpc`: says hello, then goes away after `lifeMs`. */
function fakePi(name, body) {
  const file = path.join(tmp, `${name}.mjs`);
  fs.writeFileSync(file, body);
  return file;
}

function makeChild(cli) {
  const logs = [];
  const rpc = new RpcChild({ cli, args: [], cwd: tmp, logPath });
  rpc.on("log", (l) => logs.push(l));
  const exited = new Promise((resolve) => rpc.once("exit", resolve));
  rpc.start();
  return { rpc, exited, logs };
}

// 1. kill() ends stdin while the child is still alive: _alive is still true, so the old write()
//    guard passed and the write landed on a closed pipe. Must now be a no-op.
{
  const cli = fakePi("slow", "setTimeout(() => process.exit(0), 4000);\n");
  const { rpc, exited, logs } = makeChild(cli);
  await new Promise((r) => setTimeout(r, 150));
  rpc.kill(); // stdin.end(), child survives up to its 1500 ms grace
  check("kill(): rpc 仍认为活着（复现前提交窗口）", rpc.alive === true, `alive=${rpc.alive}`);
  let threw = null;
  let wrote = null;
  try {
    wrote = rpc.uiRespond({ id: "u1", cancelled: true });
  } catch (err) {
    threw = err;
  }
  check("kill(): uiRespond 不再抛错", threw === null, threw ? String(threw.message) : "");
  check("kill(): uiRespond 返回 false（没写成）", wrote === false, `returned=${wrote}`);
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  rpc.killNow();
  check("kill(): 进程没有因 EPIPE 崩掉", true, `logs=${logs.length}`);
}

// 2. Child already exited, then a late ui_request response arrives (the buffered-line race).
{
  const cli = fakePi(
    "fast",
    `process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "u2", method: "custom", title: "x" }) + "\\n");\n` +
      `process.exit(0);\n`,
  );
  const { rpc, exited } = makeChild(cli);
  const req = await new Promise((resolve) => rpc.once("ui_request", resolve));
  check("exit 后：收到 ui_request", req?.id === "u2", `id=${req?.id}`);
  await exited;
  check("exit 后：alive 已翻成 false", rpc.alive === false);
  let threw = null;
  let wrote = null;
  try {
    wrote = rpc.uiRespond({ id: String(req?.id ?? ""), cancelled: true });
  } catch (err) {
    threw = err;
  }
  check("exit 后：uiRespond 不抛错", threw === null, threw ? String(threw.message) : "");
  check("exit 后：uiRespond 返回 false", wrote === false, `returned=${wrote}`);
  // request() must reject rather than hang or throw synchronously.
  let rejected = false;
  await rpc.request("get_state", {}, 1000).then(
    () => {},
    () => (rejected = true),
  );
  check("exit 后：request() 立刻 reject", rejected);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
