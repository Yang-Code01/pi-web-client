/**
 * #284 设置矩阵与保存 diff：纯函数单测——分组/顺序、生效优先级、列表合并、模型对、保存 patch。
 *
 *   node web/tests/settings-console-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMatrix,
  diffPatch,
  effectiveOf,
  flattenSettings,
  formatCell,
  inheritText,
} from "../src/settings-matrix.ts";

/** 现有 settingFields() 的前 10 个核心字段（label/kind/group 照抄，够测矩阵形状）。 */
const CORE_FIELDS = [
  { key: "defaultModel", label: "默认模型", kind: "model", group: "模型与思考", defaultText: "自动，挑一个能用的" },
  { key: "defaultThinkingLevel", label: "默认思考档位", kind: "select" },
  { key: "enabledModels", label: "循环切换的模型范围", kind: "list", defaultText: "全部可用" },
  { key: "sessionDir", label: "会话目录", kind: "text", group: "会话", defaultText: "pi 的会话目录" },
  { key: "sessionShareDestination", label: "/share 发到哪", kind: "select" },
  { key: "images.autoResize", label: "图片自动缩", kind: "bool" },
  { key: "images.blockImages", label: "不给模型发图片", kind: "bool" },
  { key: "enableSkillCommands", label: "技能注册成 /skill:名字", kind: "bool" },
  { key: "web.defaultPermission", label: "新会话的默认权限", kind: "select", group: "工具与脚本" },
  { key: "defaultTools", label: "默认工具", kind: "list" },
];

test("buildMatrix：按字段顺序产出，没写 group 的行沿用上一组", () => {
  const rows = buildMatrix(CORE_FIELDS, {}, {}, {});
  assert.deepEqual(
    rows.map((r) => r.key),
    CORE_FIELDS.map((f) => f.key),
  );
  assert.deepEqual(
    rows.map((r) => r.group),
    [
      "模型与思考",
      "模型与思考",
      "模型与思考",
      "会话",
      "会话",
      "会话",
      "会话",
      "会话",
      "工具与脚本",
      "工具与脚本",
    ],
  );
});

test("buildMatrix：一上来就没有 group 的字段归「其他」", () => {
  const rows = buildMatrix(
    [{ key: "shellPath", label: "shell 路径", kind: "text", advanced: true }],
    {},
    {},
    {},
  );
  assert.equal(rows[0].group, "其他");
  assert.equal(rows[0].advanced, true);
});

test("buildMatrix：项目覆盖的行带项目值，globalOnly 行没有项目值", () => {
  const fields = [
    ...CORE_FIELDS,
    { key: "cacheWarming", label: "缓存预热", kind: "select", globalOnly: true },
  ];
  const rows = buildMatrix(
    fields,
    { defaultThinkingLevel: "low", cacheWarming: "off" },
    {
      defaultThinkingLevel: "max",
      sessionDir: "/tmp/s",
      defaultTools: ["+bash"],
      cacheWarming: "streaming",
    },
    {},
  );
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));

  assert.equal(byKey.defaultThinkingLevel.project, "max");
  assert.equal(byKey.sessionDir.project, "/tmp/s");
  assert.deepEqual(byKey.defaultTools.project, ["+bash"]);
  assert.equal(
    rows.filter((r) => r.project !== undefined).length,
    3,
    "正好 3 行被项目覆盖",
  );

  assert.equal(byKey.cacheWarming.globalOnly, true);
  assert.equal(byKey.cacheWarming.global, "off");
  assert.equal(byKey.cacheWarming.project, undefined, "globalOnly 不读项目层");
  assert.equal(byKey.defaultThinkingLevel.globalOnly, false);
});

test("effectiveOf：项目已设置 → 项目；否则全局；否则 defaults；都没有 → undefined", () => {
  assert.deepEqual(
    effectiveOf("sessionDir", "text", { sessionDir: "/g" }, { sessionDir: "/p" }, {}),
    { value: "/p", source: "project" },
  );
  assert.deepEqual(
    effectiveOf("sessionDir", "text", { sessionDir: "/g" }, {}, { sessionDir: "/d" }),
    { value: "/g", source: "global" },
  );
  assert.deepEqual(
    effectiveOf("sessionDir", "text", {}, {}, { sessionDir: "/d" }),
    { value: "/d", source: "default" },
  );
  assert.deepEqual(effectiveOf("sessionDir", "text", {}, {}, {}), {
    value: undefined,
    source: "default",
  });
});

test("空串和 null 按未设置，不挡住下一层", () => {
  assert.deepEqual(
    effectiveOf("sessionDir", "text", { sessionDir: "/g" }, { sessionDir: "" }, {}),
    { value: "/g", source: "global" },
  );
  assert.deepEqual(
    effectiveOf("sessionDir", "text", { sessionDir: "/g" }, { sessionDir: null }, {}),
    { value: "/g", source: "global" },
  );
  assert.deepEqual(
    effectiveOf("sessionDir", "text", { sessionDir: "" }, { sessionDir: "" }, {}),
    { value: undefined, source: "default" },
  );
});

test("buildMatrix：每行的 effective/source 跟着两层值走", () => {
  const rows = buildMatrix(
    CORE_FIELDS,
    { defaultThinkingLevel: "low", sessionDir: "/g" },
    { sessionDir: "/p" },
    { imagesAutoResize: true },
  );
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));

  assert.equal(byKey.sessionDir.effective, "/p");
  assert.equal(byKey.sessionDir.source, "project");
  assert.equal(byKey.defaultThinkingLevel.effective, "low");
  assert.equal(byKey.defaultThinkingLevel.source, "global");
  assert.equal(byKey.defaultThinkingLevel.project, undefined);
  assert.equal(byKey.sessionShareDestination.effective, undefined);
  assert.equal(byKey.sessionShareDestination.source, "default");
});

test("globalOnly 行即使项目文件里写了值也不取项目层", () => {
  const rows = buildMatrix(
    [{ key: "cacheWarming", label: "缓存预热", kind: "select", globalOnly: true }],
    { cacheWarming: "off" },
    { cacheWarming: "streaming" },
    { cacheWarming: "idle" },
  );
  assert.equal(rows[0].effective, "off");
  assert.equal(rows[0].source, "global");
  assert.equal(rows[0].global, "off");
  assert.equal(rows[0].project, undefined);
});

const MODEL_FIELD = {
  key: "defaultModel",
  label: "默认模型",
  kind: "model",
  group: "模型与思考",
  defaultText: "自动，挑一个能用的",
};

test("模型字段：defaultProvider + defaultModel 当一个值，半截配置不算设置", () => {
  const global = { defaultProvider: "anthropic", defaultModel: "claude-sonnet" };
  const project = { defaultProvider: "deepseek", defaultModel: "v4" };
  const rows = buildMatrix([MODEL_FIELD], global, project, {
    defaultProvider: "google",
    defaultModel: "gemini",
  });
  assert.deepEqual(rows[0].global, { provider: "anthropic", model: "claude-sonnet" });
  assert.deepEqual(rows[0].project, { provider: "deepseek", model: "v4" });
  assert.deepEqual(rows[0].effective, { provider: "deepseek", model: "v4" });
  assert.equal(rows[0].source, "project");

  const partialProject = buildMatrix([MODEL_FIELD], global, { defaultProvider: "deepseek" }, {});
  assert.equal(partialProject[0].project, undefined, "只写 provider 不算一对");
  assert.deepEqual(partialProject[0].effective, { provider: "anthropic", model: "claude-sonnet" });
  assert.equal(partialProject[0].source, "global");

  const fromDefaults = buildMatrix([MODEL_FIELD], {}, {}, {
    defaultProvider: "google",
    defaultModel: "gemini",
  });
  assert.deepEqual(fromDefaults[0].effective, { provider: "google", model: "gemini" });
  assert.equal(fromDefaults[0].source, "default");
});

test("列表字段：两层都有值时 merge=true，但不伪造合并后的数组", () => {
  const field = { key: "defaultTools", label: "默认工具", kind: "list", group: "工具与脚本" };
  const rows = buildMatrix([field], { defaultTools: ["read"] }, { defaultTools: ["+bash"] }, {});
  assert.equal(rows[0].merge, true);
  assert.deepEqual(rows[0].global, ["read"]);
  assert.deepEqual(rows[0].project, ["+bash"]);
  assert.deepEqual(rows[0].effective, ["+bash"], "生效值按覆盖优先级，不合成 [read, +bash]");
  assert.equal(rows[0].effective.length, 1);

  const onlyGlobal = buildMatrix([field], { defaultTools: ["read"] }, {}, {});
  assert.equal(onlyGlobal[0].merge, undefined);
});

test("formatCell：叶子/数组/模型都按现有 fmtSetting 的样子显示", () => {
  assert.equal(formatCell("text", "/tmp/pi"), "/tmp/pi");
  assert.equal(formatCell("number", 0), "0");
  assert.equal(formatCell("bool", true), "开");
  assert.equal(formatCell("bool", false), "关");
  assert.equal(formatCell("select", "max"), "max");
  assert.equal(formatCell("list", ["read", "bash"]), "read, bash");
  assert.equal(formatCell("model", { provider: "deepseek", model: "v4" }), "deepseek/v4");
  assert.equal(formatCell("text", undefined), "");
  assert.equal(formatCell("text", ""), "");
  assert.equal(formatCell("text", null), "");
});

test("inheritText：继承全局 / 继承 pi 默认 / 默认三种文案", () => {
  const field = {
    key: "defaultThinkingLevel",
    label: "默认思考档位",
    kind: "select",
    defaultText: "auto",
  };
  assert.equal(inheritText("select", "global", "max", field), "继承全局 · max");
  assert.equal(inheritText("select", "default", "medium", field), "继承 pi 默认 · medium");
  assert.equal(inheritText("select", "default", undefined, field), "默认 · auto");
  assert.equal(
    inheritText("text", "default", undefined, { ...field, kind: "text", defaultText: undefined }),
    "默认",
  );
  assert.equal(
    inheritText("model", "global", { provider: "anthropic", model: "claude" }, MODEL_FIELD),
    "继承全局 · anthropic/claude",
  );
  assert.equal(inheritText("select", "project", "max", field), "", "项目行没有继承文案");
});

const DIFF_FIELDS = [
  { key: "defaultModel", label: "默认模型", kind: "model", group: "模型与思考" },
  { key: "defaultThinkingLevel", label: "默认思考档位", kind: "select" },
  { key: "sessionDir", label: "会话目录", kind: "text" },
  { key: "compaction.reserveTokens", label: "压缩：保留的空余 token", kind: "number" },
  { key: "defaultTools", label: "默认工具", kind: "list" },
];

test("diffPatch：只改一个键，patch 里只有这个键", () => {
  const snapshot = {
    defaultProvider: "anthropic",
    defaultModel: "claude",
    defaultThinkingLevel: "low",
    sessionDir: "/g",
    "compaction.reserveTokens": 1000,
    defaultTools: ["read"],
  };
  const draft = { ...snapshot, defaultThinkingLevel: "max" };
  assert.deepEqual(diffPatch(snapshot, draft, DIFF_FIELDS), { defaultThinkingLevel: "max" });
});

test("diffPatch：没改就是空 patch；数组按深比较", () => {
  const snapshot = { defaultTools: ["read", "bash"], sessionDir: "/g" };
  const draft = { defaultTools: ["read", "bash"], sessionDir: "/g" };
  assert.deepEqual(diffPatch(snapshot, draft, DIFF_FIELDS), {});

  const reordered = { ...snapshot, defaultTools: ["bash", "read"] };
  assert.deepEqual(diffPatch(snapshot, reordered, DIFF_FIELDS), {
    defaultTools: ["bash", "read"],
  });
});

test("diffPatch：清空已有键 → null；本来就没设置不算变化", () => {
  const snapshot = { sessionDir: "/g", "compaction.reserveTokens": 1000 };
  const draft = { sessionDir: "", "compaction.reserveTokens": 1000 };
  assert.deepEqual(diffPatch(snapshot, draft, DIFF_FIELDS), { sessionDir: null });

  assert.deepEqual(diffPatch({}, { sessionDir: "" }, DIFF_FIELDS), {});
});

test("diffPatch：快照与草稿都是扁平点号键", () => {
  assert.deepEqual(
    diffPatch(
      { "compaction.reserveTokens": 1000 },
      { "compaction.reserveTokens": 2000 },
      DIFF_FIELDS,
    ),
    { "compaction.reserveTokens": 2000 },
  );
});

test("diffPatch：模型只改一边 → 两个键一起进 patch", () => {
  const snapshot = { defaultProvider: "anthropic", defaultModel: "claude" };
  assert.deepEqual(
    diffPatch(snapshot, { defaultProvider: "deepseek", defaultModel: "claude" }, DIFF_FIELDS),
    { defaultProvider: "deepseek", defaultModel: "claude" },
  );
  assert.deepEqual(
    diffPatch(snapshot, { defaultProvider: "anthropic", defaultModel: "v4" }, DIFF_FIELDS),
    { defaultProvider: "anthropic", defaultModel: "v4" },
  );
  assert.deepEqual(
    diffPatch(snapshot, { defaultProvider: "anthropic", defaultModel: "claude" }, DIFF_FIELDS),
    {},
  );
});

test("diffPatch：模型两边都清空 → 两个键都 null", () => {
  assert.deepEqual(
    diffPatch(
      { defaultProvider: "anthropic", defaultModel: "claude" },
      { defaultProvider: "", defaultModel: "" },
      DIFF_FIELDS,
    ),
    { defaultProvider: null, defaultModel: null },
  );
  assert.deepEqual(
    diffPatch({ defaultProvider: "anthropic", defaultModel: "claude" }, {}, DIFF_FIELDS),
    { defaultProvider: null, defaultModel: null },
  );
});

test("diffPatch：不修改入参", () => {
  const snapshot = { defaultProvider: "a", defaultModel: "m", defaultTools: ["read"] };
  const draft = { defaultProvider: "b", defaultModel: "m", defaultTools: [] };
  const snapshotBefore = structuredClone(snapshot);
  const draftBefore = structuredClone(draft);
  diffPatch(snapshot, draft, DIFF_FIELDS);
  assert.deepEqual(snapshot, snapshotBefore);
  assert.deepEqual(draft, draftBefore);
});

test("flattenSettings：嵌套对象拍成点号键，数组留整格，空对象不落键", () => {
  assert.deepEqual(
    flattenSettings({
      theme: "dark",
      defaultProvider: "stub",
      defaultModel: "fake-model",
      compaction: { enabled: false, reserveTokens: 1000 },
      images: { autoResize: true },
      nested: { empty: {} },
      enabledModels: ["stub/*", "other/*"],
    }),
    {
      theme: "dark",
      defaultProvider: "stub",
      defaultModel: "fake-model",
      "compaction.enabled": false,
      "compaction.reserveTokens": 1000,
      "images.autoResize": true,
      enabledModels: ["stub/*", "other/*"],
    },
  );
  assert.deepEqual(flattenSettings(null), {});
});
