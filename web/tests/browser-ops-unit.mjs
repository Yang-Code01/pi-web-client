/**
 * 浏览器面板第一步（#503）：纯模型、无 DOM。
 *
 * 只测外部行为：给定会话 items，得到哪些卡片、什么状态、哪些子步骤。不测内部函数拆分。
 * Run: node --experimental-strip-types web/tests/browser-ops-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { browserOpsView, foldedSteps } from "../src/browser-ops.ts";

const T0 = Date.parse("2026-11-18T10:00:00Z");
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const NOW = T0 + 600_000;

const user = (id, sec, text = "跑一下") => ({ id, kind: "user", text, images: [], ts: at(sec) });
const assistant = (id, sec, text) => ({ id, kind: "assistant", text, thinking: "", ts: at(sec) });
const tool = (id, sec, name, args, extra = {}) => ({
  id,
  kind: "tool",
  toolCallId: `call-${id}`,
  name,
  args,
  status: "ok",
  ts: at(sec),
  ...extra,
});
/** browser-use 的真实形状：外部工具名 + args.tool + args.args。 */
const bu = (id, sec, code, extra = {}) =>
  tool(id, sec, "mcp__browser_use", { tool: "browser_exec", args: { code } }, extra);

const base = { now: NOW };

test("会话里没有浏览器调用 → 空视图", () => {
  const view = browserOpsView({ ...base, items: [user("u1", 0), tool("t1", 1, "bash", { command: "ls" })] });
  assert.equal(view.cards.length, 0);
  assert.equal(view.total, 0);
  assert.equal(view.empty, true);
});

test("一次 browser_exec 成为一张卡片：工具名、起止、整次耗时、状态", () => {
  const view = browserOpsView({
    ...base,
    items: [user("u1", 0), bu("t1", 10, "print('hi')", { durationMs: 48_000 })],
  });
  assert.equal(view.cards.length, 1);
  const [card] = view.cards;
  assert.equal(card.tool, "mcp__browser_use");
  assert.equal(card.toolCallId, "call-t1");
  assert.equal(card.durationMs, 48_000);
  assert.equal(card.state, "done");
  assert.equal(card.output, "");
});

test("意图取自调用前模型最后一段话", () => {
  const view = browserOpsView({
    ...base,
    items: [
      user("u1", 0),
      assistant("a1", 5, "先确认对话框结构。"),
      assistant("a2", 6, "确认完再点按钮。"),
      bu("t1", 10, "print('hi')", { durationMs: 1_000 }),
    ],
  });
  assert.equal(view.cards[0].intent, "确认完再点按钮。");
});

test("没有前置 assistant 时意图是空串，不编", () => {
  const view = browserOpsView({ ...base, items: [user("u1", 0), bu("t1", 10, "print('hi')", { durationMs: 1 }) ] });
  assert.equal(view.cards[0].intent, "");
});

/** 一段代码 → 一张卡片，省掉每处重复的脚手架。 */
const stepsOf = (code) =>
  browserOpsView({ ...base, items: [user("u1", 0), bu("t1", 10, code, { durationMs: 1_000 })] }).cards[0].steps;

const shape = (step) => ({ kind: step.kind, target: step.target, name: step.name });

test("goto_url / wait_for_load / js 各自一步，网址进 target", () => {
  const steps = stepsOf(
    ["goto_url('http://172.28.1.60/record/my')", "wait_for_load(timeout=15)", "print(js('document.title'))"].join("\n"),
  );
  assert.deepEqual(steps.map(shape), [
    { kind: "nav", target: "http://172.28.1.60/record/my", name: undefined },
    { kind: "wait", target: undefined, name: undefined },
    { kind: "js", target: "document.title", name: undefined },
  ]);
});

test("多行脚本里的每一步都算，缩进与空行不影响", () => {
  const steps = stepsOf(
    [
      "info = page_info()",
      "    print('url =', info.get('url'))",
      "",
      "import time",
      "time.sleep(1.5)",
    ].join("\n"),
  );
  assert.deepEqual(steps.map((s) => s.kind), ["read", "print", "wait"]);
});

test("js 片段折成一行、截断 80 字", () => {
  const long = "document.querySelector('#account').value + '" + "\n".repeat(0) + "x'.repeat(200)";
  const steps = stepsOf(`js("""${long}""")`);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].kind, "js");
  assert.ok(steps[0].target.length <= 80, steps[0].target);
  assert.ok(!steps[0].target.includes("\n"));
});

test("坐标点击与 CDP 方法各记一步", () => {
  const steps = stepsOf("click_at_xy(412, 318)\ncdp('Page.navigate', {'url': 'http://x/'})");
  assert.deepEqual(steps.map(shape), [
    { kind: "click", target: "412, 318", name: undefined },
    { kind: "cdp", target: "Page.navigate", name: undefined },
  ]);
});

test("认不出的自家函数记成 call，带上函数名", () => {
  const steps = stepsOf("ev = drain_events()");
  assert.deepEqual(steps.map(shape), [{ kind: "call", target: undefined, name: "drain_events" }]);
});

test("拆不动的代码整段落成 raw，不抛", () => {
  const steps = stepsOf("(((( 这行不是 python");
  assert.deepEqual(steps.map((s) => s.kind), ["raw"]);
  assert.ok(steps[0].target.includes("这行不是 python"));
});

const runningCard = (args, extra) =>
  browserOpsView({ ...base, items: [user("u1", 0), tool("t1", 0, "mcp__browser_use", args, { status: "running", ...extra })] })
    .cards[0];

test("还在跑：耗时按 now - 开始算，60 秒黄、120 秒红", () => {
  const args = { tool: "browser_exec", args: { code: "print('hi')" } };
  const started = T0;
  const fast = browserOpsView({ ...base, now: started + 5_000, items: [tool("t1", 0, "mcp__browser_use", args, { status: "running" })] }).cards[0];
  assert.equal(fast.state, "running");
  assert.equal(fast.durationMs, 5_000);
  const slow = browserOpsView({ ...base, now: started + 65_000, items: [tool("t1", 0, "mcp__browser_use", args, { status: "running" })] }).cards[0];
  assert.equal(slow.state, "slow");
  const stuck = browserOpsView({ ...base, now: started + 130_000, items: [tool("t1", 0, "mcp__browser_use", args, { status: "running" })] }).cards[0];
  assert.equal(stuck.state, "stuck");
});

test("无声：有输出过、20 秒没更新，running 上加标记；从没输出过就不算", () => {
  const args = { tool: "browser_exec", args: { code: "print('hi')" } };
  const withOutput = browserOpsView({
    ...base,
    now: T0 + 40_000,
    outputAt: { "call-t1": T0 + 10_000 },
    items: [tool("t1", 0, "mcp__browser_use", args, { status: "running", partialResult: "账号已填好" })],
  }).cards[0];
  assert.equal(withOutput.silent, true);
  assert.equal(withOutput.state, "running");
  assert.equal(withOutput.silentFor, 30_000);
  const quiet = runningCard(args, { status: "running", partialResult: "账号已填好" });
  assert.equal(quiet.silent, false);
  assert.equal(quiet.silentFor, null);
});

test("跑着的时候输出取这轮的 partial，不是最终 result；阈值可从外面改", () => {
  const args = { tool: "browser_exec", args: { code: "wait_for_load()" } };
  const running = browserOpsView({
    ...base,
    now: T0 + 8_000,
    thresholds: { slowMs: 5_000 },
    items: [tool("t1", 0, "mcp__browser_use", args, { status: "running", partialResult: "waiting for load…" })],
  }).cards[0];
  assert.equal(running.output, "waiting for load…");
  assert.equal(running.state, "slow");
  const done = browserOpsView({ ...base, items: [tool("t1", 0, "mcp__browser_use", args, { status: "ok", result: "ok", durationMs: 2_000 })] }).cards[0];
  assert.equal(done.output, "ok");
});

test("打转：同一动作连续三次 → 标 looping，那一步带 repeat=3", () => {
  const code = ["goto_url('http://x/')", "goto_url('http://x/')", "goto_url('http://x/')", "print('hi')"].join("\n");
  const card = browserOpsView({ ...base, items: [user("u1", 0), bu("t1", 10, code, { durationMs: 1_000 })] }).cards[0];
  assert.equal(card.looping, true);
  assert.equal(card.steps[0].repeat, 3);
});

test("失败的工具调用 → failed，不冒充 done", () => {
  const card = browserOpsView({ ...base, items: [user("u1", 0), bu("t1", 10, "print('hi')", { status: "error", isError: true, durationMs: 900 })] }).cards[0];
  assert.equal(card.state, "failed");
});

test("汇总行：次数、总耗时、最慢一次、当前在跑的是哪张", () => {
  const view = browserOpsView({
    ...base,
    now: T0 + 30_000,
    items: [
      user("u1", 0),
      bu("t1", 1, "print(1)", { durationMs: 10_000 }),
      bu("t2", 2, "print(2)", { durationMs: 20_000 }),
      bu("t3", 20, "print(3)", { status: "running" }),
    ],
  });
  assert.equal(view.total, 3);
  assert.equal(view.totalMs, 40_000);
  assert.equal(view.slowestMs, 20_000);
  assert.deepEqual(view.current, { state: "running", ms: 10_000 });
});

test("子代理的调用并进同一时间线，卡片标上子代理名", () => {
  const view = browserOpsView({
    ...base,
    items: [user("u1", 0), tool("m1", 1, "bash", { command: "ls" })],
    childRuns: [{ name: "browser-lane", items: [bu("c1", 5, "goto_url('http://x/')", { durationMs: 3_000 })] }],
  });
  assert.equal(view.cards.length, 1);
  assert.equal(view.cards[0].subagent, "browser-lane");
});

test("有头无头：args 里写了 headless 才标，没写是 null", () => {
  const quiet = browserOpsView({ ...base, items: [bu("t1", 1, "print(1)", { durationMs: 1 })] }).cards[0];
  assert.equal(quiet.headed, null);
  const headless = browserOpsView({
    ...base,
    items: [tool("t1", 1, "mcp__browser_use", { headless: true, tool: "browser_exec", args: { code: "print(1)" } }, { durationMs: 1 })],
  }).cards[0];
  assert.equal(headless.headed, false);
  const headed = browserOpsView({
    ...base,
    items: [tool("t1", 1, "mcp__browser_use", { headless: false, tool: "browser_exec", args: { code: "print(1)" } }, { durationMs: 1 })],
  }).cards[0];
  assert.equal(headed.headed, true);
  const unknown = browserOpsView({ ...base, items: [tool("t1", 1, "mcp__playwright", { url: "http://x/" }, { durationMs: 1 })] }).cards[0];
  assert.equal(unknown.headed, null);
});

test("Playwright 那种扁平参数：一个调用一步", () => {
  const view = browserOpsView({
    ...base,
    items: [tool("t1", 1, "mcp__playwright", { tool: "browser_click", element: "登录按钮" }, { durationMs: 1 })],
  });
  assert.deepEqual(view.cards[0].steps.map(shape), [{ kind: "click", target: "登录按钮", name: undefined }]);
});

test("白名单可改：自定义工具名也算，默认列表之外的不算", () => {
  const items = [user("u1", 0), tool("t1", 1, "mcp__my_bot", { url: "http://x/" }, { durationMs: 1 })];
  assert.equal(browserOpsView({ ...base, items }).cards.length, 0);
  assert.equal(browserOpsView({ ...base, items, tools: ["my_bot"] }).cards.length, 1);
});

/* ---------- 脚本驱动的浏览器（bash + node xxx.mjs） ----------
 * 现实里最常见的一条路：agent 自己写一份 playwright 脚本，再用 bash 跑它。
 * 这类调用不叫 mcp__playwright，光看工具名永远数不到（#505 验收时漏的正是它）。
 */
const SCRIPT = [
  "import { chromium } from 'playwright';",
  "",
  "const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });",
  "const page = await browser.newPage();",
  "console.log('1) 打开百度 …');",
  "await page.goto('https://www.baidu.com');",
  "await page.waitForTimeout(1500);",
  "const input = page.locator('#kw').first();",
  "await input.fill('今天的天气');",
  "await page.locator('#su').first().click();",
  "await page.screenshot({ path: 'a.png' });",
  "const title = await page.title();",
].join("\n");

const wrote = (id, sec, path, content) => tool(id, sec, "write", { path, content }, { durationMs: 12 });

test("bash 跑这一轮写过的 playwright 脚本 → 一张卡，步骤从脚本源码读出来", () => {
  const view = browserOpsView({
    ...base,
    items: [
      user("u1", 0),
      assistant("a1", 3, "写个脚本走一遍百度。"),
      wrote("w1", 5, "E:/yqm/AI驱动测试/.scratch/baidu-weather.mjs", SCRIPT),
      tool("b1", 9, "bash", { command: "node .scratch/baidu-weather.mjs" }, { durationMs: 41_000 }),
    ],
  });
  assert.equal(view.cards.length, 1);
  const [card] = view.cards;
  assert.equal(card.script, "baidu-weather.mjs");
  assert.equal(card.tool, "bash");
  assert.equal(card.durationMs, 41_000);
  assert.equal(card.headed, true);
  assert.deepEqual(card.steps.map(shape), [
    { kind: "launch", target: "headed", name: undefined },
    { kind: "tab", target: undefined, name: undefined },
    { kind: "print", target: "1) 打开百度 …", name: undefined },
    { kind: "nav", target: "https://www.baidu.com", name: undefined },
    { kind: "wait", target: "1500ms", name: undefined },
    { kind: "input", target: "今天的天气", name: "#kw" },
    { kind: "click", target: "#su", name: undefined },
    { kind: "shot", target: undefined, name: undefined },
    { kind: "read", target: undefined, name: undefined },
  ]);
});

test("bash 跑的是别的脚本（没提浏览器驱动）→ 不算浏览器操作", () => {
  const view = browserOpsView({
    ...base,
    items: [
      user("u1", 0),
      wrote("w1", 5, "E:/x/build.mjs", "import fs from 'node:fs';\nfs.writeFileSync('a', 'b');\n"),
      tool("b1", 9, "bash", { command: "node build.mjs" }, { durationMs: 900 }),
    ],
  });
  assert.equal(view.cards.length, 0);
});

test("命令里内联一段 playwright 代码 → 步骤从命令本身读出来", () => {
  const view = browserOpsView({
    ...base,
    items: [
      user("u1", 0),
      tool("b1", 9, "bash", { command: `node -e "await page.goto('https://x/'); await page.title();"` }, { durationMs: 700 }),
    ],
  });
  assert.equal(view.cards.length, 1);
  assert.equal(view.cards[0].script, null);
  assert.deepEqual(view.cards[0].steps.map(shape), [
    { kind: "nav", target: "https://x/", name: undefined },
    { kind: "read", target: undefined, name: undefined },
  ]);
});

test("只在命令里提到 playwright（装包、看版本、grep）→ 不算浏览器操作", () => {
  const items = [
    user("u1", 0),
    tool("b1", 2, "bash", { command: "npx playwright --version" }, { durationMs: 400 }),
    tool("b2", 3, "bash", { command: "ls node_modules | grep -i playwright" }, { durationMs: 90 }),
    tool("b3", 4, "bash", { command: "npm i playwright@1.57.0" }, { durationMs: 40_000 }),
  ];
  assert.equal(browserOpsView({ ...base, items }).cards.length, 0);
});

/* ---------- 命令行直接跑测试 / 起浏览器 / 连调试端口 ---------- */
test("npx playwright test 这种命令也认：一张卡、一步「运行」", () => {
  const view = browserOpsView({
    ...base,
    items: [user("u1", 0), tool("b1", 5, "bash", { command: "npx playwright test --project=chromium" }, { durationMs: 61_000 })],
  });
  assert.equal(view.cards.length, 1);
  assert.equal(view.cards[0].state, "done");
  assert.equal(view.cards[0].durationMs, 61_000);
  assert.deepEqual(view.cards[0].steps.map(shape), [{ kind: "run", target: "playwright test", name: undefined }]);
});

test("直接起浏览器（--headless）与连 CDP 端点各成一张卡", () => {
  const launch = browserOpsView({
    ...base,
    items: [
      user("u1", 0),
      tool("b1", 5, "bash", { command: `"C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --remote-debugging-port=9222 about:blank` }, { durationMs: 2_000 }),
    ],
  });
  assert.equal(launch.cards.length, 1);
  assert.equal(launch.cards[0].headed, false);
  assert.deepEqual(launch.cards[0].steps.map(shape), [{ kind: "launch", target: "headless", name: undefined }]);

  const cdp = browserOpsView({
    ...base,
    items: [user("u1", 0), tool("b2", 6, "bash", { command: "curl -s http://127.0.0.1:9222/json/version" }, { durationMs: 30 })],
  });
  assert.equal(cdp.cards.length, 1);
  assert.deepEqual(cdp.cards[0].steps.map(shape), [{ kind: "cdp", target: "127.0.0.1:9222", name: undefined }]);
});

test("脚本是 cat heredoc 现场写的，也认得出来", () => {
  const command = [
    "cat > probe.mjs <<'EOF'",
    "import { chromium } from 'playwright';",
    "const browser = await chromium.launch();",
    "const page = await browser.newPage();",
    "await page.goto('https://x/');",
    "EOF",
    "node probe.mjs",
  ].join("\n");
  const view = browserOpsView({ ...base, items: [user("u1", 0), tool("b1", 5, "bash", { command }, { durationMs: 8_000 })] });
  assert.equal(view.cards.length, 1);
  assert.equal(view.cards[0].script, "probe.mjs");
  assert.equal(view.cards[0].headed, false);
  assert.deepEqual(view.cards[0].steps.map(shape), [
    { kind: "launch", target: "headless", name: undefined },
    { kind: "tab", target: undefined, name: undefined },
    { kind: "nav", target: "https://x/", name: undefined },
  ]);
});

test("后台跑（bg_run）同一条脚本也算", () => {
  const view = browserOpsView({
    ...base,
    items: [
      user("u1", 0),
      wrote("w1", 2, "E:/x/run.mjs", SCRIPT),
      tool("b1", 590, "bg_run", { command: "node E:/x/run.mjs" }, { status: "running", durationMs: undefined }),
    ],
  });
  assert.equal(view.cards.length, 1);
  assert.equal(view.cards[0].script, "run.mjs");
  assert.equal(view.cards[0].state, "running");
});

test("名字不常规的 MCP 也认：stagehand / cdp", () => {
  const stagehand = browserOpsView({
    ...base,
    items: [tool("t1", 1, "mcp__stagehand", { tool: "act", args: { action: "click" } }, { durationMs: 1 })],
  });
  assert.equal(stagehand.cards.length, 1);
  const cdp = browserOpsView({ ...base, items: [tool("t2", 2, "mcp__cdp_navigate", { url: "https://x/" }, { durationMs: 1 })] });
  assert.equal(cdp.cards.length, 1);
});

test("折叠行只留「对页面做了什么」：启动 / 切标签 / 等待 / 截图 / 读页面都不占位", () => {
  const view = browserOpsView({
    ...base,
    items: [
      user("u1", 0),
      wrote("w1", 5, ".scratch/baidu-weather.mjs", SCRIPT),
      tool("b1", 9, "bash", { command: "node .scratch/baidu-weather.mjs" }, { durationMs: 41_000 }),
    ],
  });
  // 脚本末尾是 `page.title()`：原来折叠行只取这一步，几张脚本卡就挤成同一句「读取页面信息」。
  assert.equal(view.cards[0].steps.at(-1).kind, "read");
  assert.deepEqual(foldedSteps(view.cards[0].steps).map(shape), [
    { kind: "nav", target: "https://www.baidu.com", name: undefined },
    { kind: "input", target: "今天的天气", name: "#kw" },
    { kind: "click", target: "#su", name: undefined },
  ]);
});

test("折叠行的兜底：只有读页面时照样说出来，且被等待隔开的两次读并成一条", () => {
  const steps = stepsOf(["print(page_info())", "time.sleep(1)", "print(page_info())"].join("\n"));
  assert.deepEqual(steps.map(shape), [
    { kind: "read", target: undefined, name: undefined },
    { kind: "wait", target: undefined, name: undefined },
    { kind: "read", target: undefined, name: undefined },
  ]);
  // 合并必须在筛掉等待之后做：不然中间那个 wait 会把两次读页面拆成两件事。
  assert.deepEqual(
    foldedSteps(steps).map((step) => [step.kind, step.repeat ?? 1]),
    [["read", 2]],
  );
});

/* ---------- 会话 18325 漏掉的那些路子（以及盘点出来的其它路子） ----------
 * 盘点（本机 532 份会话）里 AI 操作浏览器的方式：
 *   1. MCP 工具直连：mcp__browser_use / playwright / chrome-devtools（原来就认）
 *   2. pi-agent-browser 扩展：agent_browser（args 数组、可串联、--session、batch+stdin、script）、
 *      agent_browser_code（code 里 browser({args})）—— 用得最多（550+ 次），原来一次都不认
 *   3. 通用 mcp 网关：mcp({ tool: "browser_exec" }) / mcp__desktop_touch({ tool: "desktop-touch_browser_*" })
 *   4. bash 跑脚本：自己写的 playwright 脚本（原来就认）；脚本是「片段」、交给项目里的执行器跑（18325）
 *   5. bash 内联：node -e（原来就认）；python - <<EOF / python -c 里直接用 playwright
 *   6. bash 跑 agent-browser / browser-use 命令行
 *   7. 起浏览器 / 连 CDP / playwright test（原来就认）
 *   8. 认不出的自家执行器：面板齿轮里加「命令关键词」兜底
 */
const RUN_PY = [
  "from playwright.sync_api import sync_playwright  # noqa: E402",
  "pw = sync_playwright().start()",
  "br = pw.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')",
].join("\n");
const TC01 = [
  "# pyright: reportUndefinedVariable=false",
  "plan.goto_plan(p, PLAN_NO)",
  "p.get_by_role('button', name='基本情報編集').click()",
  "p.locator('input.from').fill('2026/10/31')",
  "p.keyboard.press('Enter')",
  "p.wait_for_timeout(1500)",
  "shot('TC-01_after')",
].join("\n");
const readFile = (id, sec, path, content) => tool(id, sec, "read", { path }, { durationMs: 3, result: content });

test("18325：片段脚本交给项目执行器跑（bash e2e.sh W TC-01.py TC-02.py）→ 一张卡，两份脚本都在", () => {
  const view = browserOpsView({
    ...base,
    items: [
      user("u1", 0),
      readFile("r1", 1, "C:/api/.agents/skills/cas3-plan-e2e/scripts/run.py", RUN_PY),
      wrote("w1", 2, "C:/api/.scratch/casph30inc-18325/e2e/cases/TC-01_basic_info_edit_ng.py", TC01),
      tool("b1", 9, "bash", {
        command:
          'cd /c/api/.agents/skills/cas3-plan-e2e && W=/c/api/.scratch/casph30inc-18325/e2e; E2E_VIDEO=1 timeout 600 bash scripts/e2e.sh $W TC-01_basic_info_edit_ng.py TC-02_media_edit_ok.py 2>&1 | grep -v "^$" | tail -32',
      }, { durationMs: 90_000 }),
    ],
  });
  assert.equal(view.cards.length, 1);
  const [card] = view.cards;
  assert.equal(card.script, "TC-01_basic_info_edit_ng.py, TC-02_media_edit_ok.py");
  const kinds = card.steps.map((step) => step.kind);
  assert.ok(kinds.includes("click"), JSON.stringify(card.steps));
  assert.ok(card.steps.some((step) => step.kind === "input" && step.target === "2026/10/31"), JSON.stringify(card.steps));
  assert.ok(card.steps.some((step) => step.kind === "wait" && step.target === "1500ms"), JSON.stringify(card.steps));
  // TC-02 是 python 现写的，看不到源码：至少说出跑了它。
  assert.ok(card.steps.some((step) => step.kind === "run" && step.target === "TC-02_media_edit_ok.py"), JSON.stringify(card.steps));
});

test("18325：heredoc 现写的探针片段交给执行器跑，只用了一处 playwright API 也认", () => {
  const command = [
    "W=/c/api/.scratch/casph30inc-18325/e2e; mkdir -p $W/probe; cat > $W/probe/p1.py <<'EOF'",
    "plan.ensure_login(p)",
    "p.set_viewport_size({'width': 1600, 'height': 950})",
    "shot('probe_plan143')",
    "dump()",
    "EOF",
    "cd /c/api/.agents/skills/cas3-plan-e2e && timeout 170 bash scripts/e2e.sh --probe $W $W/probe/p1.py 2>&1 | tail -15",
  ].join("\n");
  const view = browserOpsView({ ...base, items: [user("u1", 0), tool("b1", 5, "bash", { command }, { durationMs: 20_000 })] });
  assert.equal(view.cards.length, 1);
  assert.equal(view.cards[0].script, "p1.py");
});

test("18325：只是看 / 改 / 跑别的脚本 → 不算（grep、sed、python 改文件、生成 Excel）", () => {
  const items = [
    user("u1", 0),
    readFile("r1", 1, "C:/api/.agents/skills/cas3-plan-e2e/scripts/run.py", RUN_PY),
    wrote("w1", 2, "C:/api/.scratch/e2e/cases/TC-01_basic_info_edit_ng.py", TC01),
    wrote("w2", 2, "C:/api/.agents/skills/cas3-plan-e2e/scripts/video.py", "import subprocess\ndef encode(frames):\n  pass\n"),
    wrote("w3", 2, "C:/api/.scratch/e2e/make_book.py", "import json\nfrom openpyxl import Workbook\n"),
    tool("b1", 3, "bash", { command: "cd /c/api/.agents/skills/cas3-plan-e2e/scripts; wc -l run.py; grep -n \"connect_over_cdp\\|def \" run.py" }),
    tool("b2", 4, "bash", { command: "ls /e/tools/ffmpeg.exe; cd scripts; sed -n 1,22p run.py; grep -n \"\" video.py | sed -n 55,115p" }),
    tool("b3", 5, "bash", {
      command: "cd /c/api/.scratch/e2e/cases; python - <<'EOF'\ns=open('TC-01_basic_info_edit_ng.py',encoding='utf-8').read()\nopen('TC-02_media_edit_ok.py','w').write(s)\nEOF",
    }),
    tool("b4", 6, "bash", { command: "cd /c/api/.scratch/e2e; python -X utf8 make_book.py && ls" }),
    tool("b5", 7, "bash", {
      command: "cd scripts && python - <<'EOF'\ns=open('run.py',encoding='utf-8').read()\ns=s.replace('slow_mo=0', 'slow_mo=SLOW_MO')\nopen('run.py','w',encoding='utf-8').write(s)\nEOF",
    }),
  ];
  assert.deepEqual(browserOpsView({ ...base, items }).cards.map((card) => card.toolCallId), []);
});

test("python 内联（python - <<EOF）里直接驱动 playwright → 一张卡", () => {
  const command = [
    "cd /tmp && \"/c/Python/python.exe\" - <<'EOF'",
    "from playwright.sync_api import sync_playwright",
    "with sync_playwright() as pw:",
    "    b = pw.chromium.connect_over_cdp('http://127.0.0.1:9333')",
    "    p = b.contexts[0].pages[0]",
    "    p.goto('http://10.6.2.228:3001/')",
    "    print(p.title())",
    "EOF",
  ].join("\n");
  const view = browserOpsView({ ...base, items: [user("u1", 0), tool("b1", 5, "bash", { command }, { durationMs: 4_000 })] });
  assert.equal(view.cards.length, 1);
  assert.ok(view.cards[0].steps.some((step) => step.kind === "nav" && step.target === "http://10.6.2.228:3001/"), JSON.stringify(view.cards[0].steps));
});

/* ---------- pi-agent-browser 扩展 ---------- */
test("agent_browser：args 数组一条一步，可串联、带 --session、--headed", () => {
  const view = browserOpsView({
    ...base,
    items: [
      user("u1", 0),
      tool("t1", 1, "agent_browser", { args: ["close", "--all", "open", "http://10.6.2.228:8081/", "--headed"] }, { durationMs: 1 }),
      tool("t2", 2, "agent_browser", { args: ["--session", "pi-root-1", "fill", "@e2", "d11606", "fill", "@e3", "open", "click", "@e4"] }, { durationMs: 1 }),
      tool("t3", 3, "agent_browser", { args: ["wait", "3000", "get", "url"] }, { durationMs: 1 }),
    ],
  });
  assert.equal(view.cards.length, 3);
  const [wait, fill, open] = view.cards;
  assert.equal(open.headed, true);
  assert.deepEqual(open.steps.map(shape), [
    { kind: "tab", target: undefined, name: undefined },
    { kind: "nav", target: "http://10.6.2.228:8081/", name: undefined },
  ]);
  assert.deepEqual(fill.steps.map(shape), [
    { kind: "input", target: "d11606", name: "@e2" },
    { kind: "input", target: "open", name: "@e3" },
    { kind: "click", target: "@e4", name: undefined },
  ]);
  assert.deepEqual(wait.steps.map(shape), [
    { kind: "wait", target: "3000ms", name: undefined },
    { kind: "read", target: undefined, name: undefined },
  ]);
});

test("agent_browser batch（stdin 是命令数组）与 agent_browser_code（code 里 browser({args})）", () => {
  const batch = tool("t1", 1, "agent_browser", {
    args: ["batch", "--bail"],
    stdin: JSON.stringify([["set", "viewport", "1440", "900"], ["open", "file:///E:/a/index.html"], ["wait", "--load", "load"], ["screenshot", "E:/a/s.png"]]),
  }, { durationMs: 1 });
  const code = tool("t2", 2, "agent_browser_code", {
    code: 'const t = await browser({args:["open","https://x/"]});\nawait browser({ args: ["click", "@e3"] });\nemit(t);',
  }, { durationMs: 1 });
  const view = browserOpsView({ ...base, items: [user("u1", 0), batch, code] });
  assert.equal(view.cards.length, 2);
  assert.deepEqual(view.cards[1].steps.map((step) => step.kind), ["call", "nav", "wait", "shot"]);
  assert.equal(view.cards[1].steps[1].target, "file:///E:/a/index.html");
  assert.deepEqual(view.cards[0].steps.map(shape), [
    { kind: "nav", target: "https://x/", name: undefined },
    { kind: "click", target: "@e3", name: undefined },
  ]);
});

test("bash 跑 agent-browser / browser-use 命令行也算；装包、看版本、doctor 不算", () => {
  const ops = browserOpsView({
    ...base,
    items: [
      user("u1", 0),
      tool("b1", 1, "bash", { command: "agent-browser open http://x/ && npx agent-browser click @e1" }, { durationMs: 1 }),
      tool("b2", 2, "bash", { command: "browser-use open https://y/" }, { durationMs: 1 }),
    ],
  });
  assert.equal(ops.cards.length, 2);
  assert.deepEqual(ops.cards[1].steps.map(shape), [
    { kind: "nav", target: "http://x/", name: undefined },
    { kind: "click", target: "@e1", name: undefined },
  ]);
  const noise = browserOpsView({
    ...base,
    items: [
      user("u1", 0),
      tool("b1", 1, "bash", { command: "npm install -g agent-browser@0.38.1 2>&1 | tail -5; agent-browser --version" }),
      tool("b2", 2, "bash", { command: "where agent-browser; npx agent-browser --version" }),
      tool("b3", 3, "bash", { command: "pi-agent-browser-doctor 2>&1 | head -30" }),
    ],
  });
  assert.equal(noise.cards.length, 0);
});

/* ---------- 通用 mcp 网关 / 代理 ---------- */
test("mcp 网关调浏览器工具算；只是列工具 / 查说明 / 调别的服务器不算", () => {
  const view = browserOpsView({
    ...base,
    items: [
      user("u1", 0),
      tool("t1", 1, "mcp", { tool: "browser_exec", args: { code: "goto_url('https://x/')" } }, { durationMs: 1 }),
      tool("t2", 2, "mcp", { server: "browser-use" }, { durationMs: 1 }),
      tool("t3", 3, "mcp", { instructions: "browser-use" }, { durationMs: 1 }),
      tool("t4", 4, "mcp", { search: "browser" }, { durationMs: 1 }),
      tool("t5", 5, "mcp", { tool: "atlassian_getJiraIssue", args: { issueIdOrKey: "X-1" } }, { durationMs: 1 }),
    ],
  });
  assert.deepEqual(view.cards.map((card) => card.toolCallId), ["call-t1"]);
  assert.equal(view.cards[0].tool, "mcp · browser_exec");
  assert.deepEqual(view.cards[0].steps.map(shape), [{ kind: "nav", target: "https://x/", name: undefined }]);
});

test("desktop-touch 的 browser_* 工具算（代理与网关都认）；截屏 / 点屏幕坐标不算", () => {
  const view = browserOpsView({
    ...base,
    items: [
      user("u1", 0),
      tool("t1", 1, "mcp__desktop_touch", { tool: "desktop-touch_browser_navigate", args: { url: "https://x/" } }, { durationMs: 1 }),
      tool("t2", 2, "mcp", { tool: "desktop-touch_browser_click", args: { selector: "#go" } }, { durationMs: 1 }),
      tool("t3", 3, "mcp", { tool: "desktop-touch_screenshot", args: { hwnd: "1" } }, { durationMs: 1 }),
      tool("t4", 4, "mcp__desktop_touch", { tool: "desktop-touch_mouse_click", args: { x: 1, y: 2 } }, { durationMs: 1 }),
    ],
  });
  assert.deepEqual(view.cards.map((card) => card.toolCallId), ["call-t2", "call-t1"]);
  assert.deepEqual(view.cards[1].steps.map(shape), [{ kind: "nav", target: "https://x/", name: undefined }]);
  assert.deepEqual(view.cards[0].steps.map(shape), [{ kind: "click", target: "#go", name: undefined }]);
});

/* ---------- 兜底：命令关键词 ---------- */
test("命令关键词：命令里出现就算（认不出的自家执行器）；默认没有关键词", () => {
  const items = [user("u1", 0), tool("b1", 1, "bash", { command: "cd skill && timeout 120 bash scripts/e2e.sh --book /c/w out.xlsx" }, { durationMs: 1 })];
  assert.equal(browserOpsView({ ...base, items }).cards.length, 0);
  const view = browserOpsView({ ...base, items, commands: ["e2e.sh"] });
  assert.equal(view.cards.length, 1);
  assert.equal(view.cards[0].steps[0].kind, "run");
});
