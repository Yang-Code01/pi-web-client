/**
 * 设置 → 子代理（#212）：这一片只做「看得见真实 agent」。
 *
 * 形状照 `.scratch/subagent-settings/prototype` 的样张 B：设置面板加宽到 980px，左栏锚点、右栏
 * 分区；agent 表只有 名字 / 来源 / frontmatter 的 model 与 thinking，没有任何输入框 —— 保存
 * 逻辑是下一片的事，所以这一页不该出现能点但存不下来的控件。
 *
 * 扫盘结果由 app.ts 从桥的 `subagents.agents` 拿；这里只负责画。
 */
import { createEl as el } from "./chat.ts";
import { tr } from "./i18n/index.ts";

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

export interface SubagentsPage {
  scope: "global" | "project";
  cwd: string;
  /** 当前 scope 的 settings.json；还没读到就是 null。 */
  view: { path: string; exists: boolean; error: string | null; writable: boolean } | null;
  /** 这一页打开时问的那次扫盘；null = 还在等桥回答。 */
  scan: SubagentScan | null;
  projectEnabled: boolean;
  onScope(scope: "global" | "project"): void;
  onEditJson(): void;
}

export function paintSubagentsPage(body: HTMLElement, page: SubagentsPage): void {
  const sourceLabel: Record<AgentSource, string> = {
    package: tr("包内"),
    user: tr("用户"),
    project: tr("项目"),
    scan: tr("扫描目录"),
  };
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
  edit.disabled = !page.view || !page.view.writable;
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
  placeholder("default", tr("默认"));
  placeholder("behavior", tr("行为"));

  const discovery = section("discovery");
  discovery.append(el("h3", "", tr("发现与扩展")));
  if (!scan) {
    discovery.append(el("div", "empty", tr("读取中…")));
  } else {
    discovery.append(
      el("div", "subagents-hint", tr("扫了 {p1} 个目录，共读到 {p2} 个 agent 定义（同名后者覆盖前者）。", { p1: scan.directories.length, p2: scan.directories.reduce((sum, dir) => sum + dir.count, 0) })),
    );
    if (!scan.installed) {
      discovery.append(el("div", "note", tr("这台机器上没有装 pi-subagents：包内的 agent 目录不存在。装好之后这一页会自动列出来。")));
    }
    const dirs = el("div", "subagents-dirs");
    for (const dir of scan.directories) {
      const row = el("div", `subagents-dir${dir.exists ? "" : " missing"}`);
      row.append(el("span", `subagents-badge ${dir.source}`, sourceLabel[dir.source]));
      row.append(el("span", "dp", dir.path));
      row.append(el("span", "n", dir.exists ? String(dir.count) : tr("目录不存在")));
      dirs.append(row);
    }
    if (!scan.directories.length) dirs.append(el("div", "subagents-hint", tr("一个目录都没扫到。")));
    discovery.append(dirs);
    for (const error of scan.errors) discovery.append(el("div", "note warn", error));
  }

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
      source.append(el("span", `subagents-badge ${agent.source}`, sourceLabel[agent.source]));
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
  placeholder("acp", "acp_delegate");

  body.append(wrap);
}
