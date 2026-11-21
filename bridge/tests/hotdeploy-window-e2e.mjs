/**
 * 热部署的循环窗口，端到端（只在 Windows 上跑，会开一扇最小化的 PowerShell 窗口）：
 *   node bridge/tests/hotdeploy-window-e2e.mjs
 * ① windowHostOf 认得出「桥跑在本端口的循环窗口里」，别的端口不认；
 * ② 放了 relaunch 标记再杀桥 → 同一扇窗口（同一个父 pid）原地起新桥，标记被收走；
 * ③ 没有标记时杀桥 → 窗口随桥一起关（关窗即停 / 杀桥即关，D154 的语义不变）；
 * ④ 桥打的中文日志不能在窗口里被按代码页解成乱码（D378：PS 5.1 在真控制台里按 936
 *    解原生命令输出，node 吐的是 UTF-8，于是「已启动」变成「宸插惎鍔紝」）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { psQuote, windowHostOf, windowScript } from "../../scripts/hotdeploy-window.mjs";
if (process.platform !== "win32") {
  console.log("hotdeploy-window-e2e: skip（非 Windows）");
  process.exit(0);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hdwin-"));
fs.mkdirSync(path.join(root, "bridge", "dist"), { recursive: true });
const pidLog = path.join(root, "pids.txt");
fs.writeFileSync(path.join(root, "bridge", "dist", "index.js"),
  `require("fs").appendFileSync(${JSON.stringify(pidLog)}, process.pid + "," + process.ppid + require("os").EOL); setInterval(() => {}, 1e6);`);
const relaunch = path.join(root, "relaunch-7999"); const script = path.join(root, "bridge-window-7999.ps1");
fs.writeFileSync(script, windowScript({ repo: root, port: 7999, node: process.execPath, live: path.join(root, "live.log"), relaunch }));
const ps = (c) => spawnSync("powershell", ["-NoProfile", "-Command", c], { encoding: "utf8", windowsHide: true });
const alive = (p) => ps(`if (Get-Process -Id ${p} -EA SilentlyContinue) {'y'}`).stdout.trim() === "y";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = () => (fs.existsSync(pidLog) ? fs.readFileSync(pidLog, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(",").map(Number)) : []);
async function waitRows(n) { for (let i = 0; i < 80 && rows().length < n; i++) await sleep(200); return rows(); }
ps(`Start-Process powershell -WindowStyle Minimized -ArgumentList ${psQuote(`-NoProfile -ExecutionPolicy Bypass -File "${script}"`)}`);
let r = await waitRows(1); if (!r.length) { console.log("RED: 第一次没起来"); process.exit(1); }
const [p1, host] = r[0];
const found = windowHostOf(p1, 7999), other = windowHostOf(p1, 7998);
console.log(found === host && other === null ? `GREEN: windowHostOf 认出窗口 ${host}` : `RED: windowHostOf ${found}/${other} ≠ ${host}`);
if (found !== host || other !== null) process.exitCode = 1;
fs.writeFileSync(relaunch, "x"); spawnSync("taskkill", ["/PID", String(p1), "/F"], { windowsHide: true });
r = await waitRows(2);
const ok1 = r.length === 2 && r[1][1] === host && !fs.existsSync(relaunch);
console.log(ok1 ? `GREEN: 同一窗口 ${host} 重起 ${p1} → ${r[1][0]}` : `RED: 没在同一窗口重起 ${JSON.stringify(r)}`);
spawnSync("taskkill", ["/PID", String(r.at(-1)[0]), "/F"], { windowsHide: true });
for (let i = 0; i < 25 && alive(host); i++) await sleep(200);
const ok2 = !alive(host) && rows().length === 2;
console.log(ok2 ? "GREEN: 无标记时窗口随桥关闭" : "RED: 无标记时窗口没关 / 又起了一次");
if (alive(host)) spawnSync("taskkill", ["/PID", String(host), "/F", "/T"], { windowsHide: true });
fs.rmSync(root, { recursive: true, force: true });

// ④ 中文日志：另起一个临时仓库，桥只打两行中文就退出（没有 relaunch 标记，窗口自己关）。
// 用真窗口（Start-Process）跑：被重定向到管道时 PS 按 UTF-8 解原生输出，看不出这个 bug。
const zhRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hdzh-"));
const zhLive = path.join(zhRoot, "live.log");
fs.mkdirSync(path.join(zhRoot, "bridge", "dist"), { recursive: true });
fs.writeFileSync(path.join(zhRoot, "bridge", "dist", "index.js"),
  `console.log(${JSON.stringify("中文测试 已启动 http://127.0.0.1:7998")});` +
  ` console.error(${JSON.stringify("银锭拷：系统告警")});`);
const zhScript = path.join(zhRoot, "bridge-window-7998.ps1");
fs.writeFileSync(zhScript, windowScript({ repo: zhRoot, port: 7998, node: process.execPath, live: zhLive, relaunch: path.join(zhRoot, "relaunch-7998") }));
ps(`Start-Process powershell -WindowStyle Minimized -ArgumentList ${psQuote(`-NoProfile -ExecutionPolicy Bypass -File "${zhScript}"`)}`);
const zhText = () => (fs.existsSync(zhLive) ? fs.readFileSync(zhLive, "utf16le") : "");
const want = ["中文测试 已启动 http://127.0.0.1:7998", "银锭拷：系统告警"];
const mojibake = ["涓枃", "宸插惎鍔", "閾跺畾"];
// 两行都到了就断；先看到乱码也断（不必等剩下的行，结论已经明确）。
let zh = "";
for (let i = 0; i < 60; i++) {
  zh = zhText();
  if (want.every((s) => zh.includes(s)) || mojibake.some((s) => zh.includes(s))) break;
  await sleep(200);
}
await sleep(400); zh = zhText();
const ok3 = want.every((s) => zh.includes(s)) && !mojibake.some((s) => zh.includes(s));
console.log(ok3 ? "GREEN: 中文日志在窗口里没被解成乱码" : `RED: 日志乱码 / 缺行 ${JSON.stringify(zh.slice(0, 200))}`);
fs.rmSync(zhRoot, { recursive: true, force: true });
process.exit(ok1 && ok2 && ok3 && !process.exitCode ? 0 : 1);
