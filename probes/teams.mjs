#!/usr/bin/env node
/**
 * 网页版 Teams 的现场探针：对着**真桥**跑一遍「开窗口 → 读会话 → 读消息 → 发给自己」，把每一步的原话
 * 打出来。它不模拟任何东西 —— 要的是真实登录态和真实接口的答案（以及它们坏掉时的样子）。
 *
 *   node probes/teams.mjs                       # 只读：状态 / 会话 / 自己的聊天
 *   node probes/teams.mjs --send "hello"        # 额外往「与你自己的聊天」发一条
 *   node probes/teams.mjs --q 张三              # 额外搜一个人
 *   PI_WEB_URL=http://127.0.0.1:17864 PI_PASS=test node probes/teams.mjs
 *
 * 默认打 7864（正经实例）。第一次跑会在一个新 profile 里开窗口，**需要你在那个窗口里登录**——
 * 脚本会等 3 分钟，登录完自动继续；不登录就停在「需要登录」并把话说明白。
 */
import process from "node:process";

const BASE = (process.env.PI_WEB_URL ?? "http://127.0.0.1:7864").replace(/\/$/, "");
const PASS = process.env.PI_PASS ?? "test";
const argv = process.argv.slice(2);
const flag = (name, fallback = "") => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

let cookie = "";
async function call(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = new Error(`${path} → HTTP ${res.status}: ${body?.error ?? text}`);
    err.code = body?.code;
    throw err;
  }
  return body;
}

const line = (label, value) => console.log(`  ${label.padEnd(10)} ${value}`);
const step = (title) => console.log(`\n== ${title}`);

async function main() {
  console.log(`探针目标 ${BASE}`);
  await call("/api/login", { method: "POST", body: JSON.stringify({ passphrase: PASS }) });

  step("状态");
  let st = await call("/api/teams");
  line("state", st.state);
  line("browsers", st.browsers.join(" / ") || "（一个都没找到）");
  line("browser", st.browser);
  line("target", `${st.target.title} (${st.target.id})`);
  line("mcp.json", st.mcpInstalled ? "已写入" : "还没写入");
  if (st.error) line("error", st.error);

  if (st.state !== "ready") {
    step("开窗口");
    const out = await call("/api/teams/login", { method: "POST" });
    line("login", out.state);
    if (out.reason) line("reason", out.reason);
    const until = Date.now() + 180_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 3000));
      st = await call("/api/teams");
      process.stdout.write(`\r  等登录… state=${st.state}   `);
      if (st.state === "ready" || st.state === "error") break;
    }
    console.log("");
    line("state", st.state);
    if (st.error) line("error", st.error);
    if (st.state !== "ready") {
      console.log("\n停在「" + st.state + "」——把上面那句话读一遍；需要登录就在弹出的窗口里登录，再重跑本脚本。");
      process.exitCode = 1;
      return;
    }
  }

  step("会话（前 10 条）");
  const { chats } = await call("/api/teams/chats?limit=10");
  for (const c of chats) line(c.kind, `${c.title}  [${c.id}]${c.preview ? "  · " + c.preview.slice(0, 40) : ""}`);

  step("与你自己的聊天（最后 5 条）");
  const mine = await call("/api/teams/messages?chat=48%3Anotes&limit=5");
  line("chat", mine.chat?.title ?? "（空）");
  for (const m of mine.messages ?? []) line(m.name || m.from, `${m.time}  ${m.text.slice(0, 80)}`);

  const q = flag("--q");
  if (q) {
    step(`找人：${q}`);
    const { people } = await call(`/api/teams/find?q=${encodeURIComponent(q)}`);
    for (const p of people) line("·", `${p.name}  ${p.mri}${p.email ? "  · " + p.email : ""}`);
    if (!people.length) line("·", "一个都没找到");
  }

  const send = flag("--send");
  if (send) {
    step("发给自己");
    const out = await call("/api/teams/send", { method: "POST", body: JSON.stringify({ chat: "48:notes", text: send }) });
    line("sent", `to ${out.chat.title} at ${out.time} (id ${out.id})`);
  }

  console.log("\n完成。");
}

main().catch((err) => {
  console.error(`\n失败：${err.code ?? ""} ${err.message}`);
  process.exitCode = 1;
});
