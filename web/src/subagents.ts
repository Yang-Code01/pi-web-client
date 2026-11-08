/**
 * 设置 → 子代理（#212 只读清单，#213 基础字段可编辑）。
 *
 * 形状照 `.scratch/subagent-settings/prototype` 的样张 B：设置面板加宽到 980px，左栏锚点、右栏
 * 分区；agent 表本身仍然只读（名字 / 来源 / frontmatter 的 model 与 thinking），本页能改的是
 * 「默认 / 行为 / 发现与扩展」三节再加上面同一张表。
 *
 * 写入走既有的 `settings.set` 点号 patch：键是 `subagents.<…>`，`null` 表示删键；只发用户实际
 * 改过的键（改回原值就从 patch 里摘掉）。清空文本 / 列表 / 选「继承」都是一个 null。
 *
 * 这一片独立成 `paintSubagentsBasics()`：`acp_delegate` 那半页写的是另一个文件、另一条 RPC，
 * 由 #215 在同一文件里加自己的分区，两边互不碰。
 */
import { createEl as el } from "./chat.ts";
import { fileNameOf } from "./dirpicker.ts";
import { tr } from "./i18n/index.ts";
import { paintAcpDelegateSection, type AcpDelegateSection } from "./subagents-acp.ts";

export type AgentSource = "package" | "user" | "project" | "scan";

export interface SubagentFact {
  name: string;
  source: AgentSource;
  path: string;
  description: string | null;
  model: string | null;
  thinking: string | null;
}

export interface ScannedAgentDir {
  path: string;
  source: AgentSource;
  exists: boolean;
  count: number;
}

/** 桥的 `subagents.agents` 回包，字段和 bridge/src/subagents.ts 的 SubagentScan 一致。 */
export interface SubagentScan {
  cwd: string | null;
  installed: boolean;
  agents: SubagentFact[];
  directories: ScannedAgentDir[];
  errors: string[];
}

/** 这一页读的是哪一份 settings.json —— `settings` 回包里本页用得上的那几个字段。 */
export interface SubagentsSettingsView {
  path: string;
  exists: boolean;
  error: string | null;
  writable: boolean;
  json: Record<string, unknown> | null;
}

export interface SubagentsPage {
  scope: "global" | "project";
  cwd: string;
  /** 当前 scope 的 settings.json；还没读到就是 null。 */
  view: SubagentsSettingsView | null;
  /** 这一页打开时问的那次扫盘；null = 还在等桥回答。 */
  scan: SubagentScan | null;
  /** 模型下拉的候选（会话模型清单）；不认识的 id 只标红，不拦保存。 */
  models: { provider: string; id: string }[];
  projectEnabled: boolean;
  /** acp_delegate 那一半（#215）：写的是 billion-context 的文件，与上面的 settings.json 无关。 */
  acp: AcpDelegateSection;
  onScope(scope: "global" | "project"): void;
  onEditJson(): void;
  /** 把这一页收集到的点号 patch 交给外面；没有脏键时保存按钮根本点不动。 */
  onSave(patch: Record<string, unknown>): void;
}

/** pi 的七档思考档位；空串 = 继承（删键），本页不另造一套词汇。 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** settings.json 里一个 `subagents.*` 叶子；本页遇到的就是这几种形状。 */
export type SubagentsLeaf = string | number | boolean | string[] | Record<string, unknown> | null | undefined;

/** 读 `subagents.<…>` 这种整串点号路径（和 patch 的键同一套拼法），读不到就是 undefined。 */
export function readSubagentsKey(json: Record<string, unknown> | null, key: string): SubagentsLeaf {
  let node: unknown = json;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  if (Array.isArray(node)) return node.filter((entry): entry is string => typeof entry === "string");
  if (node && typeof node === "object") return node as Record<string, unknown>;
  return node as SubagentsLeaf;
}

/** 文本字段：空 = 删键（继承）。 */
export function subagentsTextPatch(key: string, text: string): Record<string, SubagentsLeaf> {
  const value = text.trim();
  return { [`subagents.${key}`]: value ? value : null };
}

/** 列表字段：逗号分隔 → 数组；全空 = 删键。 */
export function subagentsListPatch(key: string, text: string): Record<string, SubagentsLeaf> {
  const list = text
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return { [`subagents.${key}`]: list.length ? list : null };
}

/**
 * `defaultModel` 与 `defaultProvider` 是一对：写着 `provider/id` 时两半一起写，只写裸 id 就只动
 * model，清空则两个键都删 —— 留着旧供应商会让下一次裸 id 消歧到错的家。
 */
export function subagentsModelPatch(text: string): Record<string, SubagentsLeaf> {
  const value = text.trim();
  if (!value) return { "subagents.defaultModel": null, "subagents.defaultProvider": null };
  const at = value.indexOf("/");
  if (at < 0) return { "subagents.defaultModel": value };
  return { "subagents.defaultModel": value.slice(at + 1), "subagents.defaultProvider": value.slice(0, at) };
}

/** 输入框里显示的那一对：`provider/id`；只有 id 就只显示 id。 */
export function subagentsModelText(provider: unknown, model: unknown): string {
  if (typeof model !== "string" || !model) return "";
  return typeof provider === "string" && provider && !model.includes("/") ? `${provider}/${model}` : model;
}

/** 手输的模型 id 认不认识：空值算认识（= 继承）；不认识只是标红，不阻止保存。 */
export function subagentsModelKnown(models: { provider: string; id: string }[], value: string): boolean {
  const text = value.trim();
  if (!text) return true;
  const at = text.indexOf("/");
  if (at < 0) return models.some((model) => model.id === text);
  return models.some((model) => model.provider === text.slice(0, at) && model.id === text.slice(at + 1));
}

/** `agentOverrides.<name>` 那一支；没写的那半边是 null（= 跟 frontmatter / 默认走）。 */
export interface SubagentOverride {
  model: string | null;
  thinking: string | null;
}

/**
 * 读一行的覆盖（磁盘上的值，不是输入框里的草稿）。按**字面 key**取 `agentOverrides[name]`：名字里
 * 带 `.` 时走点号路径会读到别的层级，也会把这种名字误判成「没写过」。
 */
export function subagentOverride(json: Record<string, unknown> | null, name: string): SubagentOverride {
  const overrides = recordOf(readSubagentsKey(json, "subagents.agentOverrides"));
  const fields = overrides ? recordOf(overrides[name] as SubagentsLeaf) : null;
  const field = (key: "model" | "thinking"): string | null => textOf(fields, key);
  return { model: field("model"), thinking: field("thinking") };
}

/**
 * 点号 patch 的键是按 `.` 分层的：agent 名字里带 `.` 时 `agentOverrides.<name>.model` 会插到别的
 * 层级（写出一个谁都不认识的键）。这种名字在页面上只读，要改走「编辑 JSON」—— 保证不会发出这种键。
 */
export function subagentsNamePatchable(name: string): boolean {
  return name.length > 0 && !name.includes(".");
}

/** 这一行偏离了 agent 自己的 frontmatter：任一覆盖非空（「改」标记与行高亮都读它）。 */
export function subagentOverridden(override: SubagentOverride): boolean {
  return override.model !== null || override.thinking !== null;
}

/** 一行覆盖要写的两个键；空 = 删键，两个都空时 `agentOverrides.<name>` 整支随之消失。 */
export function subagentOverridePatch(name: string, model: string, thinking: string): Record<string, SubagentsLeaf> {
  return {
    [`subagents.agentOverrides.${name}.model`]: model.trim() || null,
    [`subagents.agentOverrides.${name}.thinking`]: thinking.trim() || null,
  };
}

/** 「高级」的折叠状态单独一条键，别和设置页「高级」那条 `pi.settings.advanced` 互相覆盖。 */
export const SUBAGENTS_ADVANCED_OPEN_KEY = "pi.settings.subagents.advanced";

/** 只认 "1" 是展开：没存过、存了 "0"、或者被手改成别的值，都按折叠处理。 */
export function subagentsAdvancedOpen(stored: string | null): boolean {
  return stored === "1";
}

/** 高级区三块「只列已存在的条目」的取值：值是对象才算一条，其它形状当没写。 */
function recordOf(raw: SubagentsLeaf): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
}

/** 条目里的一个文本叶子：空串 / 非字符串 = 没写。 */
function textOf(node: Record<string, unknown> | null, key: string): string | null {
  const value = node?.[key];
  return typeof value === "string" && value ? value : null;
}

/** `subagents.watchdog.children.overrides.<agent>` 的一条。 */
export interface WatchdogChildOverrideRow {
  agent: string;
  model: string | null;
  thinking: string | null;
}

/** 看门狗按 agent 的覆盖：只列文件里已经写过的条目，按 agent 名字排序。 */
export function watchdogChildrenOverrideRows(json: Record<string, unknown> | null): WatchdogChildOverrideRow[] {
  const overrides = recordOf(readSubagentsKey(json, "subagents.watchdog.children.overrides"));
  if (!overrides) return [];
  const rows: WatchdogChildOverrideRow[] = [];
  for (const agent of Object.keys(overrides).sort()) {
    const fields = recordOf(overrides[agent] as SubagentsLeaf);
    if (!fields) continue;
    rows.push({ agent, model: textOf(fields, "model"), thinking: textOf(fields, "thinking") });
  }
  return rows;
}

/** 一条看门狗覆盖要写的两个键；空 = 删键，两个都空时这一条整支消失。 */
export function watchdogChildOverridePatch(
  agent: string,
  model: string,
  thinking: string,
): Record<string, SubagentsLeaf> {
  const at = `subagents.watchdog.children.overrides.${agent}`;
  return { [`${at}.model`]: model.trim() || null, [`${at}.thinking`]: thinking.trim() || null };
}

/** `subagents.agentOverridesByProvider.<provider>.<agent>` 的一条。 */
export interface ProviderOverrideRow {
  provider: string;
  agent: string;
  model: string | null;
  thinking: string | null;
}

/** 按 provider 的覆盖：只列文件里已经写过的条目，按 provider → agent 排序。 */
export function providerOverrideRows(json: Record<string, unknown> | null): ProviderOverrideRow[] {
  const providers = recordOf(readSubagentsKey(json, "subagents.agentOverridesByProvider"));
  if (!providers) return [];
  const rows: ProviderOverrideRow[] = [];
  for (const provider of Object.keys(providers).sort()) {
    const agents = recordOf(providers[provider] as SubagentsLeaf);
    if (!agents) continue;
    for (const agent of Object.keys(agents).sort()) {
      const fields = recordOf(agents[agent] as SubagentsLeaf);
      if (!fields) continue;
      rows.push({ provider, agent, model: textOf(fields, "model"), thinking: textOf(fields, "thinking") });
    }
  }
  return rows;
}

/** 一条 provider 覆盖要写的两个键。 */
export function providerOverridePatch(
  provider: string,
  agent: string,
  model: string,
  thinking: string,
): Record<string, SubagentsLeaf> {
  const at = `subagents.agentOverridesByProvider.${provider}.${agent}`;
  return { [`${at}.model`]: model.trim() || null, [`${at}.thinking`]: thinking.trim() || null };
}

/** `subagents.machines.<label>` 的一条：`rex.ssh` 是 ssh 目标，`cwd` 是那边的仓库根。 */
export interface MachineRow {
  label: string;
  ssh: string | null;
  cwd: string | null;
}

/** 设备：只列文件里已经登记过的标签，按标签排序。 */
export function machineRows(json: Record<string, unknown> | null): MachineRow[] {
  const machines = recordOf(readSubagentsKey(json, "subagents.machines"));
  if (!machines) return [];
  const rows: MachineRow[] = [];
  for (const label of Object.keys(machines).sort()) {
    const machine = recordOf(machines[label] as SubagentsLeaf);
    if (!machine) continue;
    rows.push({ label, ssh: textOf(recordOf(machine.rex as SubagentsLeaf), "ssh"), cwd: textOf(machine, "cwd") });
  }
  return rows;
}

/**
 * `local` 是 pi-subagents 的内置标签（`machine: "local"`），写进文件没有意义；Rex 主机也只允许
 * 写在用户设置里 —— 项目设置里写一个 `rex` 条目会让子代理起不来，所以项目 scope 一律只读。
 */
export function machineEditable(label: string, scope: "global" | "project"): boolean {
  return scope === "global" && label !== "local";
}

/** 一台设备要写的两个键；空 = 删键，两个都空时这台整支消失。 */
export function machinePatch(label: string, ssh: string, cwd: string): Record<string, SubagentsLeaf> {
  return {
    [`subagents.machines.${label}.rex.ssh`]: ssh.trim() || null,
    [`subagents.machines.${label}.cwd`]: cwd.trim() || null,
  };
}

function sourceLabelOf(source: AgentSource): string {
  switch (source) {
    case "package":
      return tr("包内");
    case "user":
      return tr("用户");
    case "project":
      return tr("项目");
    case "scan":
      return tr("扫描目录");
  }
}

export interface SubagentsBasicsHost {
  defaults: HTMLElement;
  behavior: HTMLElement;
  discovery: HTMLElement;
  /** 页脚（在右侧滚动区之外，滚多远都能按到保存）。 */
  footer: HTMLElement;
}

/**
 * 整页共用一个 patch：`mark()` 记改动，改回磁盘上的值就摘掉。`locked` 是同一套禁用条件
 * （文件读不了 / 项目没被信任），agent 表的控件也照它禁用。
 */
export interface SubagentsEditor {
  locked: boolean;
  mark(entries: Record<string, SubagentsLeaf>): void;
}

/**
 * 「默认 / 行为 / 发现与扩展」三节一起画，三节共用一个 patch。
 *
 * 只写用户真的改过的键：值回到磁盘上原来那个就把它从 patch 里摘掉。空文本、空列表、「继承」
 * 一律是 `null`，桥侧 `applyPatch` 把它当删键。三种情况下控件与保存都不可用：文件读不了
 * （`view.error`）、项目没被信任、还没读到文件（只在外面画「读取中…」）。
 */
export function paintSubagentsBasics(host: SubagentsBasicsHost, page: SubagentsPage): SubagentsEditor | null {
  const view = page.view;
  if (!view) {
    for (const box of [host.defaults, host.behavior, host.discovery]) box.append(el("div", "empty", tr("读取中…")));
    return null;
  }
  const locked = Boolean(view.error) || (page.scope === "project" && !view.writable);
  const patch: Record<string, SubagentsLeaf> = {};
  const read = (key: string): SubagentsLeaf => readSubagentsKey(view.json, `subagents.${key}`);
  const same = (a: SubagentsLeaf, b: SubagentsLeaf): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  host.footer.append(el("span", "settings-hint", tr("只保存你改过的键；清空一个字段 = 从文件里删掉它。")));
  host.footer.append(el("span", "spacer"));
  const save = el("button", "btn primary", tr("保存")) as HTMLButtonElement;
  save.disabled = true;
  save.onclick = () => {
    if (!Object.keys(patch).length) return;
    page.onSave({ ...patch });
  };
  host.footer.append(save);

  /** 记一条改动；改回磁盘上的值就不再是脏键。 */
  const mark = (entries: Record<string, SubagentsLeaf>): void => {
    for (const [key, value] of Object.entries(entries)) {
      const field = key.slice("subagents.".length);
      if (same(value, read(field))) delete patch[key];
      else patch[key] = value;
    }
    save.disabled = locked || !Object.keys(patch).length;
  };
  const editor: SubagentsEditor = { locked, mark };

  const row = (box: HTMLElement, label: string, control: HTMLElement, hint?: string): void => {
    const line = el("label", "settings-row");
    line.append(el("span", "settings-label", label), control);
    if (hint) line.append(el("span", "settings-hint", hint));
    box.append(line);
  };

  const textRow = (box: HTMLElement, key: string, hint: string): void => {
    const input = el("input", "ns-input mono") as HTMLInputElement;
    input.type = "text";
    const current = read(key);
    input.value = typeof current === "string" ? current : "";
    input.disabled = locked;
    input.oninput = () => mark(subagentsTextPatch(key, input.value));
    row(box, key, input, hint);
  };

  const listRow = (box: HTMLElement, key: string, hint: string): void => {
    const input = el("input", "ns-input mono") as HTMLInputElement;
    input.type = "text";
    const current = read(key);
    input.value = Array.isArray(current) ? current.join(", ") : "";
    input.disabled = locked;
    input.oninput = () => mark(subagentsListPatch(key, input.value));
    row(box, key, input, hint);
  };

  /** 布尔三态：继承 = 删键；开 / 关是真正的 `true` / `false`。 */
  const boolRow = (box: HTMLElement, key: string, hint: string): void => {
    const select = el("select", "ns-input") as HTMLSelectElement;
    select.append(new Option(tr("继承"), ""), new Option(tr("开"), "true"), new Option(tr("关"), "false"));
    const current = read(key);
    select.value = typeof current === "boolean" ? String(current) : "";
    select.disabled = locked;
    select.onchange = () => mark({ [`subagents.${key}`]: select.value === "" ? null : select.value === "true" });
    row(box, key, select, hint);
  };

  /** 固定取值 + 继承：值不认识时把磁盘上的那个值挂成「（当前）」，不假装它不存在。 */
  const enumRow = (box: HTMLElement, key: string, options: readonly string[], hint?: string): void => {
    const select = el("select", "ns-input") as HTMLSelectElement;
    select.append(new Option(tr("继承"), ""));
    for (const option of options) select.append(new Option(option, option));
    const current = read(key);
    const value = typeof current === "string" ? current : "";
    if (value && !options.includes(value)) select.append(new Option(tr("{p1}（当前）", { p1: value }), value));
    select.value = value;
    select.disabled = locked;
    select.onchange = () => mark({ [`subagents.${key}`]: select.value || null });
    row(box, key, select, hint);
  };

  const heading = (box: HTMLElement, text: string, hint?: string): void => {
    const head = el("h3", "", text);
    if (hint) head.append(el("span", "subagents-hint", hint));
    box.append(head);
  };

  // ---------------------------------------------------------------- 默认
  heading(host.defaults, tr("默认"), tr("没有单独覆盖的子代理都用这里的值"));

  const model = el("input", "ns-input mono") as HTMLInputElement;
  model.type = "text";
  model.setAttribute("list", "subagents-models");
  model.value = subagentsModelText(read("defaultProvider"), read("defaultModel"));
  model.disabled = locked;
  // 不认识的 id 只标红：网关新上的模型不该等这一页更新。
  model.classList.toggle("bad", !subagentsModelKnown(page.models, model.value));
  model.oninput = () => {
    model.classList.toggle("bad", !subagentsModelKnown(page.models, model.value));
    mark(subagentsModelPatch(model.value));
  };
  row(host.defaults, "defaultModel", model, tr("可手输 provider/id；空 = 继承"));
  const datalist = document.createElement("datalist");
  datalist.id = "subagents-models";
  for (const known of page.models) {
    const option = document.createElement("option");
    option.value = `${known.provider}/${known.id}`;
    datalist.append(option);
  }
  host.defaults.append(datalist);

  textRow(host.defaults, "defaultProvider", tr("裸 id 时用于消歧"));
  enumRow(host.defaults, "defaultThinking", THINKING_LEVELS);
  enumRow(host.defaults, "maxThinking", THINKING_LEVELS, tr("更高的档位会被截断"));

  // ---------------------------------------------------------------- 行为
  heading(host.behavior, tr("行为"));
  boolRow(host.behavior, "disableThinking", tr("一律不传 thinking"));
  boolRow(host.behavior, "disableBuiltins", tr("不加载包内的子代理定义"));
  boolRow(host.behavior, "defaultInheritGlobalContext", tr("未写该字段时默认继承"));
  enumRow(host.behavior, "projectRootResolution", ["nearest", "git-root"], tr("项目 agents / overrides 的锚点"));

  // ------------------------------------------------------------ 发现与扩展
  const scan = page.scan;
  heading(
    host.discovery,
    tr("发现与扩展"),
    scan
      ? tr("扫了 {p1} 个目录，共读到 {p2} 个 agent 定义（同名后者覆盖前者）。", {
          p1: scan.directories.length,
          p2: scan.directories.reduce((sum, dir) => sum + dir.count, 0),
        })
      : tr("读取中…"),
  );
  listRow(host.discovery, "agentScanDirs", tr("逗号分隔；空 = 从文件里删掉这个键"));
  listRow(host.discovery, "agentExcludeDirs", tr("逗号分隔；空 = 从文件里删掉这个键"));
  listRow(host.discovery, "defaultExtensions", tr("逗号分隔；空 = 从文件里删掉这个键"));
  listRow(host.discovery, "defaultSubagentOnlyExtensions", tr("逗号分隔；空 = 从文件里删掉这个键"));
  listRow(host.discovery, "modelScope.allow", tr("留空 = 不限制；特殊值 inherit / scoped"));

  if (!scan) return editor;
  if (!scan.installed) {
    host.discovery.append(el("div", "note", tr("这台机器上没有装 pi-subagents：包内的 agent 目录不存在。装好之后这一页会自动列出来。")));
  }
  const dirs = el("div", "subagents-dirs");
  for (const dir of scan.directories) {
    const line = el("div", `subagents-dir${dir.exists ? "" : " missing"}`);
    line.append(el("span", `subagents-badge ${dir.source}`, sourceLabelOf(dir.source)));
    line.append(el("span", "dp", dir.path));
    line.append(el("span", "n", dir.exists ? String(dir.count) : tr("目录不存在")));
    dirs.append(line);
  }
  if (!scan.directories.length) dirs.append(el("div", "subagents-hint", tr("一个目录都没扫到。")));
  host.discovery.append(dirs);
  for (const error of scan.errors) host.discovery.append(el("div", "note warn", error));
  return editor;
}

/** 七档 + 继承；值不认识时把磁盘上的那个值挂成「当前」，不假装它不存在。 */
function fillThinking(select: HTMLSelectElement, current: string): void {
  select.append(new Option(tr("继承"), ""));
  for (const level of THINKING_LEVELS) select.append(new Option(level, level));
  if (current && !(THINKING_LEVELS as readonly string[]).includes(current)) {
    select.append(new Option(tr("{p1}（当前）", { p1: current }), current));
  }
  select.value = current;
}

export function paintSubagentsPage(body: HTMLElement, page: SubagentsPage): void {
  const wrap = el("div", "subagents-page");

  const bar = el("div", "subagents-bar");
  const scopeButton = (scope: "global" | "project", label: string) => {
    const button = el("button", "subagents-seg", label);
    button.setAttribute("aria-pressed", String(page.scope === scope));
    button.disabled = scope === "project" && !page.projectEnabled;
    button.onclick = () => page.onScope(scope);
    return button;
  };
  const projectName = fileNameOf(page.cwd);
  bar.append(
    scopeButton("global", tr("全局")),
    scopeButton("project", page.cwd ? tr("项目（{p1}）", { p1: projectName }) : tr("项目")),
    el("span", "spacer"),
  );
  const edit = el("button", "btn ghost", tr("编辑 JSON"));
  edit.disabled = !page.view?.writable;
  edit.onclick = () => page.onEditJson();
  bar.append(edit);
  wrap.append(bar);

  const view = page.view;
  wrap.append(el("div", "subagents-path", view ? tr("当前文件：{p1}", { p1: view.path }) : tr("读取中…")));
  if (view && !view.exists) wrap.append(el("div", "subagents-hint", tr("（还没有这个文件，保存时创建）")));
  if (view?.error) wrap.append(el("div", "note warn", tr("这个文件读不了：{p1}", { p1: view.error })));
  if (page.scope === "project") {
    wrap.append(
      el("div", "note warn", tr("项目 scope 的 subagents.* 写在 <cwd>/.pi/settings.json，随这个 worktree 一起消失；长期偏好请写全局。")),
    );
    if (view && !view.writable) {
      wrap.append(el("div", "note warn", tr("这个项目没有被信任：pi 不会读它的 .pi/settings.json，也拒绝写它。先到「项目信任」里信任它。")));
    }
  }

  const scan = page.scan;
  const split = el("div", "subagents-split");
  const nav = el("nav", "subagents-nav");
  const pane = el("div", "subagents-pane");
  split.append(nav, pane);
  wrap.append(split);

  const sections: { id: string; label: string; count?: number }[] = [
    { id: "default", label: tr("默认") },
    { id: "behavior", label: tr("行为") },
    { id: "discovery", label: tr("发现与扩展"), count: scan?.directories.length },
    { id: "agents", label: tr("每个子代理"), count: scan?.agents.length },
    { id: "advanced", label: tr("高级") },
    { id: "acp", label: "acp_delegate" },
  ];
  const links = new Map<string, HTMLAnchorElement>();
  const anchors = new Map<string, HTMLElement>();
  for (const section of sections) {
    if (section.id === "advanced") nav.append(el("div", "subagents-sep"));
    const link = el("a", section.id === "default" ? "on" : "", section.label);
    link.href = `#subagents-${section.id}`;
    link.onclick = (ev) => {
      ev.preventDefault();
      for (const [id, other] of links) other.classList.toggle("on", id === section.id);
      const target = anchors.get(section.id);
      // 「高级」默认折叠：先展开再滚，否则滚过去只看到一条标题。
      for (const details of target?.querySelectorAll<HTMLDetailsElement>("details.subagents-advanced") ?? []) {
        details.open = true;
      }
      target?.scrollIntoView({ block: "start" });
    };
    if (section.count !== undefined) link.append(el("span", "n", String(section.count)));
    links.set(section.id, link);
    nav.append(link);

    const box = el("section", "subagents-sec");
    box.id = `subagents-${section.id}`;
    pane.append(box);
    anchors.set(section.id, box);
  }

  const section = (id: string): HTMLElement => anchors.get(id)!;

  const footer = el("div", "subagents-foot");
  const editor = paintSubagentsBasics(
    { defaults: section("default"), behavior: section("behavior"), discovery: section("discovery"), footer },
    page,
  );
  wrap.append(footer);

  paintSubagentsAgents(section("agents"), page, editor);

  paintSubagentsAdvanced(section("advanced"), page, editor);
  paintAcpDelegateSection(section("acp"), page.acp);

  body.append(wrap);
}

/**
 * agent 表的右半边（#214）：每行只写 `agentOverrides.<name>.model|thinking`，左半边 frontmatter
 * 列照旧只读 —— 覆盖改不动 agent 自己的 `.md`。改过的行整行高亮并带「改」；行尾「清空」把两个键
 * 一起置 null，等于这一行回到 frontmatter。
 */
export function paintSubagentsAgents(box: HTMLElement, page: SubagentsPage, editor: SubagentsEditor | null): void {
  const head = el("h3", "", tr("每个子代理"));
  const count = el("span", "subagents-hint", "");
  head.append(count);
  box.append(head);

  const scan = page.scan;
  if (!scan) {
    box.append(el("div", "empty", tr("读取中…")));
    return;
  }
  const agents = [...scan.agents].sort((a, b) => a.name.localeCompare(b.name));
  if (!agents.length) {
    box.append(
      el(
        "div",
        "subagents-hint",
        scan.installed ? tr("扫描目录里没找到 agent 定义。") : tr("没有可列的 agent —— 先装 pi-subagents，或者往上面的目录里放 .md。"),
      ),
    );
    return;
  }

  const json = page.view?.json ?? null;
  const locked = !editor || editor.locked;

  const table = document.createElement("table");
  table.className = "subagents-agents";
  const headRow = table.createTHead().insertRow();
  for (const label of ["agent", tr("来源"), "frontmatter", tr("覆盖 model"), tr("覆盖 thinking"), ""]) {
    headRow.append(el("th", "", label));
  }
  const tbody = table.createTBody();

  const rows: {
    row: HTMLTableRowElement;
    chip: HTMLElement;
    clear: HTMLButtonElement;
    patchable: boolean;
    read(): SubagentOverride;
  }[] = [];

  /** 行高亮、「改」标记、清空按钮与标题里的计数都读当前输入框里的值（保存后重绘则读磁盘）。 */
  const refresh = (): void => {
    let overridden = 0;
    for (const entry of rows) {
      const on = subagentOverridden(entry.read());
      entry.row.classList.toggle("changed", on);
      entry.chip.hidden = !on;
      entry.clear.disabled = locked || !entry.patchable || !on;
      if (on) overridden += 1;
    }
    count.textContent = tr("{p1} 个，{p2} 处已覆盖", { p1: rows.length, p2: overridden });
  };

  for (const agent of agents) {
    // 名字带 `.` 的行只读：点号键插错层，写了也不生效（见 subagentsNamePatchable）。
    const patchable = subagentsNamePatchable(agent.name);
    const current = subagentOverride(json, agent.name);
    const row = tbody.insertRow();
    row.title = agent.path;

    const name = row.insertCell();
    name.className = "agent";
    name.append(document.createTextNode(agent.name));
    if (!patchable) name.append(el("div", "subagents-hint", tr("名字里有「.」：点号键会插错层，这里只读，要改请用「编辑 JSON」。")));
    const chip = el("span", "subagents-badge changed", tr("已改"));
    name.append(chip);

    const source = row.insertCell();
    source.append(el("span", `subagents-badge ${agent.source}`, sourceLabelOf(agent.source)));

    // agent 自己钉的值，只读；覆盖是盖在它上面的另一层。没钉就写「未钉」，不是空着也不是破折号。
    const fm = row.insertCell();
    fm.className = "fm";
    for (const key of ["model", "thinking"] as const) {
      const line = el("div", "fm-line");
      line.append(el("span", "k", key), document.createTextNode(agent[key] || tr("未钉")));
      fm.append(line);
    }

    const modelCell = row.insertCell();
    const modelInput = el("input", "ns-input mono") as HTMLInputElement;
    modelInput.type = "text";
    modelInput.setAttribute("list", "subagents-models");
    modelInput.value = current.model ?? "";
    modelInput.placeholder = tr("继承");
    modelInput.disabled = locked || !patchable;
    modelInput.classList.toggle("bad", !subagentsModelKnown(page.models, modelInput.value));
    modelCell.append(modelInput);

    const thinkingCell = row.insertCell();
    const thinking = el("select", "ns-input") as HTMLSelectElement;
    fillThinking(thinking, current.thinking ?? "");
    thinking.disabled = locked || !patchable;
    thinkingCell.append(thinking);

    const clearCell = row.insertCell();
    const clear = el("button", "btn ghost subagents-clear", tr("清空")) as HTMLButtonElement;
    clear.type = "button";
    clear.title = tr("清空这一行的覆盖");
    clearCell.append(clear);

    const read = (): SubagentOverride => ({ model: modelInput.value.trim() || null, thinking: thinking.value || null });
    if (patchable) {
      const commit = (): void => {
        // 两个键一起交：没改的那半与磁盘相同，mark() 会把它从 patch 里摘掉。
        editor?.mark(subagentOverridePatch(agent.name, modelInput.value, thinking.value));
        refresh();
      };
      modelInput.oninput = () => {
        // 不在清单里的 id 只标红：网关新上的模型不该等这一页更新，保存也不拦。
        modelInput.classList.toggle("bad", !subagentsModelKnown(page.models, modelInput.value));
        commit();
      };
      thinking.onchange = commit;
      clear.onclick = () => {
        modelInput.value = "";
        thinking.value = "";
        modelInput.classList.remove("bad");
        commit();
      };
    }
    rows.push({ row, chip, clear, patchable, read });
  }
  refresh();
  box.append(table);
  box.append(
    el(
      "div",
      "subagents-hint",
      tr("frontmatter 列只读；右边两列写的是 subagents.agentOverrides.<name>，优先级高于 frontmatter。"),
    ),
  );
}


/**
 * 「高级」区（#216）：看门狗、按 provider 覆盖、设备。
 *
 * 三块都只编辑文件里**已经存在**的条目 —— 新建一条还得同时定删除与校验语义，收益低，走「编辑
 * JSON」。整块默认折叠，状态单独记一条 localStorage；左栏锚点点到它时由 `paintSubagentsPage`
 * 先展开再滚。写入沿用点号 patch：空文本 = `null`，`applyPatch` 见到 null 删键，条目两个键都
 * 空了整支随之消失。
 */
export function paintSubagentsAdvanced(box: HTMLElement, page: SubagentsPage, editor: SubagentsEditor | null): void {
  const details = el("details", "subagents-advanced");
  details.open = subagentsAdvancedOpen(localStorage.getItem(SUBAGENTS_ADVANCED_OPEN_KEY));
  details.addEventListener("toggle", () => {
    localStorage.setItem(SUBAGENTS_ADVANCED_OPEN_KEY, details.open ? "1" : "0");
  });
  const summary = el("summary");
  summary.append(
    el("span", "", tr("高级")),
    el("span", "subagents-hint", tr("看门狗、按 provider 覆盖、设备 —— 只改文件里已经写过的条目")),
  );
  details.append(summary);
  box.append(details);

  const view = page.view;
  if (!view) {
    details.append(el("div", "empty", tr("读取中…")));
    return;
  }
  if (view.error) {
    details.append(el("div", "note warn", tr("这个文件读不了：{p1}", { p1: view.error })));
    return;
  }

  const json = view.json;
  const locked = !editor || editor.locked;
  const body = el("div", "subagents-adv-body");
  details.append(body);

  /** 文件里的一个文本叶子（`subagents.<key>`）；空串与非字符串都当没写。 */
  const str = (key: string): string | null => {
    const value = readSubagentsKey(json, `subagents.${key}`);
    return typeof value === "string" && value ? value : null;
  };

  /** 一块 = 标题 + 一行说明 + 表；没条目时调用方自己补一行。 */
  const block = (title: string, hint: string): HTMLElement => {
    const wrap = el("div", "subagents-adv-block");
    wrap.append(el("h4", "", title), el("p", "subagents-hint", hint));
    body.append(wrap);
    return wrap;
  };

  const table = (headers: string[]): { el: HTMLTableElement; body: HTMLTableSectionElement } => {
    const tableEl = document.createElement("table");
    tableEl.className = "subagents-adv-rows";
    const headRow = tableEl.createTHead().insertRow();
    for (const label of headers) headRow.append(el("th", "", label));
    return { el: tableEl, body: tableEl.createTBody() };
  };

  /** 标签格：名字 + 一句可选的只读说明（`local`）。 */
  const nameCell = (row: HTMLTableRowElement, name: string, note?: string): void => {
    const cell = row.insertCell();
    cell.className = "name";
    cell.append(document.createTextNode(name));
    if (note) cell.append(el("div", "subagents-hint", note));
  };

  const fieldRow = (parent: HTMLElement, label: string, control: HTMLElement, hint: string): void => {
    const line = el("label", "settings-row");
    line.append(el("span", "settings-label", label), control, el("span", "settings-hint", hint));
    parent.append(line);
  };

  /** 布尔三态：继承（文件里不写这个键）/ 开 / 关。 */
  const boolField = (key: string): HTMLSelectElement => {
    const select = el("select", "ns-input");
    select.append(new Option(tr("继承"), ""), new Option(tr("开"), "true"), new Option(tr("关"), "false"));
    const current = readSubagentsKey(json, `subagents.${key}`);
    select.value = typeof current === "boolean" ? String(current) : "";
    select.disabled = locked;
    select.onchange = () => editor?.mark({ [`subagents.${key}`]: select.value === "" ? null : select.value === "true" });
    return select;
  };

  const watchModel = (input: HTMLInputElement): void => {
    // 不在清单里的 id 只标红：网关新上的模型不该等这一页更新，保存也不拦。
    input.classList.toggle("bad", !subagentsModelKnown(page.models, input.value));
  };

  /** `editable` 用来给点号拼不出来的一行（名字里带 `.`）上只读：控件在，但不写键。 */
  const modelField = (current: string | null, editable = true): HTMLInputElement => {
    const input = el("input", "ns-input mono");
    input.type = "text";
    input.setAttribute("list", "subagents-models");
    input.value = current ?? "";
    input.placeholder = tr("继承");
    input.disabled = locked || !editable;
    watchModel(input);
    return input;
  };

  const thinkingField = (current: string | null, editable = true): HTMLSelectElement => {
    const select = el("select", "ns-input");
    fillThinking(select, current ?? "");
    select.disabled = locked || !editable;
    return select;
  };

  const dottedNote = tr("名字里有「.」：点号键会插错层，这里只读，要改请用「编辑 JSON」。");

  const watchdog = block(
    tr("看门狗"),
    tr("看门狗是另一次模型调用：复核主代理刚做完的事。这块改的是谁来看门，不是子代理自己用哪个模型。"),
  );
  fieldRow(
    watchdog,
    "watchdog.enabled",
    boolField("watchdog.enabled"),
    tr("每轮结束复核一次改动；继承 = 文件里不写这个键，按 pi-subagents 的默认（不做复核）。"),
  );
  fieldRow(
    watchdog,
    "watchdog.clarification",
    boolField("watchdog.clarification"),
    tr("只对主代理的看门狗生效：拿不准时可以直接问你。"),
  );
  const childModel = modelField(str("watchdog.children.model"));
  const childThinking = thinkingField(str("watchdog.children.thinking"));
  const commitWatchdogChild = (): void => {
    editor?.mark({
      "subagents.watchdog.children.model": childModel.value.trim() || null,
      "subagents.watchdog.children.thinking": childThinking.value || null,
    });
  };
  childModel.oninput = () => {
    watchModel(childModel);
    commitWatchdogChild();
  };
  childThinking.onchange = commitWatchdogChild;
  fieldRow(watchdog, "watchdog.children.model", childModel, tr("只管子代理自己的看门狗；留空 = 继承。"));
  fieldRow(watchdog, "watchdog.children.thinking", childThinking, tr("同上；留空 = 继承。"));

  const watchdogOverrides = watchdogChildrenOverrideRows(json);
  if (watchdogOverrides.length) {
    const rows = table(["agent", tr("覆盖 model"), tr("覆盖 thinking")]);
    for (const override of watchdogOverrides) {
      const line = rows.body.insertRow();
      const patchable = subagentsNamePatchable(override.agent);
      nameCell(line, override.agent, patchable ? undefined : dottedNote);
      const model = modelField(override.model, patchable);
      line.insertCell().append(model);
      const thinking = thinkingField(override.thinking, patchable);
      line.insertCell().append(thinking);
      if (!patchable) continue;
      const commit = (): void => {
        editor?.mark(watchdogChildOverridePatch(override.agent, model.value, thinking.value));
      };
      model.oninput = () => {
        watchModel(model);
        commit();
      };
      thinking.onchange = commit;
    }
    watchdog.append(rows.el);
  } else {
    watchdog.append(el("p", "subagents-hint", tr("文件里没有按 agent 的看门狗覆盖；要加一条请用「编辑 JSON」。")));
  }

  const providers = block(
    tr("按 provider 覆盖"),
    tr("这一层的优先级高于单 agent 覆盖：两边都写了，用 provider 这一份。只列文件里已经写过的条目。"),
  );
  const providerRows = providerOverrideRows(json);
  if (providerRows.length) {
    const rows = table(["provider", "agent", tr("覆盖 model"), tr("覆盖 thinking")]);
    for (const override of providerRows) {
      const line = rows.body.insertRow();
      const patchable = subagentsNamePatchable(override.provider) && subagentsNamePatchable(override.agent);
      nameCell(line, `${override.provider} / ${override.agent}`, patchable ? undefined : dottedNote);
      const model = modelField(override.model, patchable);
      line.insertCell().append(model);
      const thinking = thinkingField(override.thinking, patchable);
      line.insertCell().append(thinking);
      if (!patchable) continue;
      const commit = (): void => {
        editor?.mark(providerOverridePatch(override.provider, override.agent, model.value, thinking.value));
      };
      model.oninput = () => {
        watchModel(model);
        commit();
      };
      thinking.onchange = commit;
    }
    providers.append(rows.el);
  } else {
    providers.append(el("p", "subagents-hint", tr("文件里没有按 provider 的覆盖；要加一条请用「编辑 JSON」。")));
  }

  const machines = block(
    tr("设备"),
    page.scope === "project"
      ? tr("设备只能在全局新建：项目设置里写 Rex 主机，子代理会起不来，所以这里只读。")
      : tr("改完对新启动的子代理生效；要加一台请用「编辑 JSON」。"),
  );
  const machineList = machineRows(json);
  if (machineList.length) {
    const rows = table([tr("标签"), "rex.ssh", "cwd"]);
    for (const machine of machineList) {
      const line = rows.body.insertRow();
      nameCell(line, machine.label, machine.label === "local" ? tr("内置标签，只读") : undefined);
      const editable = machineEditable(machine.label, page.scope) && !locked;

      const ssh = el("input", "ns-input mono");
      ssh.type = "text";
      ssh.value = machine.ssh ?? "";
      ssh.placeholder = tr("ssh 目标");
      ssh.disabled = !editable;
      line.insertCell().append(ssh);

      const cwd = el("input", "ns-input mono");
      cwd.type = "text";
      cwd.value = machine.cwd ?? "";
      cwd.placeholder = "/path/to/pi-web-client";
      cwd.disabled = !editable;
      line.insertCell().append(cwd);

      const commit = (): void => {
        editor?.mark(machinePatch(machine.label, ssh.value, cwd.value));
      };
      ssh.oninput = commit;
      cwd.oninput = commit;
    }
    machines.append(rows.el);
  } else {
    machines.append(el("p", "subagents-hint", tr("文件里还没有登记过设备。")));
  }
}
