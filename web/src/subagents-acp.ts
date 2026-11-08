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
  saving: boolean;
  /** 上一次保存的失败原因；成功保存由 app 的 settings-note 播报。 */
  saveError: string | null;
  onSave(patch: AcpDelegatePatch): void;
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

  box.append(el("div", "subagents-path", tr("这个文件：{p1}", { p1: view.path })));
  box.append(
    el(
      "p",
      "subagents-hint",
      tr("acp_delegate 由 billion-context 提供，参数写在上面的文件里 —— 和上面几片的 settings.json 不是同一个文件。保存只替换里面的 pi.subagents，providers 和会话数据原样保留。"),
    ),
  );
  box.append(el("p", "subagents-hint", tr("对还没开始的会话生效：子代理启动时才注册 acp_delegate，正在跑的会话不会跟着变。")));
  if (!view.exists) box.append(el("p", "subagents-hint", tr("（还没有这个文件，保存时创建）")));

  const locked = view.error !== null;
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
    save.disabled = locked || page.saving || badDepth || badConcurrent || patchOf() === null;
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

  box.append(form, foot);
  refresh();
}

/** 空 = null（删键）；合法整数 = 数字；填了但不是 ≥ 1 的整数 = undefined（无效）。 */
function number(raw: string): number | null | undefined {
  const text = raw.trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return value >= 1 ? value : undefined;
}
