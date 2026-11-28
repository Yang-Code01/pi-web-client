/**
 * PROTOTYPE —— 「拖字号滑杆时看得见效果」的四种候选。`?variant=A|B|C|D|T`
 *
 *   A 预览卡     面板里放一块迷你整页，拖动任意滑杆它就跟着缩放（结构最保守）
 *   B 让开       按住任意一根字号轨道，面板淡成一层薄影，真页面自己演示；松手复原
 *   C 非模态抽屉 整个设置面板改成右侧窄抽屉，真页面一直看得见（还能点）
 *   D ＝ A + 一颗「按住看真页面」
 *   T 现状       面板跟着字号一起缩放，没有任何预览
 *
 * A/B/C/D 都先落地了已经定下的那一条：设置面板不再跟着「字号」缩放（挂到 body 上）。
 *
 * 这是原型：看完就整支删掉，别合进 main，别在它上面写测试。
 */

const KEYS = ["A", "B", "C", "D", "T"] as const;
type Key = (typeof KEYS)[number];

const LABELS: Record<Key, string> = {
  A: "预览卡",
  B: "让开",
  C: "非模态抽屉",
  D: "预览卡 + 看真页面",
  T: "现状",
};

const HELP: Record<Key, string> = {
  A: "下面多一块迷你整页：六根滑杆任意一根，都在这块小样上当场缩放。",
  B: "按住任意一根字号轨道（或拖动），设置面板淡成一层薄影，露出真页面；松手就回来。",
  C: "设置面板变成右侧窄抽屉，不再遮住真页面 —— 左边那半还能直接点。",
  D: "迷你整页 + 预览卡头上那颗「按住看真页面」：平时看小样，较真时按住看真的。",
  T: "今天的样子：没有预览，而且面板自己跟着字号一起放大。",
};

function key(): Key | null {
  const v = (new URLSearchParams(location.search).get("variant") ?? "").toUpperCase();
  return (KEYS as readonly string[]).includes(v) ? (v as Key) : null;
}

function mk(tag: string, cls = "", text = ""): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

/** 迷你整页：一块 CSS 画的壳，五块区域各挂 `zoom`，全局倍率乘在最外层。 */
function mockShell(): HTMLElement {
  const stage = mk("div", "pm-stage");
  const page = mk("div", "pm-page");

  const top = mk("div", "pm-top");
  top.style.zoom = "var(--rs-topbar, 1)";
  for (const [cls, text] of [
    ["pm-dot", ""],
    ["pm-title", "分区字号"],
    ["pm-pill", "产物"],
    ["pm-pill", "终端"],
    ["pm-pill", "内网通"],
  ] as [string, string][]) {
    top.append(mk("span", cls, text));
  }

  const mid = mk("div", "pm-mid");

  const side = mk("div", "pm-side");
  side.style.zoom = "var(--rs-sessions, 1)";
  const cards: [string, string, boolean][] = [
    ["字号可以分块调", "刚把正文拖到 130%", true],
    ["别的会话", "做完的会话沉下去", false],
    ["通栏与行数", "左栏这一列会变早换行", false],
  ];
  for (const [title, line, on] of cards) {
    const card = mk("div", `pm-card${on ? " on" : ""}`);
    card.append(mk("b", "", title), mk("span", "", line));
    side.append(card);
  }

  const chat = mk("div", "pm-chat");
  chat.style.zoom = "var(--rs-chat, 1)";
  const bubble = (who: "user" | "ai", line: string): HTMLElement => {
    const node = mk("div", `pm-msg ${who}`);
    node.append(mk("span", "", line));
    return node;
  };
  chat.append(
    bubble("user", "正文放大到 130% 之后，一行还能放多少字？"),
    bubble("ai", "这一块是「对话正文」的小样：它自己再乘一层倍率，换行会更早一点。"),
    bubble("user", "那左栏呢？"),
    bubble("ai", "左栏同一句话会更早换行 —— 盒子不变，装得下的字变少。"),
  );

  const queue = mk("div", "pm-queue");
  queue.style.zoom = "var(--rs-queue, 1)";
  queue.append(mk("div", "pm-qrow", "执行 · 2 步"), mk("div", "pm-qrow", "计划 · 4 项"), mk("div", "pm-qrow", "改动 · 3 文件"));

  mid.append(side, chat, queue);

  const composer = mk("div", "pm-composer");
  composer.style.zoom = "var(--rs-composer, 1)";
  composer.append(mk("span", "pm-input", "说点什么…"), mk("span", "pm-send", "↑"));

  page.append(top, mid, composer);
  stage.append(page);
  return stage;
}

function previewCard(withPeekButton: boolean, peek: (on: boolean) => void): HTMLElement {
  const card = mk("div", "proto-card");
  const head = mk("div", "proto-card__head");
  head.append(mk("span", "proto-card__label", "预览 · 迷你整页，跟着你的倍率走"));
  if (withPeekButton) {
    const btn = mk("button", "proto-peekbtn", "按住看真页面") as HTMLButtonElement;
    btn.type = "button";
    btn.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      btn.setPointerCapture(ev.pointerId);
      peek(true);
    });
    const off = (): void => peek(false);
    btn.addEventListener("pointerup", off);
    btn.addEventListener("pointercancel", off);
    head.append(btn);
  }
  card.append(head, mockShell());
  card.append(mk("div", "proto-card__foot", "拖动上面任意一根：迷你整页里对应的那一块会当场变，轨道本身不动。"));
  return card;
}

/** 上一次挂的键盘监听：切候选会整块重建，旧的得先摘掉。 */
let unhookKeys: (() => void) | null = null;

/**
 * 挂到刚建好的设置面板上。`reopen` 用于切换候选时重开面板（原型里最省事的重画办法）。
 */
export function protoMount(back: HTMLElement, reopen: () => void): void {
  const k = key();
  if (!k) return; // 没带 ?variant=：和今天一模一样

  unhookKeys?.();
  unhookKeys = null;

  // 已经定下的一条：设置面板不跟着「字号」缩放 —— 挂到 body 上，面板里的长度就是视觉 px。
  if (k !== "T") {
    document.body.append(back);
    back.classList.add("proto-noscale");
  }

  /** B / D 的「让开」：面板淡成薄影，真页面露出来。 */
  const hud = mk("div", "proto-hud");
  back.append(hud);
  const hudText = (row: HTMLElement): string => {
    const label = (row.querySelector(".settings-label")?.firstChild?.textContent ?? "").trim();
    const read = (row.querySelector(".size-read")?.textContent ?? "").trim();
    return `${label}${label && read ? " · " : ""}${read}`;
  };
  const peek = (on: boolean, row: HTMLElement | null = null): void => {
    back.classList.toggle("proto-peek", on);
    if (on) hud.textContent = row ? hudText(row) : "按住中 · 真页面";
  };

  // B：按住任意一根轨道就露出真页面；D：只有预览卡头上那颗按钮负责让开。
  if (k === "B") {
    for (const rail of back.querySelectorAll<HTMLElement>(".size-rail")) {
      const row = rail.closest<HTMLElement>(".settings-row");
      if (!row) continue;
      let held = false;
      let frame = 0;
      rail.addEventListener(
        "pointerdown",
        () => {
          held = true;
          peek(true, row);
        },
        true,
      );
      rail.addEventListener(
        "pointermove",
        () => {
          if (!held || frame) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            hud.textContent = hudText(row);
          });
        },
        true,
      );
      const end = (): void => {
        if (!held) return;
        held = false;
        peek(false);
      };
      rail.addEventListener("pointerup", end, true);
      rail.addEventListener("pointercancel", end, true);
    }
  }

  if (k === "A" || k === "D") {
    // 挂 `.set-sub` 上而不是 `.settings-panel` 里：后者 overflow:hidden，sticky 会失效
    // （六根滑杆排下来比面板高，滚到分区那几根时预览必须还在）。
    const host = back.querySelector<HTMLElement>('[data-sec="lang"]');
    host?.prepend(previewCard(k === "D", (on) => peek(on)));
  }

  if (k === "C") back.classList.add("proto-drawer");

  // ---- 底部那颗原型切换条（原型专用，谁也别照抄）
  const bar = mk("div", "proto-bar");
  const prev = mk("button", "proto-bar__arrow", "←") as HTMLButtonElement;
  const next = mk("button", "proto-bar__arrow", "→") as HTMLButtonElement;
  const text = mk("span", "proto-bar__text");
  text.append(mk("span", "proto-bar__label", `${k} · ${LABELS[k]}`), mk("span", "proto-bar__hint", HELP[k]));
  const go = (step: number): void => {
    const i = KEYS.indexOf(k);
    const to = KEYS[(i + step + KEYS.length) % KEYS.length];
    const url = new URL(location.href);
    url.searchParams.set("variant", to);
    history.replaceState(null, "", url);
    reopen();
  };
  prev.type = "button";
  next.type = "button";
  prev.onclick = () => go(-1);
  next.onclick = () => go(1);
  prev.title = "上一个候选（←）";
  next.title = "下一个候选（→）";
  bar.append(prev, text, next);
  back.append(bar);

  // 键盘：焦点在输入控件里时不抢方向键（轨道自己要用）。
  const onKey = (ev: KeyboardEvent): void => {
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (ev.key === "ArrowLeft") go(-1);
    else if (ev.key === "ArrowRight") go(1);
  };
  window.addEventListener("keydown", onKey, true);
  unhookKeys = () => window.removeEventListener("keydown", onKey, true);
}
