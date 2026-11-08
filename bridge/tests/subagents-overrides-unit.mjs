/**
 * 设置 → 子代理：按 agent 覆盖模型与思考档位（#214）。
 *
 * agent 表右半边只写两个键 —— `subagents.agentOverrides.<name>.model|thinking`，agent 自己的
 * `.md` 一个字不动。要守住的事：
 *   ① 覆盖判定只看这两个键非不非空（`model` / `thinking` 任一有值 = 这一行「改」过）；
 *   ② 空串 = null = 删键；两个都空时 `agentOverrides.<name>` 整支消失（不留空对象）；
 *   ③ 一行只发它自己的两个键，别人的覆盖与 `subagents.*` 其它键原样不动；
 *   ④ 手输一个不在模型清单里的 id 只标红，patch 照旧带上它（拒绝它的是子代理启动那一刻）。
 *
 * patch 由 web/src/subagents.ts 的纯函数拼，写盘由 bridge/src/pisettings.ts 的 applyPatch 做，
 * 这里把两段接起来验磁盘上的形状。
 *
 *   node --experimental-transform-types bridge/tests/subagents-overrides-unit.mjs
 */
import assert from "node:assert/strict";
import { applyPatch } from "../src/pisettings.ts";
import {
  subagentOverride,
  subagentOverridePatch,
  subagentOverridden,
  subagentsModelKnown,
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

check("没写过覆盖：两边都是 null，这一行不算「改」", () => {
  const json = { subagents: { defaultThinking: "high" } };
  assert.deepEqual(subagentOverride(json, "worker"), { model: null, thinking: null });
  assert.equal(subagentOverridden(subagentOverride(json, "worker")), false);
  assert.deepEqual(subagentOverride(null, "worker"), { model: null, thinking: null });
});

check("只有 model 也算改（thinking 仍旧继承）", () => {
  const json = { subagents: { agentOverrides: { worker: { model: "openai/gpt-5.2" } } } };
  assert.deepEqual(subagentOverride(json, "worker"), { model: "openai/gpt-5.2", thinking: null });
  assert.equal(subagentOverridden(subagentOverride(json, "worker")), true);
  assert.deepEqual(subagentOverride(json, "reviewer"), { model: null, thinking: null });
});

check("磁盘上的空串 / 非字符串当成没写", () => {
  const json = { subagents: { agentOverrides: { worker: { model: "", thinking: 3 } } } };
  assert.deepEqual(subagentOverride(json, "worker"), { model: null, thinking: null });
});

check("换某个 agent 的模型：只有它的 model 键落盘，别人的不动", () => {
  const base = {
    theme: "dark",
    subagents: { defaultModel: "claude-opus-4-6", agentOverrides: { reviewer: { thinking: "high" } } },
  };
  const patch = subagentOverridePatch("worker", "openai/gpt-5.2", "");
  const out = saved(base, patch);
  assert.deepEqual(out, {
    theme: "dark",
    subagents: {
      defaultModel: "claude-opus-4-6",
      agentOverrides: { reviewer: { thinking: "high" }, worker: { model: "openai/gpt-5.2" } },
    },
  });
});

check("model 与 thinking 一起写：两个键都在同一支下面", () => {
  const patch = subagentOverridePatch("reviewer", " anthropic/claude-opus-4-6 ", " xhigh ");
  assert.deepEqual(patch, {
    "subagents.agentOverrides.reviewer.model": "anthropic/claude-opus-4-6",
    "subagents.agentOverrides.reviewer.thinking": "xhigh",
  });
  assert.deepEqual(saved({}, patch), {
    subagents: { agentOverrides: { reviewer: { model: "anthropic/claude-opus-4-6", thinking: "xhigh" } } },
  });
});

check("清空这一行的覆盖：两个键都删，`agentOverrides.<name>` 整支不留空壳", () => {
  const base = { subagents: { agentOverrides: { worker: { model: "openai/gpt-5.2", thinking: "low" } } } };
  const patch = subagentOverridePatch("worker", "", "");
  assert.deepEqual(patch, {
    "subagents.agentOverrides.worker.model": null,
    "subagents.agentOverrides.worker.thinking": null,
  });
  assert.deepEqual(saved(base, patch), {});
});

check("只清 half：另一边的覆盖留着，父对象也不消失", () => {
  const base = { subagents: { agentOverrides: { worker: { model: "openai/gpt-5.2", thinking: "low" } } } };
  assert.deepEqual(saved(base, subagentOverridePatch("worker", "openai/gpt-5.2", "")), {
    subagents: { agentOverrides: { worker: { model: "openai/gpt-5.2" } } },
  });
});

check("清掉最后一行时 `agentOverrides` 与 `subagents` 空壳都不留", () => {
  const base = { subagents: { agentOverrides: { worker: { model: "m" } } } };
  assert.deepEqual(saved(base, subagentOverridePatch("worker", "", "")), {});
});

check("手输不认识的模型 id：标红但不拦保存，值原样写进去", () => {
  const models = [{ provider: "anthropic", id: "claude-opus-4-6" }];
  assert.equal(subagentsModelKnown(models, "gateway/new-model"), false);
  const out = saved({}, subagentOverridePatch("scout", "gateway/new-model", ""));
  assert.equal(out.subagents.agentOverrides.scout.model, "gateway/new-model");
});

check("空值（= 继承）算认识：不会被标红", () => {
  assert.equal(subagentsModelKnown([], "  "), true);
});

if (failures) {
  console.log(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
