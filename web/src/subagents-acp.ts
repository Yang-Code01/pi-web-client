/**
 * 设置 → 子代理 → acp_delegate 分区（#215）。
 *
 * 这一片和上面那几片的区别是**它写的不是 pi 的 settings.json**：acp_delegate 的开关与参数住在
 * billion-context 自己的配置文件里（`~/.config/billion-context/billion-context.json`，可被
 * `BILI_CONFIG_FILE` 改掉），所以它有自己的两条 RPC（`subagents.acp.get` / `.set`，桥侧在
 * `bridge/src/acpdelegate.ts`），也不吃 global / project 那套 scope。页面上把这三件事都写明白：
 * 写的是哪个文件、和上面的 settings.json 不是同一个、改动只对新会话生效。
 *
 * 文件读不懂时不显示表单控件之外的东西 —— 保存整个禁用，并给出路径和解析错误：在这种文件上
 * 写盘会把同文件里的 providers / 会话数据一起抹掉，桥侧也确实是「解析失败绝不覆盖」。
 */
import { createEl as el } from "./chat.ts";
import { tr } from "./i18n/index.ts";

/** 与 bridge/src/acpdelegate.ts 的 AcpDelegateView 一致：`null` = 这个键不在文件里，用它自己的默认。 */
export interface AcpDelegateConfig {
  enabled: boolean | null;
  maxDepth: number | null;
  maxConcurrent: number | null;
  thinkingLevel: string | null;
}

export interface AcpDelegateView {
  path: string;
  exists: boolean;
  error: string | null;
  config: AcpDelegateConfig;
  /** #375：`compress.neverPreserveRecentTools`；`null` = 没写（它的默认），`[]` = 已应用绕法。 */
  neverPreserveRecentTools: string[] | null;
}

/** 只带用户真改过的键；`null` = 删键。 */
export interface AcpDelegatePatch {
  enabled?: boolean | null;
  maxDepth?: number | null;
  maxConcurrent?: number | null;
  thinkingLevel?: string | null;
}

export interface AcpDelegateSection {
  /** 桥的 `subagents.acp` 回包；null = 还在等。 */
  view: AcpDelegateView | null;
  /** 连文件都没读到（RPC 自己失败）：给路径 + 原因，与 view.error（文件读不懂）不是一回事。 */
  loadError: { path: string; message: string } | null;
  /** 这台机器的 pi 里有没有装 billion-context（桥的 `/api/deps` 说的）；false = 整片灰掉。 */
  providerInstalled?: boolean;
  /** 装它用的参数（`npm:billion-context`）：来源在 bridge/src/deps.ts 的 OPTIONAL_PACKAGES 里，别手抄。 */
  providerSource?: string;
  saving: boolean;
  /** 上一次保存的失败原因；成功保存由 app 的 settings-note 播报。 */
  saveError: string | null;
  onSave(patch: AcpDelegatePatch): void;
  /** #375：应用（true）/ 撤销（false）billion-context 压缩拆开签名 thinking 的绕法。 */
  onThinkingFix(apply: boolean): void;
  onReload(): void;
}

/** billion-context 自己的七档，顺序就是它文档里的从省到费。 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function paintAcpDelegateSection(box: HTMLElement, page: AcpDelegateSection): void {
  box.append(el("h3", "", "acp_delegate"));
  const view = page.view;
  if (!view) {
    if (!page.loadError) {
      box.append(el("p", "subagents-hint", tr("读取中…")));
      return;
    }
    box.append(el("div", "subagents-path", tr("这个文件：{p1}", { p1: page.loadError.path })));
    box.append(el("p", "note warn", tr("没读到配置文件：{p1}", { p1: page.loadError.message })));
    const retry = el("button", "btn ghost", tr("重新读取"));
    retry.onclick = () => page.onReload();
    box.append(retry);
    return;
  }

  /** 包都不在的话，这里的开关存下去也没人读：灰掉，并说清怎么补。 */
  const off = page.providerInstalled === false;
  box.append(el("div", "subagents-path", tr("这个文件：{p1}", { p1: view.path })));
  box.append(
    el(
      "p",
      "subagents-hint",
      tr("acp_delegate 由 billion-context 提供，参数写在上面的文件里 —— 和上面几片的 settings.json 不是同一个文件。保存只替换里面的 pi.subagents，providers 和会话数据原样保留。"),
    ),
  );
  box.append(el("p", "subagents-hint", tr("对还没开始的会话生效：子代理启动时才注册 acp_delegate，正在跑的会话不会跟着变。")));
  if (off) {
    // 包不在时，这里的开关存得下、但没人读：说清楚，并把控件灰掉（下面的 refresh 会把保存也禁了）。
    box.append(el("p", "note warn", tr("这台机器上没有装 billion-context，acp_delegate 现在用不了 —— 下面的开关存了也不会生效。")));
    box.append(
      el("p", "subagents-hint", tr("装法：在终端里跑 pi install {p1}，然后重开 pi。", { p1: page.providerSource ?? "npm:billion-context" })),
    );
  }
  if (!view.exists) box.append(el("p", "subagents-hint", tr("（还没有这个文件，保存时创建）")));

  const locked = view.error !== null;
  if (!off) box.append(thinkingFixBlock(view, page, locked));
  if (view.error) {
    box.append(el("p", "note warn", tr("这个文件读不了：{p1}", { p1: view.error })));
    box.append(el("p", "subagents-hint", tr("修好 {p1} 再点「重新读取」；这里不会在读不懂的文件上写盘，那会把 providers 一起抹掉。", { p1: view.path })));
  }

  const form = el("div", "settings-form");
  const row = (label: string, control: HTMLElement, hint?: string | HTMLElement) => {
    const line = el("div", "settings-row");
    line.append(el("label", "settings-label", label), control);
    if (typeof hint === "string") line.append(el("div", "settings-hint", hint));
    else if (hint) line.append(hint);
    form.append(line);
    return line;
  };

  const enabled = el("select", "ns-input");
  enabled.append(new Option(tr("默认（开）"), ""), new Option(tr("开"), "true"), new Option(tr("关"), "false"));
  enabled.value = view.config.enabled === null ? "" : String(view.config.enabled);
  row(tr("启用 acp_delegate"), enabled, tr("acp_delegate 让一个会话把任务派给另一个 pi 会话跑；「默认」= 不在文件里写这个键，按 billion-context 的默认（开）。"));

  const depth = el("input", "ns-input");
  depth.type = "text";
  depth.inputMode = "numeric";
  depth.placeholder = tr("空 = 不限");
  depth.value = view.config.maxDepth === null ? "" : String(view.config.maxDepth);
  const depthHint = el("div", "settings-hint bad");
  depthHint.hidden = true;
  depthHint.textContent = tr("只能填 ≥ 1 的整数，或者留空表示不限。");
  row(tr("maxDepth"), depth, tr("子代理最多再往下派几层；留空 = 不写这个键。")).append(depthHint);

  const concurrent = el("input", "ns-input");
  concurrent.type = "text";
  concurrent.inputMode = "numeric";
  concurrent.placeholder = tr("空 = 不限");
  concurrent.value = view.config.maxConcurrent === null ? "" : String(view.config.maxConcurrent);
  const concurrentHint = el("div", "settings-hint bad");
  concurrentHint.hidden = true;
  concurrentHint.textContent = tr("只能填 ≥ 1 的整数，或者留空表示不限。");
  row(tr("maxConcurrent"), concurrent, tr("同时最多跑几个子代理；留空 = 不写这个键（不限）。")).append(concurrentHint);

  const thinking = el("select", "ns-input");
  thinking.append(new Option(tr("默认（不设）"), ""));
  for (const level of THINKING_LEVELS) thinking.append(new Option(level, level));
  const knownThinking = view.config.thinkingLevel === null || THINKING_LEVELS.includes(view.config.thinkingLevel);
  thinking.value = knownThinking ? (view.config.thinkingLevel ?? "") : "";
  row(
    tr("子代理的 thinkingLevel"),
    thinking,
    knownThinking
      ? tr("派出去的子代理默认用哪一档思考。")
      : tr("文件里是 {p1}（不在面板的七档里），要改请用「编辑 JSON」。", { p1: view.config.thinkingLevel ?? "" }),
  );

  for (const control of [enabled, depth, concurrent, thinking]) control.disabled = locked;
  // 陌生档位不给下拉：七个选项里没有它的值，选任何一项都只会生成一个不是用户本意的键。
  thinking.disabled = locked || !knownThinking;

  const foot = el("div", "settings-foot");
  const save = el("button", "btn primary", tr("保存"));

  const patchOf = (): AcpDelegatePatch | null => {
    const patch: AcpDelegatePatch = {};
    const nextDepth = number(depth.value);
    const nextConcurrent = number(concurrent.value);
    if (nextDepth === undefined || nextConcurrent === undefined) return null;
    const nextEnabled = enabled.value === "" ? null : enabled.value === "true";
    if (nextEnabled !== view.config.enabled) patch.enabled = nextEnabled;
    if (nextDepth !== view.config.maxDepth) patch.maxDepth = nextDepth;
    if (nextConcurrent !== view.config.maxConcurrent) patch.maxConcurrent = nextConcurrent;
    if (knownThinking) {
      const nextThinking = thinking.value === "" ? null : thinking.value;
      if (nextThinking !== view.config.thinkingLevel) patch.thinkingLevel = nextThinking;
    }
    return Object.keys(patch).length ? patch : null;
  };

  const refresh = () => {
    const badDepth = number(depth.value) === undefined;
    const badConcurrent = number(concurrent.value) === undefined;
    for (const [control, hint, bad] of [
      [depth, depthHint, badDepth],
      [concurrent, concurrentHint, badConcurrent],
    ] as const) {
      control.classList.toggle("bad", bad);
      hint.hidden = !bad;
    }
    // 没改动也禁用：保存发的是 patch，空 patch 桥侧什么也不写，不如让用户看得见「没事可做」。
    save.disabled = locked || off || page.saving || badDepth || badConcurrent || patchOf() === null;
  };

  depth.oninput = refresh;
  concurrent.oninput = refresh;
  enabled.onchange = refresh;
  thinking.onchange = refresh;

  save.onclick = () => {
    const patch = patchOf();
    if (patch && !locked) page.onSave(patch);
  };
  const reload = el("button", "btn ghost", tr("重新读取"));
  reload.disabled = page.saving;
  reload.onclick = () => page.onReload();
  foot.append(save, reload);
  if (page.saving) foot.append(el("span", "subagents-hint", tr("保存中…")));
  if (page.saveError) foot.append(el("span", "settings-hint bad", tr("没存上：{p1}", { p1: page.saveError })));
  if (locked) foot.append(el("span", "subagents-hint", tr("这个文件读不懂，保存不可用。")));

  // 包不在就一个控件都不留活的：改了一半发现存不了比不让改更气人。
  if (off) {
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input,select,textarea")) control.disabled = true;
  }
  box.append(form, foot);
  refresh();
}

/**
 * #375：billion-context ≤ 0.1.213 的已知问题。它的压缩会把同一条回复里的签名 thinking 和工具调用拆开，
 * Claude 5.x 之后整个会话永久回 400。绕法是同一份文件里的 `compress.neverPreserveRecentTools: []`。
 * 上游修好（ranxianglei/billion-context#4885）之前一直显示。
 */
function thinkingFixBlock(view: AcpDelegateView, page: AcpDelegateSection, locked: boolean): HTMLElement {
  const box = el("div", "acp-known-issue");
  box.append(el("h4", "", tr("已知问题：Claude 5.x 压缩后永久 400")));
  box.append(
    el(
      "p",
      "subagents-hint",
      tr("用 Claude 5.x（Opus / Sonnet 5.5、Fable、Mythos）时，billion-context 的一次压缩可能把同一条回复里的思考块和工具调用拆开，之后这个会话每次都报「thinking blocks … cannot be modified」，只能换模型。下面的绕法把 compress.neverPreserveRecentTools 设为 []：压缩不再挖进最近保护区，代价是刚读的 bash / read 结果要晚几轮才能被压缩。已经报错的会话修不回来，换模型或开新会话。"),
    ),
  );
  const link = el("a", "", "billion-context#4885");
  link.href = "https://github.com/ranxianglei/billion-context/issues/4885";
  link.target = "_blank";
  link.rel = "noopener";
  const upstream = el("p", "subagents-hint", tr("上游问题："));
  upstream.append(link);
  box.append(upstream);

  const value = view.neverPreserveRecentTools;
  const applied = value !== null && value.length === 0;
  const status =
    value === null
      ? tr("现在：未应用（用 billion-context 的默认）")
      : applied
        ? tr("现在：已应用")
        : tr("现在：文件里自定义为 {p1}，点「应用」会改成 []", { p1: JSON.stringify(value) });
  box.append(el("p", applied ? "subagents-hint" : "note warn", status));

  const button = el("button", applied ? "btn ghost" : "btn primary", applied ? tr("撤销绕法") : tr("应用绕法"));
  button.dataset.action = applied ? "thinking-fix-undo" : "thinking-fix-apply";
  button.disabled = locked || page.saving;
  button.onclick = () => page.onThinkingFix(!applied);
  box.append(button);
  return box;
}

/** 空 = null（删键）；合法整数 = 数字；填了但不是 ≥ 1 的整数 = undefined（无效）。 */
function number(raw: string): number | null | undefined {
  const text = raw.trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return value >= 1 ? value : undefined;
}
