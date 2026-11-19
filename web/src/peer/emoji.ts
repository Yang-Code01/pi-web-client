import { tr } from "../i18n/index.ts";

/**
 * 表情面板（内网通输入区左下角的 😊）：两页 ——
 * - 「表情」：Unicode emoji，按类分组 + 最近用过（localStorage，最多 24 个）；点一下插进输入框。
 * - 「我的表情」：本机收藏的图片表情（`/api/peer/stickers`），点一下直接作为图片发出。
 *
 * 面板只管画与回调，网络和发送都交给调用方（`main.ts`），这里不碰 peer 的状态。
 */

/** 类名在使用处才 `tr`（i18n 规矩：模块级常量只放中文原文）。 */
const GROUPS: { name: string; icon: string; list: string }[] = [
  {
    name: "笑脸",
    icon: "😀",
    list: "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 💀 💩 🤡 👻 👽 🤖",
  },
  {
    name: "手势",
    icon: "👍",
    list: "👍 👎 👌 🤌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💪 🫡 🫶 👀 🧠 🙇 🤷 🤦 🙋 🙆 🙅 💁",
  },
  {
    name: "心情",
    icon: "❤️",
    list: "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨 💤 🔥 ✨ 🌟 ⭐ 🎉 🎊 🎈 🎁 🏆 🥇",
  },
  {
    name: "动物",
    icon: "🐱",
    list: "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦉 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐢 🐍 🐙 🦀 🐠 🐬 🐳 🦈 🐊",
  },
  {
    name: "食物",
    icon: "🍜",
    list: "🍎 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🥭 🍍 🥝 🍅 🥑 🌽 🥕 🍞 🧀 🍳 🥓 🍔 🍟 🍕 🌭 🥪 🌮 🍜 🍝 🍣 🍱 🥟 🍚 🍙 🍘 🍢 🍡 🍧 🍨 🍦 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 ☕ 🍵 🧋 🍺 🍻 🥂 🍷",
  },
  {
    name: "物品",
    icon: "💡",
    list: "💻 🖥️ ⌨️ 🖱️ 📱 ☎️ 📷 🎧 🎮 💡 🔦 📚 📖 📝 ✏️ 📌 📎 📁 📅 📈 📉 📊 🔒 🔑 🔨 🛠️ ⚙️ 🧪 🐛 🚀 ✈️ 🚗 🚲 ⏰ ⌛ 💰 📦 📧 🔔 🎵",
  },
  {
    name: "符号",
    icon: "✅",
    list: "✅ ☑️ ✔️ ❌ ❎ ➕ ➖ ❓ ❗ ‼️ ⁉️ ⚠️ 🚫 ⛔ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🆗 🆕 🆒 🆙 🔝 🔜 ⬆️ ⬇️ ⬅️ ➡️ 🔄 🔁 ▶️ ⏸️ ⏹️ 💬 💭 🗨️",
  },
];

/** 回应条上默认的几个（和 QQ / 飞书差不多那一组）。 */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉", "🙏", "👀"];

const RECENT_KEY = "peer.emoji.recent";
const RECENT_MAX = 24;

function readRecent(): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function pushRecent(emoji: string): void {
  const next = [emoji, ...readRecent().filter((x) => x !== emoji)].slice(0, RECENT_MAX);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式：只是记不住最近用过的 */
  }
}

export interface Sticker {
  id: string;
  size: number;
  mime: string;
  w?: number;
  h?: number;
}

export interface EmojiPanelOpts {
  /** 选了一个 Unicode emoji：插进输入框。 */
  onEmoji: (emoji: string) => void;
  /** 选了一个收藏的图片表情：直接发出去。 */
  onSticker: (id: string) => void;
  loadStickers: () => Promise<Sticker[]>;
  addSticker: (file: File) => Promise<void>;
  removeSticker: (id: string) => Promise<void>;
  close: () => void;
}

/** 上一次停在哪一页：下次打开还是那一页。 */
let lastTab: "emoji" | "sticker" = "emoji";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

export function stickerUrl(id: string): string {
  return `/api/peer/stickers/raw?id=${encodeURIComponent(id)}`;
}

/** 一个按钮：**mousedown 不抢焦点**，否则点表情时输入框的光标就没了，插不回原处。 */
function keepFocus(b: HTMLElement): void {
  b.addEventListener("mousedown", (ev) => ev.preventDefault());
}

export function emojiPanel(opts: EmojiPanelOpts): HTMLElement {
  const panel = el("div", "emoji-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", tr("表情"));
  const tabs = el("div", "ep-tabs");
  const tabEmoji = el("button", "ep-tab", tr("表情"));
  const tabSticker = el("button", "ep-tab", tr("我的表情"));
  for (const b of [tabEmoji, tabSticker]) {
    b.type = "button";
    keepFocus(b);
  }
  tabs.append(tabEmoji, tabSticker);
  const body = el("div", "ep-body");
  panel.append(tabs, body);

  const paintEmoji = (): void => {
    body.replaceChildren();
    const nav = el("div", "ep-nav");
    const scroll = el("div", "ep-scroll");
    const sections: { name: string; icon: string; list: string[] }[] = [];
    const recent = readRecent();
    if (recent.length) sections.push({ name: tr("最近使用"), icon: "🕘", list: recent });
    for (const g of GROUPS) sections.push({ name: tr(g.name), icon: g.icon, list: g.list.split(" ").filter(Boolean) });
    for (const sec of sections) {
      const head = el("div", "ep-sec", sec.name);
      const grid = el("div", "ep-grid");
      for (const emoji of sec.list) {
        const b = el("button", "ep-e", emoji);
        b.type = "button";
        b.title = emoji;
        keepFocus(b);
        b.addEventListener("click", () => {
          pushRecent(emoji);
          opts.onEmoji(emoji);
        });
        grid.append(b);
      }
      scroll.append(head, grid);
      const jump = el("button", "ep-jump", sec.icon);
      jump.type = "button";
      jump.title = sec.name;
      keepFocus(jump);
      jump.addEventListener("click", () => {
        // .ep-scroll 是 position:relative，标题的 offsetTop 就是相对它的。
        scroll.scrollTop = head.offsetTop;
      });
      nav.append(jump);
    }
    body.append(nav, scroll);
  };

  const paintSticker = async (): Promise<void> => {
    // 重取时不动已经画好的格子（D316）；首次打开且慢过 220ms 才挂「读取中…」。
    const fresh = !body.querySelector(".stickers");
    if (fresh) body.replaceChildren();
    const slow = fresh ? window.setTimeout(() => body.replaceChildren(el("div", "ep-empty", tr("读取中…"))), 220) : 0;
    let list: Sticker[] = [];
    try {
      list = await opts.loadStickers();
    } catch (err) {
      window.clearTimeout(slow);
      body.replaceChildren(el("div", "ep-empty", (err as Error).message));
      return;
    }
    window.clearTimeout(slow);
    if (lastTab !== "sticker") return;
    const scroll = el("div", "ep-scroll");
    const grid = el("div", "ep-grid stickers");
    // 第一个格子是「添加」：选本机图片收藏进来（聊天里的图也能右键「添加到表情」）。
    const add = el("label", "ep-s ep-add");
    add.title = tr("添加表情（png / jpg / gif / webp，5 MB 以内）");
    add.append(el("span", "", "+"));
    const input = el("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp";
    input.multiple = true;
    input.hidden = true;
    input.addEventListener("change", async () => {
      for (const f of [...(input.files ?? [])]) {
        try {
          await opts.addSticker(f);
        } catch {
          /* 调用方已经 toast 过了 */
        }
      }
      void paintSticker();
    });
    add.append(input);
    grid.append(add);
    for (const s of list) {
      const b = el("button", "ep-s");
      b.type = "button";
      b.title = tr("点一下发送；右键删除");
      keepFocus(b);
      const img = el("img");
      img.src = stickerUrl(s.id);
      img.alt = "";
      img.loading = "lazy";
      b.append(img);
      b.addEventListener("click", () => opts.onSticker(s.id));
      b.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!window.confirm(tr("从「我的表情」里删掉这个？"))) return;
        void opts.removeSticker(s.id).then(() => paintSticker());
      });
      grid.append(b);
    }
    scroll.append(grid);
    if (!list.length) scroll.append(el("div", "ep-tip", tr("还没有收藏。点「+」选图片，或在聊天里右键一张图「添加到表情」。")));
    body.replaceChildren(scroll);
  };

  const show = (tab: "emoji" | "sticker"): void => {
    lastTab = tab;
    tabEmoji.classList.toggle("on", tab === "emoji");
    tabSticker.classList.toggle("on", tab === "sticker");
    if (tab === "emoji") paintEmoji();
    else void paintSticker();
  };
  tabEmoji.addEventListener("click", () => show("emoji"));
  tabSticker.addEventListener("click", () => show("sticker"));
  panel.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      opts.close();
    }
  });
  show(lastTab);
  return panel;
}
