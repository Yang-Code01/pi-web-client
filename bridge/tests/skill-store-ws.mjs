/**
 * 技能商店 (D126) 的桥侧线上行为：真的起一个 bridge，走 WS 说话。
 *
 *   · `skill.installed` 扫出本机技能（带路径、可删标记）；
 *   · `skill.source` 用本机目录当来源，列出里面的技能（不联网）；
 *   · `skill.install` / `skill.remove` 要 step-up，装完磁盘上真有东西，卸载后真的没了；
 *   · 项目目录只能读：卸载被拒；短查询被拒（不需要联网）。
 *
 * 搜索（skills.sh / jsDelivr）不在这里联网测：那是 `probes/skill-store.mjs`（桩桥）和
 * `bridge/tests/skill-store.mjs`（假网）的事。
 *
 *   npm run build:bridge && node bridge/tests/skill-store-ws.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 7914;
const ROOT = path.join(REPO, ".scratch", "skill-store-ws");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const HOME = path.join(ROOT, "home");
const PROJECT = path.join(ROOT, "project");
const SRC = path.join(ROOT, "src-skills");
const BASE = `http://127.0.0.1:${PORT}`;

fs.rmSync(ROOT, { recursive: true, force: true });
for (const dir of [STATE, path.join(AGENT, "skills"), path.join(HOME, ".agents", "skills"), PROJECT]) fs.mkdirSync(dir, { recursive: true });

// One user skill already on disk (a junction, like the real ~/.agents/skills installs).
const realSkill = path.join(SRC, "linked-skill");
fs.mkdirSync(realSkill, { recursive: true });
fs.writeFileSync(path.join(realSkill, "SKILL.md"), "---\nname: linked-skill\ndescription: 已经装好的那个\n---\n");
// A skill in a local directory the store will install from.
const localSkill = path.join(SRC, "batch", "from-disk");
fs.mkdirSync(path.join(localSkill, "scripts"), { recursive: true });
fs.writeFileSync(path.join(localSkill, "SKILL.md"), "---\nname: from-disk\ndescription: 从本机目录装的\n---\n");
fs.writeFileSync(path.join(localSkill, "scripts", "run.sh"), "#!/bin/sh\necho hi\n");
// A project skill: listed as read-only, refused by uninstall.
const projectSkill = path.join(PROJECT, ".pi", "skills", "project-only");
fs.mkdirSync(projectSkill, { recursive: true });
fs.writeFileSync(path.join(projectSkill, "SKILL.md"), "---\nname: project-only\ndescription: 项目里的\n---\n");

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = false;
const check = (cond, msg) => {
  if (cond) log("  ok  ", msg);
  else {
    failed = true;
    console.error("  FAIL", msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return;
    } catch {
      /* not yet */
    }
    await sleep(150);
  }
  throw new Error(`timeout: ${label}`);
};

const env = { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_TUNNEL: "0", PI_AGENT_DIR: AGENT, PI_CODING_AGENT_DIR: AGENT, USERPROFILE: HOME, HOME };
delete env.PI_BIN;
const bridgeOut = [];
const bridge = spawn(process.execPath, ["bridge/dist/index.js"], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));

const sockets = [];
async function page(cookie, extraHeaders = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie, ...extraHeaders } });
  const seen = [];
  const waits = [];
  ws.on("message", (buf) => {
    const m = JSON.parse(buf.toString());
    seen.push(m);
    for (const w of [...waits]) {
      if (w.pred(m)) {
        waits.splice(waits.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(m);
      }
    }
  });
  await new Promise((r) => ws.on("open", r));
  const waitFor = (pred, ms, what, from = 0) => {
    const hit = seen.slice(from).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => {
        waits.splice(waits.indexOf(w), 1);
        reject(new Error(`timeout: ${what}`));
      }, ms);
      waits.push(w);
    });
  };
  const ask = async (m, pred, what, ms = 30000) => {
    const mark = seen.length;
    ws.send(JSON.stringify(m));
    return waitFor(pred, ms, what, mark);
  };
  sockets.push(ws);
  return { ws, seen, waitFor, ask };
}

try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: pass }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const a = await page(cookie);
  await a.waitFor((m) => m.type === "hello", 8000, "hello");

  // ---- A. 已安装清单
  log("A. skill.installed");
  const inst = await a.ask({ type: "skill.installed", cwd: PROJECT }, (m) => m.type === "skill.installed", "installed");
  const names = inst.items.map((s) => s.name).sort();
  check(JSON.stringify(names) === JSON.stringify(["project-only"]), `只列出真正在盘上的技能：${JSON.stringify(names)}`);
  const proj = inst.items.find((s) => s.name === "project-only");
  check(proj.removable === false && String(proj.root).startsWith(PROJECT), "项目技能不可删，root 指向项目目录");
  check(typeof proj.path === "string" && fs.existsSync(proj.path), "清单带绝对路径");

  // ---- B. 本机目录当来源
  log("B. skill.source（本机目录）");
  const src = await a.ask({ type: "skill.source", source: path.join(SRC, "batch") }, (m) => m.type === "skill.source", "source");
  check(!src.error && src.kind === "local" && src.items.length === 1, `列出 ${src.items?.length} 个：${JSON.stringify(src.items?.map((i) => i.name))}`);
  check(src.items[0].path === localSkill && src.items[0].local === true, "条目里是本机绝对路径");

  const bad = await a.ask({ type: "skill.source", source: "不存在的地址 //" }, (m) => m.type === "skill.source", "bad source");
  check(Boolean(bad.error) && bad.errCode === "skill_source_failed", `认不出的地址回错误：${bad.error}`);

  // ---- C. 短查询：本地就该拒，不用联网
  log("C. skill.store（短查询）");
  const short = await a.ask({ type: "skill.store", query: "p", limit: 20 }, (m) => m.type === "skill.store", "short query");
  check(short.errCode === "skill_store_failed" && String(short.error).includes("2 个字符"), `一个字被拒：${short.error}`);

  // ---- D. 本机直接能写（D15：回环 / 局域网不算外网），公网隧道只读
  log("D. 公网连接只读");
  const pub = await page(cookie, { "cf-connecting-ip": "203.0.113.7" });
  await pub.waitFor((m) => m.type === "hello", 8000, "hello (tunnel)");
  const pubInstall = await pub.ask({ type: "skill.install", reqId: "p1", local: localSkill, scope: "user" }, (m) => m.type === "skill.install.done", "public install");
  check(pubInstall.ok === false && pubInstall.errCode === "skill_public", `隧道上不让装：${pubInstall.error}`);
  const pubRemove = await pub.ask({ type: "skill.remove", reqId: "p2", path: localSkill }, (m) => m.type === "skill.remove.done", "public remove");
  check(pubRemove.ok === false && pubRemove.errCode === "skill_public", "隧道上不让卸");
  const pubList = await pub.ask({ type: "skill.store", query: "p", limit: 20 }, (m) => m.type === "skill.store", "public search");
  check(pubList.errCode === "skill_store_failed", "隧道上仍可以搜（只读）；短查询先报本地错误");
  pub.ws.close();

  // ---- E. 装进用户目录
  log("E. skill.install（本机目录 → 用户技能）");
  const doneMsg = await a.ask({ type: "skill.install", reqId: "r2", local: localSkill, scope: "user" }, (m) => m.type === "skill.install.done", "install");
  check(doneMsg.ok === true, `装好了：${JSON.stringify({ name: doneMsg.name, files: doneMsg.files, error: doneMsg.error })}`);
  check(doneMsg.reqId === "r2", "回执带着页面的 reqId");
  const target = path.join(AGENT, "skills", "from-disk");
  check(fs.existsSync(path.join(target, "SKILL.md")) && fs.existsSync(path.join(target, "scripts", "run.sh")), "磁盘上有 SKILL.md 和脚本");
  check(JSON.parse(fs.readFileSync(path.join(target, ".pi-store.json"), "utf8")).local === localSkill, "来源写在 .pi-store.json");

  const list2 = await a.ask({ type: "skill.installed", cwd: PROJECT }, (m) => m.type === "skill.installed", "installed again");
  const fromDisk = list2.items.find((s) => s.name === "from-disk");
  check(Boolean(fromDisk) && fromDisk.removable === true && fromDisk.from === localSkill, `清单里出现，带来源 ${fromDisk?.from}`);

  // ---- F. 同名不覆盖（手工放的技能 vs 商店装的）
  log("F. 同名技能不被覆盖");
  const handmade = path.join(AGENT, "skills", "handmade");
  fs.mkdirSync(handmade, { recursive: true });
  fs.writeFileSync(path.join(handmade, "SKILL.md"), "---\nname: handmade\ndescription: 自己放的\n---\n");
  const clash = await a.ask({ type: "skill.install", reqId: "r3", local: localSkill, scope: "user", name: "handmade" }, (m) => m.type === "skill.install.done", "clash");
  check(clash.ok === false && String(clash.error).includes("已经有同名技能"), `手工的同名技能不被覆盖：${clash.error}`);
  check(fs.readFileSync(path.join(handmade, "SKILL.md"), "utf8").includes("自己放的"), "手工那份没被动");
  const reinstall = await a.ask({ type: "skill.install", reqId: "r3b", local: localSkill, scope: "user" }, (m) => m.type === "skill.install.done", "reinstall");
  check(reinstall.ok === true, "同一来源可以重装（跨会话再点一次安装）");

  // ---- G. 项目范围
  log("G. skill.install（项目范围）");
  const projInstall = await a.ask({ type: "skill.install", reqId: "r4", local: localSkill, scope: "project", cwd: PROJECT, name: "in-project" }, (m) => m.type === "skill.install.done", "project install");
  check(projInstall.ok === true && fs.existsSync(path.join(PROJECT, ".pi", "skills", "in-project", "SKILL.md")), "装进 <cwd>/.pi/skills");
  const noCwd = await a.ask({ type: "skill.install", reqId: "r5", local: localSkill, scope: "project", name: "no-cwd" }, (m) => m.type === "skill.install.done", "no cwd");
  check(noCwd.ok === false && String(noCwd.error).includes("会话"), `没 cwd 拒绝：${noCwd.error}`);

  // ---- H. 卸载
  log("H. skill.remove");
  const projRemove = await a.ask({ type: "skill.remove", reqId: "r6", path: path.join(PROJECT, ".pi", "skills", "in-project") }, (m) => m.type === "skill.remove.done", "project remove");
  check(projRemove.ok === false && String(projRemove.error).includes("只能删用户技能目录"), `项目技能拒绝卸载：${projRemove.error}`);
  check(fs.existsSync(path.join(PROJECT, ".pi", "skills", "in-project", "SKILL.md")), "项目技能还在");

  const userRemove = await a.ask({ type: "skill.remove", reqId: "r7", path: target }, (m) => m.type === "skill.remove.done", "user remove");
  check(userRemove.ok === true && !fs.existsSync(target), "用户技能卸载后目录没了");

  // ---- I. 链接只断链
  log("I. 链接技能");
  const linkDir = path.join(HOME, ".agents", "skills", "linked-skill");
  // Windows without developer mode cannot make symlinks as an unprivileged user; a junction is the
  // same thing for Node's lstat and is what the real skill installs use anyway.
  if (process.platform === "win32") spawnSync("cmd", ["/c", "mklink", "/J", linkDir, realSkill], { windowsHide: true });
  else fs.symlinkSync(realSkill, linkDir, "dir");
  const list3 = await a.ask({ type: "skill.installed", cwd: PROJECT }, (m) => m.type === "skill.installed", "installed with link");
  const linked = list3.items.find((s) => s.name === "linked-skill");
  check(Boolean(linked) && linked.link === true && linked.removable === true, "链接装的技能在清单里，标着 link");
  if (linked) {
    const removed = await a.ask({ type: "skill.remove", reqId: "r8", path: linked.path }, (m) => m.type === "skill.remove.done", "unlink");
    check(removed.ok === true && removed.link === true, "卸载的是链接本身");
    check(fs.existsSync(path.join(realSkill, "SKILL.md")), "链接指向的目录还在");
  }
} catch (err) {
  failed = true;
  console.error("FAIL", err?.message ?? err);
  const tail = bridgeOut.join("").split("\n").slice(-12).join("\n");
  if (tail.trim()) console.error(tail);
} finally {
  for (const ws of sockets) ws.close();
  bridge.kill();
}
console.log(failed ? "\nFAILED" : "\nALL OK");
process.exit(failed ? 1 : 0);
