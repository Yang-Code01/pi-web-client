// D328：BrowserWatch 只认运行时真实发生的事（拉起浏览器 / 连上调试端口）。纯函数测试喂假快照。
import { test } from "node:test";
import assert from "node:assert/strict";
import { evidenceFrom, parseNetstat, parseLsof, etimeMs, browserName, BrowserWatch } from "../src/browser-watch.ts";

const PI = 100;
const proc = (pid, ppid, name, created) => ({ pid, ppid, name, created });
const watch = (entries) => new Map(entries.map(([id, startedAt]) => [id, { startedAt, roots: new Set() }]));

test("工具起的 python 拉起了 headless chromium → launch", () => {
  const snap = {
    procs: [proc(PI, 1, "node.exe", 0), proc(200, PI, "bash.exe", 5_000), proc(201, 200, "python.exe", 5_100), proc(202, 201, "node.exe", 5_200), proc(203, 202, "chrome-headless-shell.exe", 5_300)],
    conns: [],
    listens: [],
  };
  const out = evidenceFrom(snap, PI, watch([["t1", 4_900]]), new Map(), 6_000);
  assert.deepEqual(out.get("t1"), { kind: "launch", browser: "chrome-headless-shell", headless: true, at: 6_000 });
});

test("连上早就开着的浏览器的调试端口 → cdp；浏览器不在树里也不算 launch", () => {
  const snap = {
    procs: [proc(PI, 1, "node.exe", 0), proc(50, 1, "chrome.exe", 10), proc(200, PI, "bash.exe", 5_000), proc(201, 200, "python.exe", 5_100)],
    conns: [{ pid: 201, remotePort: 9333 }],
    listens: [{ pid: 50, port: 9333 }],
  };
  const out = evidenceFrom(snap, PI, watch([["t1", 4_900]]), new Map(), 6_000);
  assert.deepEqual(out.get("t1"), { kind: "cdp", browser: "chrome", port: 9333, at: 6_000 });
});

test("隔一层 daemon（命令行 → daemon → 浏览器）也算 cdp", () => {
  const snap = {
    procs: [proc(PI, 1, "node.exe", 0), proc(60, 1, "node.exe", 20), proc(61, 60, "chrome.exe", 30), proc(200, PI, "bash.exe", 5_000), proc(201, 200, "agent-browser.exe", 5_100)],
    conns: [{ pid: 201, remotePort: 4100 }, { pid: 60, remotePort: 9222 }],
    listens: [{ pid: 60, port: 4100 }, { pid: 61, port: 9222 }],
  };
  assert.equal(evidenceFrom(snap, PI, watch([["t1", 4_900]]), new Map(), 6_000).get("t1")?.kind, "cdp");
});

test("工具开始前就在的常驻子进程（MCP 服务器）底下的浏览器不归任何工具", () => {
  const snap = {
    procs: [proc(PI, 1, "node.exe", 0), proc(150, PI, "node.exe", 1_000), proc(151, 150, "chrome.exe", 1_200), proc(200, PI, "bash.exe", 5_000), proc(201, 200, "git.exe", 5_100)],
    conns: [],
    listens: [],
  };
  assert.equal(evidenceFrom(snap, PI, watch([["t1", 4_900]]), new Map(), 6_000).size, 0);
});

test("连本机别的端口（dev server）不算；pid 重用的假父子关系不算", () => {
  const snap = {
    procs: [proc(PI, 1, "node.exe", 0), proc(200, PI, "bash.exe", 5_000), proc(201, 200, "curl.exe", 5_100), proc(300, 201, "chrome.exe", 10)],
    conns: [{ pid: 201, remotePort: 5173 }],
    listens: [{ pid: 999, port: 5173 }],
  };
  assert.equal(evidenceFrom(snap, PI, watch([["t1", 4_900]]), new Map(), 6_000).size, 0);
});

test("两个工具在跑：新子进程归最晚开始、且早于它出现的那个", () => {
  const snap = {
    procs: [proc(PI, 1, "node.exe", 0), proc(200, PI, "bash.exe", 3_100), proc(201, PI, "bash.exe", 8_100), proc(202, 201, "msedge.exe", 8_200)],
    conns: [],
    listens: [],
  };
  const out = evidenceFrom(snap, PI, watch([["old", 3_000], ["new", 8_000]]), new Map(), 9_000);
  assert.deepEqual([...out.keys()], ["new"]);
});

test("BrowserWatch：取样中途工具结束不再上报；找到一次后不再重复上报", async () => {
  let snap = { procs: [proc(PI, 1, "node.exe", 0), proc(200, PI, "bash.exe", Date.now() + 10), proc(201, 200, "chrome.exe", Date.now() + 20)], conns: [], listens: [] };
  const seen = [];
  const w = new BrowserWatch({ rootPid: () => PI, onEvidence: (id, ev) => seen.push([id, ev.kind]), sampler: async () => snap, intervalMs: 60_000 });
  w.start("t1");
  await w.tick();
  await w.tick();
  assert.deepEqual(seen, [["t1", "launch"]]);
  w.start("t2");
  const slow = new BrowserWatch({ rootPid: () => PI, onEvidence: (id) => seen.push([id, "late"]), sampler: async () => { slow.end("t3"); return snap; }, intervalMs: 60_000 });
  slow.start("t3");
  await slow.tick();
  assert.ok(!seen.some(([id]) => id === "t3"));
  w.dispose();
  slow.dispose();
});

test("解析 netstat / lsof / etime / 浏览器名", () => {
  const net = parseNetstat([
    "  TCP    127.0.0.1:9333         0.0.0.0:0              LISTENING       50",
    "  TCP    127.0.0.1:51000        127.0.0.1:9333         ESTABLISHED     201",
    "  TCP    10.0.0.2:51001         20.1.1.1:443           ESTABLISHED     202",
    "  TCP    [::1]:51002            [::1]:9222             ESTABLISHED     203",
  ].join("\r\n"));
  assert.deepEqual(net.listens, [{ pid: 50, port: 9333 }]);
  assert.deepEqual(net.conns, [{ pid: 201, remotePort: 9333 }, { pid: 203, remotePort: 9222 }]);
  const lsof = parseLsof([
    "Google    50 me   20u  IPv4 0x1      0t0  TCP 127.0.0.1:9333 (LISTEN)",
    "Python   201 me    5u  IPv4 0x2      0t0  TCP 127.0.0.1:51000->127.0.0.1:9333 (ESTABLISHED)",
  ].join("\n"));
  assert.deepEqual(lsof, { listens: [{ pid: 50, port: 9333 }], conns: [{ pid: 201, remotePort: 9333 }] });
  assert.equal(etimeMs("01:02"), 62_000);
  assert.equal(etimeMs("1-00:00:01"), 86_401_000);
  assert.equal(browserName("C:\\x\\msedge.exe"), "msedge");
  assert.equal(browserName("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), "google chrome");
  assert.equal(browserName("node.exe"), null);
});
