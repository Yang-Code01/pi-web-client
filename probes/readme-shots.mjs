/**
 * Probe: regenerate the six README screenshots (docs/shots/*.png) from a *fixture*, so the images
 * can be refreshed without touching the real ~/.pi/agent and without spending a model call.
 *
 * Two phases, because the six pictures need two different kinds of truth:
 *
 *   1) Real bridge, temp dirs. A hand-written session jsonl (fake but realistic conversation, 3 turns,
 *      ok/error tool cards, one `write` + two `edit` calls so the 产物 sheet has rows) is served by a
 *      throwaway `bridge/dist/index.js` with PI_STATE / PI_AGENT_DIR / cwd all pointed inside
 *      `.scratch/readme-shots/`. Everything in these three shots is the real thing: real fs browsing,
 *      real preview, real PowerShell through node-pty. → desktop.png, files.png, terminal.png,
 *      mobile-chat.png
 *
 *   2) Local stub, no bridge. The approval card and the ask panel only exist while a live pi process
 *      is waiting on the user; parking one there would mean a real model call and a real session in
 *      ~/.pi/agent. So those two are driven off a stub WS server that sends the same `session`
 *      snapshot shape with `approvals` / `asks` filled in (web/src/app.ts:600-601 reads exactly those
 *      two fields). → mobile-approval.png, ask-drawer.png
 *
 * Run: npm run build:web && node probes/readme-shots.mjs
 *      (needs `bridge/dist/` too: npm run build:bridge)
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "docs/shots");
const ROOT = path.join(REPO, ".scratch/readme-shots");
const AGENT = path.join(ROOT, "agent");
const STATE = path.join(ROOT, "state");
const DIST = path.join(REPO, "web/dist");
const BRIDGE = path.join(REPO, "bridge/dist/index.js");
const PORT = 7886;
const BASE = `http://127.0.0.1:${PORT}`;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${what}`);
};

// --- find a *working* playwright wherever npx left it -------------------------------------------------
// npx keeps several installs around and some of them are half-broken (missing playwright-core), so a
// candidate only counts once it has actually launched a browser.
async function launchBrowser() {
  const cache = path.join(process.env.LOCALAPPDATA ?? "", "npm-cache/_npx");
  const candidates = [process.env.PW_PATH, path.join(REPO, "node_modules/playwright/index.mjs")].filter(Boolean);
  try {
    for (const dir of fs.readdirSync(cache)) candidates.push(path.join(cache, dir, "node_modules/playwright/index.mjs"));
  } catch {
    /* no npx cache: fall through to the error below */
  }
  const seen = [];
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    try {
      const { chromium } = await import(pathToFileURL(file).href);
      const browser = await chromium.launch();
      log("playwright:", file);
      return browser;
    } catch (ex) {
      seen.push(`${file}: ${ex.message.split("\n")[0]}`);
    }
  }
  throw new Error(`找不到可用的 playwright（设 PW_PATH=<.../playwright/index.mjs>）\n${seen.join("\n")}`);
}

/** pi's session dir naming: every `:` / `\` / `/` becomes `-`, wrapped in `--…--`. */
const enc = (p) => `--${p.replace(/[\\/:]/g, "-")}--`;

/** Entries are written in the exact shape bridge/src/items.ts reads back. */
function sessionFile({ id, cwd, at, turns }) {
  fs.mkdirSync(path.join(AGENT, "sessions", enc(cwd)), { recursive: true });
  const lines = [];
  let parent = null;
  const t0 = at;
  let n = 0;
  const stamp = () => {
    n += 7;
    return new Date(t0 + n * 1000).toISOString();
  };
  const push = (entry) => {
    lines.push(JSON.stringify(entry));
    parent = entry.id;
  };
  push({ type: "session", version: 3, id, timestamp: new Date(t0).toISOString(), cwd });
  push({ type: "model_change", id: `mc-${id}`, parentId: null, timestamp: stamp(), provider: "anthropic", modelId: "claude-sonnet-4-5" });
  push({ type: "thinking_level_change", id: `tl-${id}`, parentId: `mc-${id}`, timestamp: stamp(), thinkingLevel: "medium" });
  let seq = 0;
  const idOf = (tag) => `${id.slice(-4)}-${String(++seq).padStart(2, "0")}-${tag}`;
  const user = (text) =>
    push({ type: "message", id: idOf("u"), parentId: parent, timestamp: stamp(), message: { role: "user", content: [{ type: "text", text }], timestamp: t0 + n * 1000 } });
  const say = (text, thinking = "") => {
    const content = [];
    if (thinking) content.push({ type: "thinking", thinking });
    content.push({ type: "text", text });
    push({ type: "message", id: idOf("a"), parentId: parent, timestamp: stamp(), message: { role: "assistant", content, model: "claude-sonnet-4-5", stopReason: "stop", timestamp: t0 + n * 1000 } });
  };
  const call = (name, args, thinking = "") => {
    const callId = `call_${id.slice(-4)}_${++seq}`;
    const content = [];
    if (thinking) content.push({ type: "thinking", thinking });
    content.push({ type: "toolCall", id: callId, name, arguments: args });
    push({ type: "message", id: idOf("t"), parentId: parent, timestamp: stamp(), message: { role: "assistant", content, model: "claude-sonnet-4-5", stopReason: "toolUse", timestamp: t0 + n * 1000 } });
    return callId;
  };
  const result = (callId, text, isError = false) =>
    push({
      type: "message",
      id: idOf("r"),
      parentId: parent,
      timestamp: stamp(),
      message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text }], isError, timestamp: t0 + n * 1000 },
    });

  for (const turn of turns) turn({ user, say, call, result });

  const file = path.join(AGENT, "sessions", enc(cwd), `${new Date(t0).toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

function seedSessions() {
  // A rerun must not stack a second copy of every fixture session next to the first one.
  fs.rmSync(AGENT, { recursive: true, force: true });
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.mkdirSync(path.join(AGENT, "sessions"), { recursive: true });
  const now = Date.now();
  const EXT = "bridge/ext/approval-gate.ts";

  // The demo session talks about this repo's own code, and its cwd *is* the repo — so the sidebar,
  // the terminal title and the viewer path all read like a real project instead of a fixture path.
  sessionFile({
    id: "01a2f1c4-0000-7000-8000-00000000d0d1",
    cwd: REPO,
    at: now - 26 * 60_000,
    turns: [
      ({ user, call, result, say }) => {
        user("审批超时现在是 5 分钟，改成 8 分钟；先看看这个值写在哪几个地方");
        const c1 = call("bash", { command: "rg -n \"timeout: 5 \* 60|审批超时\" bridge/ext bridge/src docs/DECISIONS.md" }, "先确认有几个落点，别只改一处留下不一致的注释。");
        result(c1, `${EXT}:134:    const ok = await ctx.ui.confirm(…, { timeout: 5 * 60 * 1000 });\ndocs/DECISIONS.md:31:- 审批超时 \`5 分钟\`；长任务推送阈值 \`> 5 分钟\`\n`);
        const c2 = call("read", { path: EXT });
        result(c2, "…\n  // Timeout is the user's friend: an unanswered prompt must not hang the tool forever.\n  const ok = await ctx.ui.confirm(`需要确认：${risk.why}`, `${toolName} → ${detail}`, { timeout: 5 * 60 * 1000 });\n…");
        say("落点只有两个：`bridge/ext/approval-gate.ts:134` 的 `timeout: 5 * 60 * 1000`，和 `docs/DECISIONS.md` 里 D14 的默认值表。前端不写死这个数——审批卡上的倒计时读的是 bridge 发过去的 `deadline`，所以只改这两处就够，别的一行动。");
      },
      ({ user, call, result, say }) => {
        user("改吧，D14 那张表也一起更新");
        const e1 = call("edit", { path: EXT, oldText: "{ timeout: 5 * 60 * 1000 }", newText: "{ timeout: 8 * 60 * 1000 }" });
        result(e1, `已修改 ${EXT}`);
        const e2 = call("edit", { path: "docs/DECISIONS.md", oldText: "- 审批超时 `5 分钟`", newText: "- 审批超时 `8 分钟`" });
        result(e2, "已修改 docs/DECISIONS.md");
        const t1 = call("bash", { command: "npm run typecheck" });
        result(t1, "bridge/src/index.ts(214,9): error TS2322: Type 'number' is not assignable to type 'string | undefined'.\n\n1 error", true);
        const e3 = call("edit", { path: EXT, oldText: "const APPROVAL_TIMEOUT_MIN = 8;", newText: "const APPROVAL_TIMEOUT_MIN = \"8\";" });
        result(e3, `已修改 ${EXT}`);
        const t2 = call("bash", { command: "npm run typecheck && npm test" });
        result(t2, "bridge tsc --noEmit: ok\nweb tsc --noEmit: ok\n\ne2e: 12 passed\n");
        say("两处都改了（`approval-gate.ts` 的 8 分钟 + D14 的表）。中间那次 `npm run typecheck` 挂了一下：我把超时改成常量时顺手写成了 `8`（数字），`ui.confirm` 的 `timeout` 要的是 `number | undefined` 但那个位置期望字符串——改成带引号的写法就过了。`npm test` 12 passed。");
      },
      ({ user, say }) => {
        user("一句话总结，我贴到 PR 描述里");
        say("把审批超时从 5 分钟放宽到 8 分钟（`bridge/ext/approval-gate.ts`），并同步 D14 的默认值表；前端不受影响，倒计时一直读 bridge 下发的 `deadline`。");
      },
    ],
  });

  sessionFile({
    id: "01a2f1c4-0000-7000-8000-00000000d0d2",
    cwd: path.join(REPO, "web"),
    at: now - 3 * 3600_000,
    turns: [
      ({ user, call, result, say }) => {
        user("手机上打字时输入框被键盘顶飞了，帮我看下 100vh 那套");
        const c = call("bash", { command: "rg -n \"100vh|dvh|visualViewport\" web/src/styles.css web/src/app.ts" });
        result(c, "web/src/styles.css:22:  height: 100vh;\nweb/src/app.ts:1141:    visualViewport?.addEventListener(\"resize\", …);\n");
        say("`100vh` 在移动端是「键盘没弹起时」的高度，键盘一弹浏览器不重排它，所以整列被顶上去。`visualViewport` 的监听已经有了，问题在根节点：把 `height: 100vh` 换成 `100dvh`，再让 `visualViewport.resize` 时写 `--vvh` 兜旧 Safari。");
      },
    ],
  });

  sessionFile({
    id: "01a2f1c4-0000-7000-8000-00000000d0d3",
    cwd: path.join(REPO, "docs"),
    at: now - 9 * 3600_000,
    turns: [
      ({ user, say }) => {
        user("GLOSSARY 还是空表，把已经定下来的词补三五个进去");
        say("先只补有争议的词，别铺全：`会话`（进程，不是文件）、`接管`（写者换成网页）、`审批`（危险模式被门禁拦下的那一次）、`产物`（本会话写/改过的文件列表）。这四个都在代码里各有一套叫法，写清楚能省掉后面每次的重新解释。");
      },
    ],
  });

  sessionFile({
    id: "01a2f1c4-0000-7000-8000-00000000d0d4",
    cwd: path.join(REPO, "bridge"),
    at: now - 26 * 3600_000,
    turns: [
      ({ user, call, result, say }) => {
        user("列表里有些会话永远显示「运行中」，是不是死锁没清掉");
        const c = call("bash", { command: "ls \"$LOCALAPPDATA/pi-web-client/locks\" | wc -l" });
        result(c, "13\n");
        say("13 个锁文件全都没有对应进程——死进程留下的锁没人清，列表就按「有锁 = 在跑」渲染了。修法是 `pidAlive()` 用 `process.kill(pid, 0)` 判活（`EPERM` 算活着），读到就删，再加一个 60 秒扫一遍的 `sweepLocks()`。");
      },
    ],
  });
}

// ---------------------------------------------------------------- real bridge phase
async function shootRealBridge() {
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const browser = await launchBrowser();
  const open = async (width, height) => {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, locale: "zh-CN", colorScheme: "dark" });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => log("page error:", e.message));
    page.on("console", (m) => m.type() === "error" && log("console:", m.text().slice(0, 160)));
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    if (await page.locator('input[type="password"]').count()) {
      await page.fill('input[type="password"]', pass);
      await page.click('button:has-text("进入")');
    }
    await page.waitForSelector(".session-list", { timeout: 20000 });
    return { ctx, page };
  };
  const openDemo = async (page) => {
    await until(async () => (await page.locator(".session-card").count()) >= 1, 15000, "session cards");
    await page.locator(".session-card").first().click();
    await until(async () => (await page.locator(".chat-scroll .msg.user").count()) >= 1, 15000, "first user message");
    await sleep(900); // git chip + turn rail settle
  };
  const shots = [];

  // 1) 桌面：三栏 + 轮次刻度带。滚到第二轮的失败卡那一段，工具卡与失败标红都在画面里。
  {
    const { page, ctx } = await open(1440, 900);
    await openDemo(page);
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".chat-scroll .msg.user")];
      rows[1]?.scrollIntoView({ block: "start" });
    });
    await sleep(700);
    shots.push(path.join(OUT, "desktop.png"));
    await page.screenshot({ path: path.join(OUT, "desktop.png") });
    await ctx.close();
  }

  // 2) 文件管理器：顶栏 📁 打开浏览态，落在这个仓库，进 bridge/ext 打开 conversation 里那个文件。
  //    （不预览 README.md：它自己贴了一张截图，会出现「图里的图」套娃。）
  {
    const { page, ctx } = await open(1440, 900);
    await openDemo(page);
    await page.click('[data-act="files"]');
    const into = async (name) => {
      await until(async () => (await page.locator(".dir-row").count()) > 0, 10000, `rows in ${name}`);
      await page.locator(".dir-row", { hasText: new RegExp(`\\b${name}$`) }).first().click();
      await sleep(700);
    };
    await into("bridge");
    await into("ext");
    await page.locator(".file-row", { hasText: "approval-gate.ts" }).first().click();
    await until(async () => (await page.locator(".viewer .viewer-name").textContent()) === "approval-gate.ts", 10000, "approval-gate.ts preview");
    await sleep(900);
    // Q-031: a .ts preview must actually be coloured (main's highlight.js, not my old lexer), not just line-numbered.
    const toks = await page.evaluate(() => {
      const count = (sel) => document.querySelectorAll(sel).length;
      const first = document.querySelector(".viewer-src code .hljs-keyword")?.textContent ?? "";
      return { kw: count(".viewer-src .hljs-keyword"), comment: count(".viewer-src .hljs-comment"), str: count(".viewer-src .hljs-string"), first };
    });
    log("highlight tokens in approval-gate.ts:", JSON.stringify(toks));
    if (!toks.kw || !toks.comment) throw new Error("预览没有高亮：.ts 文件应当有 keyword / comment token");
    shots.push(path.join(OUT, "files.png"));
    await page.screenshot({ path: path.join(OUT, "files.png") });
    await ctx.close();
  }

  // 3) 真终端 + 多开（D68·D92）：顶栏「>_ 终端」起一个 PowerShell，再点「＋」开第二个，两个标签各跑一条命令。
  {
    const { page, ctx } = await open(1440, 900);
    await openDemo(page);
    await page.click('[data-act="terminal"]');
    await until(async () => (await page.locator(".term-dock").count()) > 0, 15000, "terminal dock");
    const typeIn = async (cmd) => {
      await page.locator(".term-body:not([hidden]) .xterm-helper-textarea").click().catch(() => {});
      await page.keyboard.type(cmd, { delay: 12 });
      await page.keyboard.press("Enter");
    };
    await typeIn("git log --oneline -3");
    await sleep(1800);
    await page.locator(".term-new").click();
    await until(async () => (await page.locator(".term-tab").count()) === 2, 20000, "a second terminal tab");
    await until(async () => (await page.locator(".term-tab.on .term-tab-label").textContent())?.includes("#2") === true, 20000, "the new tab is active");
    await typeIn("ls bridge/ext");
    await sleep(2500); // let the shell actually print: a shot of an empty pty is a lie
    shots.push(path.join(OUT, "terminal.png"));
    await page.screenshot({ path: path.join(OUT, "terminal.png") });
    await ctx.close();
  }

  // 3b) markdown 内联渲染的两处回归（D65）：嵌套图片链接 + 链接标签里的行内代码。
  //     只断言 DOM，不截图 —— 借这个已经起好的桥，省一个探针。
  {
    const { page } = await open(1440, 900);
    await openDemo(page);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("pi-preview", { detail: { path: "README.md" } })));
    await until(async () => (await page.locator(".md-doc").count()) > 0, 15000, "markdown preview");
    await sleep(600);
    const md = await page.evaluate(() => {
      const doc = document.querySelector(".md-doc");
      const text = doc?.textContent ?? "";
      return {
        rawImageSyntax: (text.match(/!\[/g) ?? []).length,
        rawBracketTail: (text.match(/\]\(LICENSE\)/g) ?? []).length,
        badges: doc.querySelectorAll("a img, span img").length,
        codeInLink: doc.querySelectorAll("a.file-link code").length,
        fenceTokens: doc.querySelectorAll("pre code [class^=hljs-]").length,
      };
    });
    log("markdown inline render:", JSON.stringify(md));
    if (md.rawImageSyntax || md.rawBracketTail) throw new Error("markdown 里留下了原始 ![...] / ](...) 文本（D67 回归）");
    if (!md.codeInLink) throw new Error("链接标签里的行内代码又变成字面反引号了（D67 回归）");
  }

  // 3c) 工具卡上的命令行也吃同一套 hljs 颜色（本 PR 在 main 之外多做的那一处接入）。
  {
    const { page } = await open(1440, 900);
    await openDemo(page);
    await page.evaluate(() => {
      for (const d of document.querySelectorAll("details.ops")) d.open = true;
    });
    await sleep(600);
    const card = await page.evaluate(() => ({
      colored: document.querySelectorAll(".tool .cmd.hl").length,
      spans: document.querySelectorAll(".tool .cmd.hl span").length,
      firstText: document.querySelector(".tool .cmd.hl")?.textContent?.slice(0, 40) ?? "",
    }));
    log("tool card highlight:", JSON.stringify(card));
    if (!card.colored || !card.spans) throw new Error("工具卡命令行没有上色（highlightAs 没生效）");
  }

  // 4) 手机：同一段对话，底部三标签 + 折叠的工具栏。
  {
    const { page, ctx } = await open(390, 844);
    await openDemo(page);
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".chat-scroll .msg.user")];
      rows[1]?.scrollIntoView({ block: "start" });
    });
    await sleep(700);
    // 顺手当一次回归检查：390px 下任何元素比视口宽，README 图就会被裁掉一截。
    const over = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const bad = [];
      for (const node of document.querySelectorAll("body *")) {
        const r = node.getBoundingClientRect();
        if (r.width < 1) continue;
        if (r.right <= w + 1 && node.scrollWidth <= w + 1) continue;
        const cs = getComputedStyle(node);
        bad.push({
          tag: node.tagName.toLowerCase(),
          cls: String(node.className ?? "").slice(0, 40),
          x: Math.round(r.left),
          w: Math.round(r.width),
          sw: node.scrollWidth,
          ws: cs.whiteSpace,
          shrink: cs.flexShrink,
          leaf: ![...node.children].some((c) => c.getBoundingClientRect().right > w + 1),
        });
      }
      return { viewport: w, doc: document.documentElement.scrollWidth, n: bad.length, worst: bad.filter((b) => b.leaf).slice(0, 6), all: bad.map((b) => `${b.tag}.${b.cls}[x${b.x} w${b.w} sw${b.sw}${b.leaf ? " LEAF" : ""}]`) };
    });
    const dims = `mobile: viewport ${over.viewport}, documentElement.scrollWidth ${over.doc}`;
    log(over.doc > over.viewport + 1 ? `${dims}  ← 横向溢出！` : `${dims} (no horizontal overflow)`);
    if (over.worst.length) log("  clipped inside panes:", JSON.stringify(over.worst));
    shots.push(path.join(OUT, "mobile-chat.png"));
    await page.screenshot({ path: path.join(OUT, "mobile-chat.png") });
    await ctx.close();
  }

  await browser.close();
  return shots;
}

// ---------------------------------------------------------------- stub phase (drawers)
function stubSession(kind) {
  const now = Date.now();
  const at = (secAgo) => new Date(now - secAgo * 1000).toISOString();
  // Same story as the fixture conversation: commit the 8-minute change, then (approval) push it —
  // or (ask) check whether the long-task push threshold should move with it.
  const items = [
    { id: "s1", kind: "user", text: "顺手 commit 一下，message 写清为什么是 8 分钟", images: [], ts: at(210) },
    { id: "s2", kind: "assistant", text: "", thinking: "先看 diff，确认只有那两处改动再提交。", model: "claude-sonnet-4-5", ts: at(206) },
    {
      id: "s3",
      kind: "tool",
      toolCallId: "call_demo_1",
      name: "bash",
      args: { command: "git diff --stat" },
      result: " bridge/ext/approval-gate.ts | 2 +-\n docs/DECISIONS.md          | 2 +-\n 2 files changed, 2 insertions(+), 2 deletions(-)",
      status: "ok",
      ts: at(202),
    },
    {
      id: "s4",
      kind: "tool",
      toolCallId: "call_demo_2",
      name: "bash",
      args: { command: "git commit -am \"fix: 审批超时 5 → 8 分钟（D14 同步）\"" },
      result: "[main 3f19ac2] fix: 审批超时 5 → 8 分钟（D14 同步）\n 2 files changed, 2 insertions(+), 2 deletions(-)",
      status: "ok",
      ts: at(190),
    },
    {
      id: "s5",
      kind: "assistant",
      text: "提交好了：`3f19ac2`，两个文件、两行。前端没动，因为审批卡上的倒计时读的是 bridge 下发的 `deadline`，放宽只是让 bridge 多等三分钟。",
      thinking: "",
      model: "claude-sonnet-4-5",
      ts: at(186),
    },
    { id: "s6", kind: "user", text: kind === "approval" ? "推开吧，推到 main" : "长任务推送的阈值要不要跟着改？", images: [], ts: at(60) },
    { id: "s7", kind: "assistant", text: "", thinking: kind === "approval" ? "推到 main 是不可逆的外发动作，门禁会拦。" : "这个得问，D4 的阈值和审批超时是两条独立的线。", model: "claude-sonnet-4-5", ts: at(56) },
  ];
  items.push(
    kind === "approval"
      ? {
          id: "s8",
          kind: "tool",
          toolCallId: "call_demo_3",
          name: "bash",
          args: { command: "git push origin main" },
          status: "running",
          ts: at(4),
        }
      : {
          id: "s8",
          kind: "tool",
          toolCallId: "call_demo_3",
          name: "ask_user_question",
          args: { questions: [{ header: "阈值", question: "长任务推送阈值调到几分钟？" }] },
          status: "running",
          ts: at(4),
        },
  );
  const state = {
    id: "stub-demo",
    name: "审批超时 5 → 8 分钟",
    cwd: REPO,
    file: null,
    owned: true,
    origin: "web",
    running: true,
    done: false,
    model: "claude-sonnet-4-5",
    modelName: "claude-sonnet-4-5",
    thinkingLevel: "medium",
    updatedAt: now,
    approvals: kind === "approval" ? 1 : 0,
    asks: kind === "ask" ? 1 : 0,
    preview: "",
    locked: false,
    items,
  };
  const approvals =
    kind === "approval"
      ? [
          {
            id: "ap-demo",
            sessionId: "stub-demo",
            title: "危险操作：推送到远端",
            message: "bash → git push origin main",
            createdAt: now - 4000,
            deadline: now + 476_000,
          },
        ]
      : [];
  const asks =
    kind === "ask"
      ? [
          {
            id: "ask-demo",
            sessionId: "stub-demo",
            sessionName: "审批超时 5 → 8 分钟",
            createdAt: now - 4000,
            questions: [
              {
                id: "q1",
                header: "阈值",
                prompt: "长任务推送阈值（现在是 5 分钟）要不要一起放宽到 8 分钟？",
                options: [
                  { value: "5", label: "保持 5 分钟（推荐）", description: "它是「一条命令跑多久才值得推手机」，和等审批的耐心不是一回事" },
                  { value: "8", label: "也改成 8 分钟", description: "两条线对齐，少一个要记的数字" },
                ],
                allowOther: true,
              },
              {
                id: "q2",
                header: "D14",
                prompt: "那 D14 那张默认值表还拆成两条写吗？",
                options: [
                  { value: "split", label: "保持两条", description: "审批超时 / 长任务阈值各自一行，语义不混" },
                  { value: "merge", label: "合成一条", description: "「等你的时间统一 8 分钟」，读起来更短" },
                ],
              },
            ],
          },
        ]
      : [];
  return { state, approvals, asks };
}

async function shootStub() {
  const sets = { approval: stubSession("approval"), ask: stubSession("ask") };
  // web/src/ws.ts connects to a bare `/ws`, so the page's `?stub=` never reaches the upgrade request.
  // The two passes are sequential, so a mutable pointer is enough.
  let mode = sets.approval;
  const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
  const ME = {
    version: "0.1.0",
    pi: "1.4.0",
    public: false,
    tunnel: TUNNEL,
    pushKey: null,
    pushCount: 0,
    sessionsRoot: path.join(AGENT, "sessions"),
  };
  const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };
  const strip = ({ items: _drop, ...rest }) => rest;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", BASE);
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/healthz") return json(200, { ok: true });
    if (url.pathname === "/api/login") {
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "pwc=probe; Path=/; HttpOnly; SameSite=Lax" });
      return res.end('{"ok":true}');
    }
    if (url.pathname === "/api/me") return json(200, ME);
    if (url.pathname === "/api/git") return json(200, { repo: "alpha-cache", branch: "main", detached: false, empty: false, dirty: 1 });
    const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
    const file = path.join(DIST, rel);
    if (!path.resolve(file).startsWith(path.resolve(DIST)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain" }).end("nope");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });

  const { WebSocketServer } = await import(pathToFileURL(path.join(REPO, "bridge/node_modules/ws/wrapper.mjs")).href);
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!(req.url ?? "").startsWith("/ws")) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type === "subscribe") {
          ws.send(
            JSON.stringify({
              type: "session",
              sessionId: mode.state.id,
              state: mode.state,
              items: mode.state.items,
              approvals: mode.approvals,
              asks: mode.asks,
              budget: null,
            }),
          );
        }
      });
      ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [strip(mode.state)], manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL }));
    });
  });

  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const browser = await launchBrowser();
  const shots = [];
  const open = async (stub, width, height) => {
    mode = sets[stub];
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, locale: "zh-CN", colorScheme: "dark" });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => log("page error:", e.message));
    await page.goto(`${BASE}/?stub=${stub}`, { waitUntil: "networkidle" });
    if (await page.locator('input[type="password"]').count()) {
      await page.fill('input[type="password"]', "probe");
      await page.click('button:has-text("进入")');
    }
    await page.waitForSelector(".session-card", { timeout: 15000 });
    await page.locator(".session-card").first().click();
    await sleep(900);
    return { page, ctx };
  };

  // 5) 手机：危险命令的审批卡（单击批准 / 单击拒绝，无弹窗），键盘收起后贴在输入框下方。
  {
    const { page, ctx } = await open("approval", 390, 844);
    await until(async () => (await page.locator(".approval").count()) > 0, 10000, "approval card");
    await sleep(500);
    shots.push(path.join(OUT, "mobile-approval.png"));
    await page.screenshot({ path: path.join(OUT, "mobile-approval.png") });
    await ctx.close();
  }

  // 6) 手机：提问面板（多题 tab + 选项 + 自己写）——和上面两张手机图同一尺寸，三者并排才对齐。
  {
    const { page, ctx } = await open("ask", 390, 844);
    await until(async () => (await page.locator(".ask-slot").count()) > 0, 10000, "ask panel");
    await sleep(700);
    shots.push(path.join(OUT, "ask-drawer.png"));
    await page.screenshot({ path: path.join(OUT, "ask-drawer.png") });
    await ctx.close();
  }

  await browser.close();
  await new Promise((r) => server.close(r));
  return shots;
}

// ---------------------------------------------------------------- run
async function main() {
  for (const need of [path.join(DIST, "index.html"), BRIDGE]) {
    if (!fs.existsSync(need)) throw new Error(`缺 ${need}：先跑 npm run build（或 npm start 一次）`);
  }
  fs.mkdirSync(OUT, { recursive: true });

  log("seeding a fixture session tree into", AGENT);
  seedSessions();

  log("starting a throwaway bridge on", BASE);
  const child = spawn(process.execPath, [BRIDGE], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_AGENT_DIR: AGENT, PI_WEB_ROOT: DIST, PI_WEB_NO_EXT: "1" },
  });
  child.stderr.on("data", (b) => log("bridge:", String(b).trim().slice(0, 200)));
  const stop = () => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };
  process.on("exit", stop);
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "bridge passphrase");
  await until(async () => {
    try {
      return (await fetch(`${BASE}/healthz`)).ok;
    } catch {
      return false;
    }
  }, 20000, "bridge health");
  log("bridge up");

  const real = await shootRealBridge();
  log("real-bridge shots:", real.map((p) => path.basename(p)).join(", "));
  stop();
  await sleep(1200);

  const stub = await shootStub();
  log("stub shots:", stub.map((p) => path.basename(p)).join(", "));

  for (const file of [...real, ...stub]) {
    const stat = fs.statSync(file);
    log(`✓ ${path.relative(REPO, file)}  ${(stat.size / 1024).toFixed(0)} KB`);
  }
}

await main();
