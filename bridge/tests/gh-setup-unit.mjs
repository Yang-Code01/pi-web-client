/**
 * 装 gh 的「计划」与设备码解析（D428）：这两块是纯函数，先把最容易写错的平台差异钉住。
 *
 *   node --experimental-strip-types bridge/tests/gh-setup-unit.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-gh-setup-")));
process.env.PI_WEB_STATE = path.join(tmp, "state");
process.env.PI_AGENT_DIR = path.join(tmp, "agent");
fs.mkdirSync(process.env.PI_WEB_STATE, { recursive: true });
fs.mkdirSync(process.env.PI_AGENT_DIR, { recursive: true });

const { ghSetupStatus, installPlan, parseLoginHint } = await import("../src/gh-setup.ts");

test("Windows：有 winget 就跑官方包，且这条路要提权", () => {
  const plan = installPlan("win32", (name) => name === "winget", false);
  assert.equal(plan.manager, "winget");
  assert.match(plan.text, /winget install --id GitHub\.cli -e/);
  assert.equal(plan.elevated, true);
  assert.ok(plan.run, "winget 能自动跑");
  assert.equal(plan.run.cmd, "winget");
  assert.match(plan.run.args.join(" "), /--accept-package-agreements/);
});

test("Windows：没有 winget 也不给一条会自动失败的命令", () => {
  const plan = installPlan("win32", () => false, false);
  assert.equal(plan.manager, "");
  assert.equal(plan.run, null);
  assert.equal(plan.text, "");
  assert.equal(plan.url, "https://cli.github.com/");
});

test("macOS：brew 不需要提权", () => {
  const plan = installPlan("darwin", (name) => name === "brew", false);
  assert.equal(plan.manager, "brew");
  assert.equal(plan.elevated, false);
  assert.deepEqual(plan.run, { cmd: "brew", args: ["install", "gh"] });
});

test("Linux：每次都用 sudo，但只有 root 才替用户跑", () => {
  const user = installPlan("linux", (name) => name === "apt-get", false);
  assert.equal(user.manager, "apt-get");
  assert.match(user.text, /^sudo apt-get install -y gh$/);
  assert.equal(user.run, null, "非 root 不能替用户提权");
  assert.equal(user.elevated, true);

  const root = installPlan("linux", (name) => name === "apt-get", true);
  assert.ok(root.run, "root 可以直接跑（不需要 sudo）");
  assert.equal(root.run.cmd, "apt-get");
  assert.match(root.run.args.join(" "), /install -y gh/);
});

test("设备码：从 gh 的 stdout 里认出码与授权地址", () => {
  const text = [
    "! First copy your one-time code: 00B6-D11A",
    "Open this URL to continue in your web browser: https://github.com/login/device",
    "",
  ].join("\n");
  assert.deepEqual(parseLoginHint(text), { code: "00B6-D11A", url: "https://github.com/login/device" });
});

test("设备码：还没有码 / 只有 URL 时不要瞎报", () => {
  assert.deepEqual(parseLoginHint("Open this URL to continue in your web browser: https://github.com/login/device"), {
    code: "",
    url: "https://github.com/login/device",
  });
  assert.deepEqual(parseLoginHint(""), { code: "", url: "" });
});

test("没装 gh 时状态是 installed:false，并带一份可执行的计划（而不是一句「去装」）", async () => {
  const status = await ghSetupStatus({ ghPath: null });
  assert.equal(status.installed, false);
  assert.equal(status.loggedIn, false);
  assert.equal(status.path, "");
  assert.equal(typeof status.plan.text, "string");
  assert.ok(status.plan.url.startsWith("https://cli.github.com/"));
  assert.ok(["win32", "darwin", "linux"].includes(status.platform));
});
