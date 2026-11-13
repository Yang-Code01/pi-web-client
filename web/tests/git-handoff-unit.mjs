/**
 * D235 的交给 agent 提示词：只测 `buildHandoffPrompt()` 这一层纯函数。
 *
 * 重点守三条：不列全量分支（本机实测 105 条 ref / 2735 字符）、失败时只产出一份提示词、
 * 失败与「我的要求」并进同一次调用时选中分支 / ahead·behind / dirty 不丢。
 * 交互（预填到哪个输入框、只填不发）由 `bridge/tests/git-history-ui.mjs` 断言，这里不启浏览器。
 *
 * Run: node --experimental-strip-types web/tests/git-handoff-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applyLang, setLang } from "../src/i18n/index.ts";
import { buildHandoffPrompt } from "../src/git-ops.ts";

const base = {
  repo: "F:/pi-web-client",
  branch: "main",
  selected: "feat/context-panel",
  ahead: 2,
  behind: 1,
  dirty: 3,
};

test("普通咨询：字段齐全、字面固定中文、不列任何分支清单", () => {
  assert.equal(
    buildHandoffPrompt({ ...base, requirement: "先别动 git，告诉我该不该合并 main" }),
    [
      "请帮我判断下一步 git 操作，先别直接执行。",
      "",
      "仓库：F:/pi-web-client",
      "当前分支：main",
      "选中的分支：feat/context-panel",
      "领先 / 落后：↑2 ↓1",
      "未提交改动：3 个文件",
      "",
      "我的要求：先别动 git，告诉我该不该合并 main",
      "",
      "请按风险从低到高给我两三步做法，写清每步会动哪些文件、能不能撤回，以及冲突/鉴权失败时怎么办。",
    ].join("\n"),
  );
});

test("没有「可用分支」行，也不因 refs 变多而变长", () => {
  const text = buildHandoffPrompt(base);
  assert.ok(!text.includes("可用分支"));
  assert.ok(!text.includes("origin/feat"));
  assert.ok(text.length < 300, `提示词应只有十来行，实际 ${text.length} 字`);
  // 回归护栏：万一有人把 refs 入参加回来并渲染，上层误传也不该再让提示词变长。
  assert.equal(buildHandoffPrompt({ ...base, refs: ["main", "origin/main", "feat/context-panel"] }), text);
});

test("失败：argv / exit / code / stderr 与要求并成一份提示词", () => {
  assert.equal(
    buildHandoffPrompt({
      ...base,
      requirement: "提交：git commit -m 'nothing staged'",
      failure: {
        argv: ["commit", "-m", "nothing staged"],
        exitCode: 1,
        code: "op_failed",
        stderr: "nothing to commit, working tree clean",
      },
    }),
    [
      "请帮我判断下一步 git 操作，先别直接执行。",
      "",
      "仓库：F:/pi-web-client",
      "当前分支：main",
      "选中的分支：feat/context-panel",
      "领先 / 落后：↑2 ↓1",
      "未提交改动：3 个文件",
      "",
      "刚才这条命令失败了：",
      "$ commit -m nothing staged",
      "exit 1 · op_failed",
      "nothing to commit, working tree clean",
      "",
      "我的要求：提交：git commit -m 'nothing staged'",
      "",
      "请按风险从低到高给我两三步做法，写清每步会动哪些文件、能不能撤回，以及冲突/鉴权失败时怎么办。",
    ].join("\n"),
  );
});

test("失败提示词只有一份：开头句与仓库行各出现一次", () => {
  const text = buildHandoffPrompt({
    ...base,
    failure: { argv: ["merge", "main"], exitCode: 1, stderr: "CONFLICT (content)" },
  });
  assert.equal(text.split("请帮我判断下一步 git 操作，先别直接执行。").length - 1, 1);
  assert.equal(text.split("仓库：F:/pi-web-client").length - 1, 1);
  assert.ok(!text.includes("\n\n请帮我判断下一步"));
});

test("缺省字段省略对应行；ahead / behind 单独给也补齐 0", () => {
  const text = buildHandoffPrompt({ repo: "F:/pi-web-client", branch: "main" });
  assert.ok(!text.includes("选中的分支"));
  assert.ok(!text.includes("领先 / 落后"));
  assert.ok(!text.includes("未提交改动"));
  assert.ok(!text.includes("我的要求"));
  assert.ok(!text.includes("刚才这条命令失败了"));
  assert.equal(buildHandoffPrompt({ repo: "F:/pi-web-client", branch: "main", ahead: 4 }).includes("领先 / 落后：↑4 ↓0"), true);
});

test("界面语言切到英文，提示词仍是中文（给 agent 的文案不走 tr）", () => {
  // setLang / applyLang 会写 document.documentElement.lang，Node 里给它一个最小桩。
  const prev = globalThis.document;
  globalThis.document = { documentElement: { lang: "" } };
  try {
    setLang("en");
    const text = buildHandoffPrompt({ ...base, requirement: "请判断" });
    assert.ok(text.startsWith("请帮我判断下一步 git 操作，先别直接执行。"));
    assert.ok(text.includes("仓库：F:/pi-web-client"));
  } finally {
    applyLang("zh-Hans");
    if (prev === undefined) delete globalThis.document;
    else globalThis.document = prev;
  }
});
