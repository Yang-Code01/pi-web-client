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
 * 「默认 / 行为 / 发现与扩展」三节一起画，三节共用一个 patch。
 *
 * 只写用户真的改过的键：值回到磁盘上原来那个就把它从 patch 里摘掉。空文本、空列表、「继承」
 * 一律是 `null`，桥侧 `applyPatch` 把它当删键。三种情况下控件与保存都不可用：文件读不了
 * （`view.error`）、项目没被信任、还没读到文件（只在外面画「读取中…」）。
 */
export function paintSubagentsBasics(host: SubagentsBasicsHost, page: SubagentsPage): void {
  const view = page.view;
  if (!view) {
    for (const box of [host.defaults, host.behavior, host.discovery]) box.append(el("div", "empty", tr("读取中…")));
    return;
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

  if (!scan) return;
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
  const projectName = page.cwd.split(/[\\/]/).filter(Boolean).pop() ?? page.cwd;
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
      anchors.get(section.id)?.scrollIntoView({ block: "start" });
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

  const placeholder = (id: string, label: string) => {
    const box = section(id);
    box.append(el("h3", "", label));
    box.append(el("p", "subagents-hint", tr("占位：这一片只做只读清单，编辑在下一片。")));
  };

  const footer = el("div", "subagents-foot");
  paintSubagentsBasics(
    { defaults: section("default"), behavior: section("behavior"), discovery: section("discovery"), footer },
    page,
  );
  wrap.append(footer);

  const agentsBox = section("agents");
  agentsBox.append(el("h3", "", tr("每个子代理")));
  if (!scan) {
    agentsBox.append(el("div", "empty", tr("读取中…")));
  } else if (!scan.agents.length) {
    agentsBox.append(
      el(
        "div",
        "subagents-hint",
        scan.installed ? tr("扫描目录里没找到 agent 定义。") : tr("没有可列的 agent —— 先装 pi-subagents，或者往上面的目录里放 .md。"),
      ),
    );
  } else {
    const table = document.createElement("table");
    table.className = "subagents-agents";
    const head = table.createTHead().insertRow();
    for (const label of ["agent", tr("来源"), tr("模型"), tr("思考")]) {
      head.append(el("th", "", label));
    }
    const tbody = table.createTBody();
    const agents = [...scan.agents].sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of agents) {
      const row = tbody.insertRow();
      row.title = agent.path;
      const name = row.insertCell();
      name.className = "agent";
      name.textContent = agent.name;
      const source = row.insertCell();
      source.append(el("span", `subagents-badge ${agent.source}`, sourceLabelOf(agent.source)));
      const model = row.insertCell();
      model.className = agent.model ? "fm" : "fm unset";
      model.textContent = agent.model ?? tr("未钉");
      const thinking = row.insertCell();
      thinking.className = agent.thinking ? "fm" : "fm unset";
      thinking.textContent = agent.thinking ?? tr("未钉");
    }
    agentsBox.append(table);
  }

  placeholder("advanced", tr("高级"));
  paintAcpDelegateSection(section("acp"), page.acp);

  body.append(wrap);
}
