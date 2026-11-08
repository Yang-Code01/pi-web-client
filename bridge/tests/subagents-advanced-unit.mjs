/**
 * 设置 → 子代理 → 高级（#216）：看门狗 / 按 provider 覆盖 / 设备。
 *
 * 这三块只能改文件里**已经存在**的条目（新建走「编辑 JSON」），所以真正要守住的是：
 *   ① 「高级」的折叠状态记在自己的 localStorage 键上，不和设置页那条 `pi.settings.advanced` 撞；
 *   ② 读出的行只算「值是对象」的条目，按 provider → agent / 标签名字排序；
 *   ③ patch 只动这一行的两个叶子键（`rex.ssh` / `cwd` 是两层），兄弟条目与 `subagents.*` 其它键原样；
 *   ④ `local` 是内置标签，任何 scope 都不能写；项目 scope 底下设备一律只读（Rex 主机只允许写在
 *      用户设置里）。
 *
 * patch 由 web/src/subagents.ts 的纯函数拼，写盘由 bridge/src/pisettings.ts 的 applyPatch 做，
 * 这里把两段接起来验磁盘上的形状。
 *
 *   node --experimental-transform-types bridge/tests/subagents-advanced-unit.mjs
 */
import assert from "node:assert/strict";
import { applyPatch } from "../src/pisettings.ts";
import {
  SUBAGENTS_ADVANCED_OPEN_KEY,
  machineEditable,
  machinePatch,
  machineRows,
  providerOverridePatch,
  providerOverrideRows,
  subagentsAdvancedOpen,
  watchdogChildOverridePatch,
  watchdogChildrenOverrideRows,
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

check("折叠状态记在自己那条键上，不和设置页的 pi.settings.advanced 撞", () => {
  assert.equal(SUBAGENTS_ADVANCED_OPEN_KEY, "pi.settings.subagents.advanced");
  assert.notEqual(SUBAGENTS_ADVANCED_OPEN_KEY, "pi.settings.advanced");
});

check("折叠状态：只认 \"1\" 是展开，没存过 / \"0\" / 别的值都算折叠", () => {
  assert.equal(subagentsAdvancedOpen("1"), true);
  assert.equal(subagentsAdvancedOpen("0"), false);
  assert.equal(subagentsAdvancedOpen(null), false);
  assert.equal(subagentsAdvancedOpen("true"), false);
});

check("看门狗按 agent 覆盖：只列文件里已经写过的条目，按 agent 排序", () => {
  const json = {
    subagents: {
      watchdog: {
        children: {
          overrides: {
            reviewer: { model: "anthropic/claude-opus-4-6", thinking: "high" },
            scout: { enabled: false },
            broken: "nope",
          },
        },
      },
    },
  };
  assert.deepEqual(watchdogChildrenOverrideRows(json), [
    { agent: "reviewer", model: "anthropic/claude-opus-4-6", thinking: "high" },
    { agent: "scout", model: null, thinking: null },
  ]);
});

check("没写过看门狗覆盖：空数组，不炸", () => {
  assert.deepEqual(watchdogChildrenOverrideRows(null), []);
  assert.deepEqual(watchdogChildrenOverrideRows({ subagents: { watchdog: {} } }), []);
});

check("改一条看门狗覆盖：只写它的两个键，兄弟条目与别的键原样", () => {
  const base = {
    theme: "dark",
    subagents: {
      watchdog: {
        enabled: true,
        children: { overrides: { reviewer: { thinking: "high" }, worker: { model: "openai/gpt-5.2" } } },
      },
    },
  };
  const patch = watchdogChildOverridePatch("reviewer", " anthropic/claude-opus-4-6 ", " max ");
  assert.deepEqual(patch, {
    "subagents.watchdog.children.overrides.reviewer.model": "anthropic/claude-opus-4-6",
    "subagents.watchdog.children.overrides.reviewer.thinking": "max",
  });
  const out = saved(base, patch);
  assert.deepEqual(out, {
    theme: "dark",
    subagents: {
      watchdog: {
        enabled: true,
        children: {
          overrides: {
            reviewer: { model: "anthropic/claude-opus-4-6", thinking: "max" },
            worker: { model: "openai/gpt-5.2" },
          },
        },
      },
    },
  });
});

check("清空一条看门狗覆盖：两个键都删，这一条整支消失（兄弟还在）", () => {
  const base = {
    subagents: { watchdog: { children: { overrides: { reviewer: { model: "m", thinking: "low" }, worker: {} } } } },
  };
  const out = saved(base, watchdogChildOverridePatch("reviewer", "", ""));
  assert.deepEqual(out, { subagents: { watchdog: { children: { overrides: { worker: {} } } } } });
});

check("按 provider 覆盖：按 provider → agent 读出来，非对象条目不列", () => {
  const json = {
    subagents: {
      agentOverridesByProvider: {
        openrouter: { worker: { model: "openrouter/openai/gpt-5-mini" }, reviewer: { thinking: "xhigh" } },
        "github-copilot": { worker: { model: "github-copilot/gpt-5-mini" } },
        broken: ["not", "a", "map"],
      },
    },
  };
  assert.deepEqual(providerOverrideRows(json), [
    { provider: "github-copilot", agent: "worker", model: "github-copilot/gpt-5-mini", thinking: null },
    { provider: "openrouter", agent: "reviewer", model: null, thinking: "xhigh" },
    { provider: "openrouter", agent: "worker", model: "openrouter/openai/gpt-5-mini", thinking: null },
  ]);
});

check("没写过按 provider 覆盖：空数组", () => {
  assert.deepEqual(providerOverrideRows(null), []);
  assert.deepEqual(providerOverrideRows({ subagents: { agentOverrides: { worker: { model: "m" } } } }), []);
});

check("改一条 provider 覆盖：键是 agentOverridesByProvider.<provider>.<agent>.{model,thinking}", () => {
  const base = {
    subagents: {
      agentOverridesByProvider: {
        openrouter: { worker: { model: "openrouter/openai/gpt-5-mini" }, reviewer: { thinking: "xhigh" } },
      },
    },
  };
  const patch = providerOverridePatch("openrouter", "worker", "", "high");
  assert.deepEqual(patch, {
    "subagents.agentOverridesByProvider.openrouter.worker.model": null,
    "subagents.agentOverridesByProvider.openrouter.worker.thinking": "high",
  });
  assert.deepEqual(saved(base, patch), {
    subagents: {
      agentOverridesByProvider: {
        openrouter: { reviewer: { thinking: "xhigh" }, worker: { thinking: "high" } },
      },
    },
  });
});

check("设备：读出已存在的标签与 rex.ssh，缺的字段是 null", () => {
  const json = {
    subagents: {
      machines: {
        workmac: { rex: { ssh: "100.82.67.118" }, cwd: "~/dev/app" },
        box: { cwd: "/srv/app" },
        broken: 3,
      },
    },
  };
  assert.deepEqual(machineRows(json), [
    { label: "box", ssh: null, cwd: "/srv/app" },
    { label: "workmac", ssh: "100.82.67.118", cwd: "~/dev/app" },
  ]);
  assert.deepEqual(machineRows(null), []);
});

check("local 是内置标签：全局也不能写；项目 scope 里任何标签都只读", () => {
  assert.equal(machineEditable("local", "global"), false);
  assert.equal(machineEditable("local", "project"), false);
  assert.equal(machineEditable("workmac", "global"), true);
  assert.equal(machineEditable("workmac", "project"), false);
});

check("改一台设备：只写它的 rex.ssh 与 cwd，别的标签原样", () => {
  const base = {
    subagents: {
      machines: {
        workmac: { rex: { ssh: "100.82.67.118" }, cwd: "~/dev/app" },
        box: { cwd: "/srv/app" },
      },
    },
  };
  const patch = machinePatch("workmac", " 100.82.67.119 ", "/srv/next");
  assert.deepEqual(patch, {
    "subagents.machines.workmac.rex.ssh": "100.82.67.119",
    "subagents.machines.workmac.cwd": "/srv/next",
  });
  assert.deepEqual(saved(base, patch), {
    subagents: {
      machines: {
        workmac: { rex: { ssh: "100.82.67.119" }, cwd: "/srv/next" },
        box: { cwd: "/srv/app" },
      },
    },
  });
});

check("两个字段都清空：这台设备整支消失，别的标签还在", () => {
  const base = { subagents: { machines: { workmac: { rex: { ssh: "h" }, cwd: "~/app" }, box: { cwd: "/srv" } } } };
  assert.deepEqual(saved(base, machinePatch("workmac", "", "")), {
    subagents: { machines: { box: { cwd: "/srv" } } },
  });
});

if (failures) {
  console.log(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
