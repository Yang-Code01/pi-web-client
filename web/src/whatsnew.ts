/**
 * #588 D358：老用户某天第一次启动时，把「本项目更新日志」的新批次弹一次。
 *
 * 分工是刻意的：
 * - **该不该弹、弹哪一批、还有几批没看**都在桥端算（`bridge/src/whatsnew.ts` 的纯函数 + 24 小时闸），
 *   页面只消费结论。已读也在桥的状态目录里，所以手机和电脑看到的是同一份「已读」。
 * - 页面只负责**找时机**：没有正在跑的回合、输入框空着、页面在前台才弹；最多等 10 分钟，排不上
 *   队就放弃，等下一次判定机会（下次启动、或满一天后的下一次连接）。
 * - 「领取」在桥端是一次性的（同一进程只发给一个页面），所以这里不用自己防重复弹；但页面仍要
 *   防「已经开着一个」的重复调用。
 *
 * 已读在 dialog 打开的那一刻就写（D358）：这个功能的目的是**知道**，不是**确认**。所以不存在
 * 「必须点知道了才不算没看过」那套纠缠。
 */
import { createEl as el } from "./chat.ts";
import { icon } from "./icons.ts";
import { tr } from "./i18n/index.ts";
import { renderBatch, type LogBatch, type SelfLog } from "./changelog.ts";
import { renderMarkdown } from "./md.ts";
import { markSurface, mountOverlay, retireOverlay, trapEscape } from "./modal.ts";
import "./whatsnew.css";

export interface WhatsnewBatch {
  title: string;
  body: string;
}

/** 桥 `/api/changelog?scope=self&unread=1` 的答复；除了 ok 之外都表示「这次不弹」。 */
export interface WhatsnewClaim {
  status: "ok" | "none" | "no-new" | "throttled" | "disabled" | "taken";
  batch?: WhatsnewBatch;
  older?: WhatsnewBatch[];
  /** 检出根：正文里的相对链接（`docs/DECISIONS.md`）按它解析。 */
  root?: string;
  /** 桥解析好的整份日志：能按 `batch.title` 找到就画成带 chip 的条目，找不到就退回 markdown。 */
  log?: SelfLog;
  repo?: { owner: string; name: string } | null;
}

/** 排不上队就放弃的时限（D358）。从桥派发起算，不是从页面打开算。 */
export const WHATSNEW_WAIT_MS = 10 * 60_000;

export interface WhatsnewQueueOptions {
  /** 现在能不能弹：没有正在跑的回合、输入框空着、页面在前台。 */
  canShow: () => boolean;
  /** 底部「看全部日志」：打开 设置 → 更新日志。 */
  onOpenAll: () => void;
  /** 正文里相对路径的落点（设置页同一个用法：D195）。 */
  openPath: (file: string, root: string) => void;
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
}

/**
 * 问桥要一次「还没看的那一批」，然后等一个合适的时机弹出来。
 * 旧桥 / 没登录 / 没有 CHANGELOG 都只是安静地不弹 —— 这个提示不该有自己的错误提示条。
 */
export function queueWhatsnew(opts: WhatsnewQueueOptions): void {
  const now = opts.now ?? (() => Date.now());
  const pollMs = opts.pollMs ?? 1000;
  fetch("/api/changelog?scope=self&unread=1", { credentials: "same-origin" })
    .then((res) => (res.ok ? (res.json() as Promise<WhatsnewClaim>) : null))
    .then((claim) => {
      if (!claim || claim.status !== "ok" || !claim.batch) return;
      const deadline = now() + (opts.waitMs ?? WHATSNEW_WAIT_MS);
      const tick = (): void => {
        if (opts.canShow()) {
          openWhatsnew({
            batch: claim.batch!,
            older: claim.older ?? [],
            root: claim.root ?? "",
            log: claim.log,
            repo: claim.repo ?? null,
            onOpenAll: opts.onOpenAll,
            openPath: opts.openPath,
          });
          return;
        }
        // 排不上队就放弃：已读没动、闸也没推进，下次判定机会还能看到同一批。
        if (now() >= deadline) return;
        window.setTimeout(tick, pollMs);
      };
      // 第一个 tick 也推迟一轮：页面刚起来时还在铺会话与草稿，这一瞬间的「空闲」不可信。
      window.setTimeout(tick, pollMs);
    })
    .catch(() => {
      /* 桥不在 / 旧桥没有这个接口：什么都不做 */
    });
}

export interface WhatsnewDialogOptions {
  batch: WhatsnewBatch;
  older: WhatsnewBatch[];
  root: string;
  /** 桥解析好的日志与仓库：有这两样就画成时间线里那种条目（日期、图标、引用 chip）。 */
  log?: SelfLog;
  repo?: { owner: string; name: string } | null;
  onOpenAll: () => void;
  openPath: (file: string, root: string) => void;
}

/** 画出来并立即记已读。同一时刻只允许一个（重复调用直接忽略）。 */
export function openWhatsnew(opts: WhatsnewDialogOptions): void {
  if (document.querySelector(".whatsnew-back")) return;
  // 打开即已读（D358）。失败也无所谓：下次判定还看得见，只是可能要重看一遍。
  void fetch("/api/changelog/seen", { method: "POST", credentials: "same-origin" }).catch(() => {});

  const back = markSurface(el("div", "sheet-back center whatsnew-back"), "window");
  const sheet = el("section", "sheet whatsnew-sheet");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", tr("本服务更新了什么"));

  let untrap: (() => void) | null = null;
  const close = (): void => {
    untrap?.();
    untrap = null;
    retireOverlay(back);
  };

  const head = el("header", "sheet-head whatsnew-head");
  head.append(el("div", "sheet-title", tr("本服务更新了什么")));
  const x = el("button", "btn ghost") as HTMLButtonElement;
    x.append(icon("close", { size: 13 }));
  x.type = "button";
  x.title = tr("关闭");
  x.setAttribute("aria-label", tr("关闭"));
  x.onclick = close;
  head.append(x);

  const body = el("div", "whatsnew-body");
  body.append(el("div", "whatsnew-eyebrow", tr("这个检出里的更新日志")));
  /**
   * 两套画法共用同一个位置：桥给了 `log` 且标题对得上，就用设置页那套条目（日期 + 图标 + 引用
   * chip）—— 两处长得一样；对不上（旧桥、日志刚被改写）就退回原来的 markdown。
   *
   * 对不上的根：弹窗那边的标题是 `## ` 那一行的原文（`2026-11-24 · 主题`），而解析结果把日期拆进了
   * `date`。这里把日期拼回去再比，两边都不用改成「显示用的标题」。
   */
  // i18n-ignore-start 这里是拿来和 markdown 原文比对的字，不是界面文案：桥端标题就是 `## ` 那行
  // 的原文，中文、不随界面语言变。
  const headerOf = (b: LogBatch): string =>
    b.unpublished ? (b.title ? `未发布 · ${b.title}` : "未发布") : `${b.date} · ${b.title}`;
  // i18n-ignore-end
  const structured = (title: string): LogBatch | undefined =>
    opts.log?.batches.find((b) => headerOf(b) === title);
  const paint = (batch: WhatsnewBatch, small = false): HTMLElement => {
    const hit = structured(batch.title);
    if (hit) {
      // 两种画法的外层类名不同：`.whatsnew-md` 那套 h3 / p 排字是给 markdown 的，套到
      // 结构化条目上会把主题行压成小灰字。
      const host = el("div", "whatsnew-log");
      host.append(
        renderBatch(hit, {
          repo: opts.repo ?? null,
          // `D365` 只开文件：预览没有行锚点，跳不到那一行。
          onOpenDecision: () => opts.openPath("docs/DECISIONS.md", opts.root),
        }),
      );
      return host;
    }
    const host = el("div", "whatsnew-md settings-changelog");
    // 退回 markdown 时主题行得自己补：结构化那套的 `h3` 是 `renderBatch` 画的，markdown 那套
    // 只有正文（旧桥 / 标题对不上时，不补这行弹窗就只剩一坨没有标题的条目）。
    if (batch.title) host.append(el("div", small ? "whatsnew-title whatsnew-title--small" : "whatsnew-title", batch.title));
    host.append(renderMarkdown(batch.body || tr("（这一批没有正文）"), { openPath: (file) => opts.openPath(file, opts.root) }));
    return host;
  };
  body.append(paint(opts.batch));

  if (opts.older.length) {
    const more = el("details", "whatsnew-older") as HTMLDetailsElement;
    more.append(el("summary", "", tr("还有 {p1} 批更早的", { p1: String(opts.older.length) })));
    for (const batch of opts.older) {
      const one = el("div", "whatsnew-older__one");
      // 标题由 `paint` 自己补（结构化那批不需要：`renderBatch` 自带主题行）。
      one.append(paint(batch, true));
      more.append(one);
    }
    body.append(more);
  }

  const foot = el("footer", "whatsnew-foot");
  const all = el("button", "btn ghost", tr("看全部日志")) as HTMLButtonElement;
  all.type = "button";
  all.onclick = () => {
    close();
    opts.onOpenAll();
  };
  const ok = el("button", "btn primary", tr("知道了")) as HTMLButtonElement;
  ok.type = "button";
  ok.onclick = close;
  foot.append(all, ok);

  sheet.append(head, body, foot);
  back.append(sheet);

  untrap = trapEscape(close);
  mountOverlay(back);
  ok.focus();
}
