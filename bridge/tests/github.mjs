/**
 * GitHub 通道（`bridge/src/github.ts` + `bridge/src/github-shim.ts` + `bridge/ext/approval-gate.ts`）：
 * 三块各测一层，最后一块是真的端到端。
 *
 *   node --experimental-strip-types bridge/tests/github.mjs
 *
 * A. 纯函数：`gh auth status` 的文本解析、远端 URL 的两种写法、从输出里认链接。
 * B. 审批闸：`gh pr merge` 要被问，`gh pr create` 不该被问（建 PR 是 AI 的本职活）。
 * C. 壳：起一个只实现两条 shim 路由的假桥，用**真 gh、真令牌**跑一次
 *    `gh api user --jq .login` —— 身份给的是那台机器上**不是 active** 的账号，输出必须是它。
 *    这一条就是整套设计的命门：账号由会话决定，而不是机器上的 active 账号。
 *
 * C 需要本机装了 gh 且至少登录了一个账号、能连 GitHub；不满足就跳过（不作为失败）。
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { repoFromRemote, parseAuthStatus, seenLinks } from "../src/github.ts";
import approvalGate from "../ext/approval-gate.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SHIM = path.join(ROOT, "bridge", "dist", "github-shim.js");

let failed = false;
let n = 0;
function check(ok, label, extra = "") {
  if (!ok) failed = true;
  console.log(`${ok ? "  ok" : "  FAIL"} ${++n}  ${label}${extra ? `  (${extra})` : ""}`);
}

// ---------------------------------------------------------------- A. 纯函数

console.log("A. 纯函数");
const parsed = parseAuthStatus(
  [
    "github.com",
    "  ✓ Logged in to github.com account Yang-Code01 (keyring)",
    "  - Active account: true",
    "  - Git operations protocol: https",
    "",
    "  ✓ Logged in to github.com account qingmin-new (keyring)",
    "  - Active account: false",
  ].join("\n"),
);
check(parsed.length === 2 && parsed[0].login === "Yang-Code01" && parsed[0].active === true, "两个账号，第一个是 active", JSON.stringify(parsed));
check(parsed[1].login === "qingmin-new" && parsed[1].active === false, "第二个账号不是 active");
check(parseAuthStatus("You are not logged into any GitHub hosts.").length === 0, "没登录时不编造账号");

for (const [raw, want] of [
  ["git@github.com:Yang-Code01/pi-web-client.git", "Yang-Code01/pi-web-client"],
  ["https://github.com/Yang-Code01/pi-web-client", "Yang-Code01/pi-web-client"],
  ["https://github.com/Yang-Code01/pi-web-client.git", "Yang-Code01/pi-web-client"],
  ["ssh://git@github.com/Yang-Code01/pi-web-client.git", "Yang-Code01/pi-web-client"],
  ["https://gitlab.com/a/b", null],
  ["", null],
]) {
  check(repoFromRemote(raw) === want, `远端 "${raw}" → ${String(want)}`, String(repoFromRemote(raw)));
}

const out = "https://github.com/a/b/pull/12\nhttps://github.com/a/b/pull/12\nhttps://github.com/a/b/commit/deadbeef\n";
const links = seenLinks(out);
check(links.length === 2, "同一行的重复链接只认一次", `${links.length} 条`);
check(links[0].kind === "pull" && links[0].repo === "a/b" && links[0].id === "12", "认出 pull 的仓库与号");
check(links[1].kind === "commit" && links[1].id === "deadbeef", "认出 commit");
check(seenLinks("nothing here").length === 0, "没有链接时返回空");

// ---------------------------------------------------------------- B. 审批闸

console.log("B. 审批闸");
const allow = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gh-gate-")), "allow.json");
process.env.PI_WEB_ALLOW_FILE = allow;
const handlers = {};
approvalGate({ on: (ev, fn) => (handlers[ev] = fn), getAllTools: () => [], registerTool: () => {} });
const asked = [];
const ctx = { cwd: ROOT, hasUI: true, ui: { confirm: async (title, msg) => (asked.push(`${title} | ${msg}`), false) } };
async function gateFor(cmd, mode = "ask") {
  fs.writeFileSync(allow, JSON.stringify({ mode, patterns: [] }));
  asked.length = 0;
  const r = await handlers.tool_call({ toolName: "bash", input: { command: cmd } }, ctx);
  return { asked: asked.length > 0, blocked: Boolean(r?.block), why: asked[0] ?? "" };
}
check((await gateFor("gh pr merge 659 --squash")).asked, "`gh pr merge` 要问一声");
check((await gateFor("gh api -X PUT repos/a/b/pulls/1/merge -f merge_method=merge")).asked, "走 API 直接合并也要问一声");
const create = await gateFor("gh pr create --fill --title 'x'");
check(!create.asked && !create.blocked, "`gh pr create` 不问 —— 建 PR 是 AI 的本职活");

// ---------------------------------------------------------------- C. 壳（真 gh、真令牌）

console.log("C. 壳");

function ghRun(args) {
  return new Promise((resolve) => {
    execFile("gh", args, { encoding: "utf8", timeout: 15_000, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err.code ?? 1) | 0) : 0, stdout: stdout ?? "", stderr: stderr ?? "" }),
    );
  });
}

const status = await ghRun(["auth", "status"]);
const accounts = parseAuthStatus(`${status.stdout}\n${status.stderr}`);
if (!fs.existsSync(SHIM)) {
  console.log("  跳过：没有 bridge/dist/github-shim.js（先跑 npm run build:bridge）");
} else if (accounts.length === 0) {
  console.log("  跳过：这台机器没有登录的 gh 账号");
} else {
  // 优先用**不是 active** 的那个：那才证明「按会话选账号」真的盖过了机器上的默认。
  const pick = accounts.find((a) => !a.active) ?? accounts[0];
  const tokenRun = await ghRun(["auth", "token", "--user", pick.login]);
  const token = tokenRun.stdout.trim();
  const realGh = (await new Promise((r) => execFile(process.platform === "win32" ? "where" : "which", ["gh"], { encoding: "utf8" }, (e, o) => r(e ? "" : o.trim().split(/\r?\n/)[0])))) || null;
  if (!token || !realGh) {
    console.log("  跳过：拿不到 gh 的令牌或路径");
  } else {
    const reports = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url === "/api/github/shim/identity") {
          res.end(JSON.stringify({ ok: true, login: pick.login, source: "session", token, realGh, sessionId: "s1", cwd: ROOT, api: null }));
          return;
        }
        if (req.url === "/api/github/shim/report") {
          reports.push(body);
          res.end(JSON.stringify({ ok: true, opened: false }));
          return;
        }
        res.end("{}");
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const runShim = (args) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [SHIM, ...args], {
          env: { ...process.env, PI_WEB_LOOPBACK: base, PI_WEB_LOOPBACK_TOKEN: "tok" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (b) => (stdout += b));
        child.stderr.on("data", (b) => (stderr += b));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });

    const who = await runShim(["api", "user", "--jq", ".login"]);
    check(who.stdout.trim() === pick.login, `壳把调用落到了会话账号 ${pick.login}（不是 active）`, who.stdout.trim() || who.stderr.trim());
    await new Promise((r) => setTimeout(r, 150));
    const first = reports[0];
    check(Boolean(first) && JSON.stringify(first.argv) === JSON.stringify(["api", "user", "--jq", ".login"]), "壳把这次调用回报给了桥");
    check(Boolean(first) && first.login === pick.login && first.exit === 0, "回报里带着账号与退出码");

    reports.length = 0;
    const view = await runShim(["pr", "view", "659", "--repo", "Yang-Code01/pi-web-client"]);
    await new Promise((r) => setTimeout(r, 150));
    check(Boolean(reports[0]) && reports[0].argv[0] === "pr" && reports[0].argv[1] === "view", "`pr view` 也被记账");

    // 没装 gh 的那一档：身份说 realGh=null、没有令牌 → 只报「去哪儿配」，不假装成功。
    const server2 = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, login: pick.login, source: "session", token: null, realGh: null, sessionId: "s1", cwd: ROOT, api: null }));
      });
    });
    await new Promise((r) => server2.listen(0, "127.0.0.1", r));
    const base2 = `http://127.0.0.1:${server2.address().port}`;
    const runBuiltin = (args) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [SHIM, ...args], { env: { ...process.env, PI_WEB_LOOPBACK: base2, PI_WEB_LOOPBACK_TOKEN: "tok" }, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (b) => (stdout += b));
        child.stderr.on("data", (b) => (stderr += b));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
    const authOut = await runBuiltin(["auth", "status"]);
    check(authOut.code === 0 && authOut.stdout.includes(pick.login), "没装 gh 时 `auth status` 照样说得出在用谁");
    const denied = await runBuiltin(["issue", "list"]);
    check(denied.code === 1 && /内置实现只覆盖 PR 核心/.test(denied.stderr), "内置实现不假装支持整条 gh 命令行", denied.stderr.trim().split(/\r?\n/)[0]);
    server2.close();
    server.close();
  }
}

console.log(failed ? "\n有断言没过" : `\n全部通过（${n} 条）`);
process.exit(failed ? 1 : 0);
