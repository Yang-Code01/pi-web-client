/**
 * 「交给 agent」的去处选择（#651）：插进当前会话，还是新开一个。
 *
 * 为什么要选：一份评审可能来自好几个 PR，全塞进同一个会话会把上下文搅在一起
 * （用户原话：「存在用户评审过多个 pr 的情况，每次交给同一个会话会出现上下文干扰」）。
 * 新开会话时名字默认就是 PR 的 tag（`#636`），省得自己想。
 */
import { attachWindowGeom } from "./dialoggeom.ts";
import { createEl as el } from "./chat.ts";
import { tr } from "./i18n/index.ts";
import { markSurface, pushEscLayer, overlayHost } from "./modal.ts";

export type HandoffTarget = "current" | "new";

export interface HandoffOptions {
  /** 要交给 agent 的正文（已经在外面拼好了）。 */
  text: string;
  /** 新开会话时预填的名字。 */
  name: string;
  onPick: (target: HandoffTarget, text: string, name: string) => void;
}

export class HandoffSheet {
  private readonly back: HTMLElement;
  private readonly opts: HandoffOptions;
  private popEsc: (() => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(opts: HandoffOptions) {
    this.opts = opts;
    this.back = markSurface(el("div", "sheet-back center rv-back"), "window");

    const sheet = el("section", "st-console handoff-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", tr("交给 agent"));
    sheet.tabIndex = -1;

    const head = el("header", "rv-sheet-head");
    const headMain = el("div", "rv-sheet-headmain");
    headMain.append(el("h2", "rv-sheet-title", tr("交给 agent")));
    headMain.append(el("div", "rv-sheet-meta", tr("这段意见放哪儿：当前会话，还是新开一个")));
    const close = el("button", "btn ghost", tr("取消")) as HTMLButtonElement;
    close.type = "button";
    close.onclick = () => this.close();
    head.append(headMain, close);

    const body = el("div", "handoff-body");
    // 整段给出去，不截断：这里要是只放前 N 个字，长一份评审里「第二条之后」就全看不见了
    // （2026-11-27 用户就是这么收到半句的）。高度由 `.handoff-preview` 自己封顶并滚动。
    const preview = el("pre", "handoff-preview", opts.text);

    const actions = el("div", "handoff-actions");
    const current = el("button", "btn primary", tr("插到当前会话")) as HTMLButtonElement;
    current.type = "button";
    current.onclick = () => this.pick("current");
    const fresh = el("button", "btn", tr("新开会话")) as HTMLButtonElement;
    fresh.type = "button";
    fresh.onclick = () => this.pick("new");
    actions.append(current, fresh);
    body.append(preview, actions, el("div", "rv-hint", tr("新开会话的名字：{p1}", { p1: opts.name })));

    sheet.append(head, body);
    this.back.append(sheet);
    attachWindowGeom("handoff", { back: this.back, panel: sheet, min: [520, 380] });
  }

  /** 宿主默认交给 `overlayHost()`：控制台自带 `--st-zoom`（D457），挂 body 而不进 `#app`（D450）；测试里仍可显式指定。 */
  mount(parent: HTMLElement = overlayHost(this.back)): void {
    parent.append(this.back);
    this.popEsc = pushEscLayer({ el: this.back, onEsc: () => this.close() });
  }

  close(): void {
    this.popEsc?.();
    this.popEsc = null;
    this.back.remove();
    this.onClose?.();
  }

  private pick(target: HandoffTarget): void {
    const { text, name, onPick } = this.opts;
    this.close();
    onPick(target, text, name);
  }
}
