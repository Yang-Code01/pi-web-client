/**
 * 「这封信发不发？」—— AI 调 `mail_send` / `mail_reply` 时，桥把 `{type:"mail.confirm"}` 投给
 * 正在看这个会话的页签，这里把收件人、主题、正文前 800 字摊开，等用户点。
 *
 * 为什么单独一份而不是塞进 MailPanel：确认框必须在**没开邮箱面板**的时候也能弹（人在聊天，
 * AI 顺手发信）。以前整个 web 里根本没有处理 `mail.confirm` 的地方 —— 桥发出去没人接，等满
 * 5 分钟回 `no-ack`，AI 表现成「发不出去」且不知道原因（D264）。
 *
 * 两条规矩：
 *   1. 只有「点了发送」才回 `ok:true`。Esc / 关闭 / 点遮罩 / 超时 都回 `ok:false` + 一句给人看的 `text`。
 *   2. 排队与回执在 `MailConfirmQueue`（`mail-shared.ts`，无 DOM、可单测）；这里只管画和听键盘。
 */
import { createEl as el } from "./chat.ts";
import { tr } from "./i18n/index.ts";
import { MAIL_CONFIRM_PAGE_MS, MailConfirmQueue, type MailConfirmAck, type MailConfirmRequest } from "./mail-shared.ts";
import { markSurface, mountOverlay, retireOverlay, trapEscape } from "./modal.ts";
import "./mail-console.css";

export interface MailConfirmHost {
  send(ack: MailConfirmAck): void;
}

export class MailConfirmDialog {
  private readonly queue: MailConfirmQueue;
  private root: HTMLElement | null = null;
  private timer = 0;
  private lastFocus: HTMLElement | null = null;
  private untrap: (() => void) | null = null;

  constructor(host: MailConfirmHost) {
    this.queue = new MailConfirmQueue(
      (ack) => host.send(ack),
      () => this.sync(),
    );
  }

  /** 桥投来一条确认请求。已经在问别的就排队，按到达顺序一封一封来。 */
  ask(reqId: string, mail: MailConfirmRequest): void {
    this.queue.push(reqId, mail);
  }

  /** 正在问的那封（测试与「面板关掉时」用得上）。 */
  get asking(): { reqId: string; mail: MailConfirmRequest } | null {
    return this.queue.current;
  }

  /** 队列变了就重画：有当前那封就摊开，没有就收摊。 */
  private sync(): void {
    if (this.queue.current) this.paint();
    else this.teardown();
  }

  private answer(ok: boolean, reason?: string, text?: string): void {
    if (!this.queue.current) return;
    // `settle()` 会回调 `onChange` → `sync()`，下一封（或收摊）在那里发生。
    this.queue.settle(ok, reason, text);
  }

  private teardown(): void {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = 0;
    this.untrap?.();
    this.untrap = null;
    retireOverlay(this.root);
    this.root = null;
    const back = this.lastFocus;
    this.lastFocus = null;
    back?.focus();
  }

  private paint(): void {
    const cur = this.queue.current;
    if (!cur) return;
    const m = cur.mail;
    if (!this.root) this.lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const back = markSurface(el("div", "mc-back mc-back--confirm"), "window");
    back.addEventListener("mousedown", (ev) => {
      // 点遮罩 = 不发。别让它在键盘外悄悄消失，人得知道自己拒了这封。
      if (ev.target === back) this.answer(false, "declined", tr("你在确认框外面点了，这封信没有发。"));
    });
    const box = el("section", "mc-confirm");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", tr("AI 要发一封信"));

    const head = el("header", "mc-confirm__head");
    head.append(el("div", "mc-eyebrow", tr("AI 要发一封信")));
    head.append(el("h2", "mc-title", tr("这封邮件发不发？")));
    head.append(el("div", "mc-sub", tr("最多等你 5 分钟；不点就不发，AI 那边会收到「没有确认」。")));

    const body = el("div", "mc-confirm__body");
    const meta = el("div", "mc-letter__meta");
    const line = (label: string, value: string) => {
      if (!value) return;
      meta.append(el("span", "", tr("{label}：{value}", { label, value })));
    };
    line(tr("账号"), `${m.account} · ${m.from}`);
    line(tr("收件人"), (m.to ?? []).join(", "));
    line(tr("抄送"), (m.cc ?? []).join(", "));
    line(tr("主题"), m.subject);
    line(tr("附件"), (m.attachments ?? []).join(", "));
    body.append(meta);
    body.append(el("pre", "mc-letter__text", m.text || tr("（正文是空的，或者只有 HTML）")));
    if (this.queue.size > 1) {
      body.append(el("div", "mc-hint", tr("后面还有 {n} 封在排队。", { n: String(this.queue.size - 1) })));
    }

    const foot = el("footer", "mc-confirm__foot");
    foot.append(el("span", "mc-foot__hint", tr("只有点「发送」才真的发出去。")));
    const no = el("button", "mc-btn", tr("不发")) as HTMLButtonElement;
    no.type = "button";
    no.onclick = () => this.answer(false, "declined", tr("你选了不发，这封信没有发出去。"));
    const yes = el("button", "mc-btn mc-btn--primary", tr("发送")) as HTMLButtonElement;
    yes.type = "button";
    yes.onclick = () => this.answer(true);
    foot.append(no, yes);

    box.append(head, body, foot);
    back.append(box);

    // Esc = 不发（和「关闭面板」是两回事：这里不能装作点了发送）。
    this.untrap?.();
    this.untrap = trapEscape(() => this.answer(false, "declined", tr("你按了 Esc，这封信没有发出去。")));

    retireOverlay(this.root);
    this.root = back;
    // 挂进 #app（跟「本机管理」同一个挂法）：浮层跟着外观「字号」一起缩放（D123 / D263）。
    mountOverlay(back);
    yes.focus();

    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.answer(false, "confirm-timeout", tr("放了 5 分钟没点确认，这封信没有发出去。"));
    }, MAIL_CONFIRM_PAGE_MS);
  }
}
