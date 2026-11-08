/**
 * 设置 → 子代理：基础字段的点号 patch（#213）。
 *
 * 这一页只写用户真的改过的键：模型一对（defaultModel + defaultProvider）、思考档位、四个行为
 * 开关、五个列表字段。落到磁盘上要满足的事：
 *   ① 改默认模型 = 同时写 defaultModel 与 defaultProvider（`/` 前那段），裸 id 不碰 provider；
 *   ② 清空任一字段 = 键从 JSON 里消失，不是空串，也不留 `"modelScope": {}` 这种空壳；
 *   ③ 列表字段逗号分隔 → 数组；只剩空白（或只有逗号）= 删键；
 *   ④ 布尔三态里 `false` 是值，不是「没写」；只有「继承」才是 null 删键；
 *   ⑤ 思考档位是固定七档，继承同样是一个 null。
 *
 * patch 由 web/src/subagents.ts 的纯函数拼，写盘由 bridge/src/pisettings.ts 的 applyPatch 做，
 * 这里把两段接起来验磁盘上的形状。
 *
 *   node --experimental-transform-types bridge/tests/subagents-basics-unit.mjs
 */
import assert from "node:assert/strict";
import { applyPatch } from "../src/pisettings.ts";
import {
  THINKING_LEVELS,
  readSubagentsKey,
  subagentsListPatch,
  subagentsModelPatch,
  subagentsModelText,
  subagentsTextPatch,
} from "../../web/src/subagents.ts";

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${name} — ${err.message}`);
  }
};

/** 磁盘上的样子：patch 叠到 base 上再序列化，和 writeSettings 落盘的那份 JSON 一致。 */
const saved = (base, patch) => JSON.parse(JSON.stringify(applyPatch(base, patch)));

check("改默认模型：defaultModel 与 defaultProvider 一起写，provider 是 / 前那段", () => {
  const out = saved({ theme: "dark" }, subagentsModelPatch("anthropic/claude-opus-4-6"));
  assert.deepEqual(out, {
    theme: "dark",
    subagents: { defaultModel: "claude-opus-4-6", defaultProvider: "anthropic" },
  });
});

check("裸 id 只动 defaultModel，已有的 defaultProvider 留着消歧", () => {
  const base = { subagents: { defaultModel: "old", defaultProvider: "anthropic" } };
  assert.deepEqual(Object.keys(subagentsModelPatch("gpt-5.2")), ["subagents.defaultModel"]);
  assert.deepEqual(saved(base, subagentsModelPatch("gpt-5.2")), {
    subagents: { defaultModel: "gpt-5.2", defaultProvider: "anthropic" },
  });
});

check("清空默认模型：两个键都删，`subagents` 空壳也不留", () => {
  const base = { subagents: { defaultModel: "claude-opus-4-6", defaultProvider: "anthropic" } };
  assert.deepEqual(saved(base, subagentsModelPatch("  ")), {});
});

check("清空文本字段 = 键消失（不是空串），父对象照旧", () => {
  const base = { subagents: { defaultProvider: "anthropic", disableThinking: true } };
  assert.deepEqual(subagentsTextPatch("defaultProvider", ""), { "subagents.defaultProvider": null });
  assert.deepEqual(saved(base, subagentsTextPatch("defaultProvider", "")), {
    subagents: { disableThinking: true },
  });
  assert.deepEqual(saved({}, subagentsTextPatch("defaultProvider", " openai ")), {
    subagents: { defaultProvider: "openai" },
  });
});

check("列表字段：逗号分隔 → 数组，去空白与空项", () => {
  const patch = subagentsListPatch("agentScanDirs", " ../a , b,, /tmp/c ");
  assert.deepEqual(patch, { "subagents.agentScanDirs": ["../a", "b", "/tmp/c"] });
  assert.deepEqual(saved({}, patch), { subagents: { agentScanDirs: ["../a", "b", "/tmp/c"] } });
});

check("清空列表字段 = 删键；只有逗号也算空", () => {
  const base = { subagents: { agentExcludeDirs: ["x"] } };
  assert.deepEqual(saved(base, subagentsListPatch("agentExcludeDirs", " , ,")), {});
});

check("布尔 false 是值；继承（null）才删键", () => {
  assert.deepEqual(saved({}, { "subagents.disableBuiltins": false }), {
    subagents: { disableBuiltins: false },
  });
  assert.deepEqual(saved({ subagents: { disableBuiltins: false } }, { "subagents.disableBuiltins": null }), {});
});

check("modelScope.allow 是嵌套键：能写、能读、清空时整块消失", () => {
  const patch = subagentsListPatch("modelScope.allow", "inherit, scoped");
  const out = saved({ subagents: { defaultModel: "m" } }, patch);
  assert.deepEqual(out, { subagents: { defaultModel: "m", modelScope: { allow: ["inherit", "scoped"] } } });
  assert.deepEqual(readSubagentsKey(out, "subagents.modelScope.allow"), ["inherit", "scoped"]);
  assert.deepEqual(saved(out, subagentsListPatch("modelScope.allow", "")), { subagents: { defaultModel: "m" } });
});

check("思考档位固定七档；继承 = 删键；不认识的值原样读得回来", () => {
  assert.deepEqual([...THINKING_LEVELS], ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(saved({ subagents: { defaultThinking: "high" } }, { "subagents.defaultThinking": null }), {});
  assert.equal(readSubagentsKey({ subagents: { maxThinking: "turbo" } }, "subagents.maxThinking"), "turbo");
});

check("只写改过的键：每个 patch 只带自己的键", () => {
  assert.deepEqual(Object.keys(subagentsTextPatch("projectRootResolution", "git-root")), [
    "subagents.projectRootResolution",
  ]);
  assert.deepEqual(Object.keys(subagentsListPatch("defaultExtensions", "x")), ["subagents.defaultExtensions"]);
  assert.deepEqual(Object.keys(subagentsModelPatch("openai/gpt-5.2")), [
    "subagents.defaultModel",
    "subagents.defaultProvider",
  ]);
});

check("输入框显示的那一对：provider/id，只有 id 就只显示 id", () => {
  assert.equal(subagentsModelText("anthropic", "claude-opus-4-6"), "anthropic/claude-opus-4-6");
  assert.equal(subagentsModelText(undefined, "claude-opus-4-6"), "claude-opus-4-6");
  assert.equal(subagentsModelText("anthropic", "openai/gpt-5.2"), "openai/gpt-5.2");
  assert.equal(subagentsModelText("anthropic", undefined), "");
});

check("readSubagentsKey：路径不对就是 undefined，数组不会被拆成对象", () => {
  const json = { subagents: { defaultProvider: "anthropic", agentScanDirs: ["a"] } };
  assert.equal(readSubagentsKey(json, "subagents.defaultProvider"), "anthropic");
  assert.deepEqual(readSubagentsKey(json, "subagents.agentScanDirs"), ["a"]);
  assert.equal(readSubagentsKey(json, "subagents.agentScanDirs.x"), undefined);
  assert.equal(readSubagentsKey(null, "subagents.defaultProvider"), undefined);
});

if (failures) {
  console.log(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
