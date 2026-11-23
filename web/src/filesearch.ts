import { createEl as el } from "./chat.ts";
import { tr } from "./i18n/index.ts";
import "./filesearch.css";
import { markSurface } from "./modal.ts";

/**
 * D321：整机文件搜索面板（控制台式）。
 *
 * 外壳复用「设置 → 本机管理」的 `.sys-*`，与附件弹层同一套骨架：左栏是索引范围与状态，
 * 右栏是四列表格。真正干活的是 bridge 侧的 `fileindex.ts` —— 这里只发查询、画结果，
 * 一次查询最多 200 行，搜索框每个键都发（后端前缀段是 0.4 ms 级）。
 */

type SortKey = "name" | "size" | "mtime";

interface Row {
  path: string;
  name: string;
  dir: string;
  size: number;
  mtime: number;
  isDir: boolean;
  vol: string;
}

interface VolumeView {
  id: string;
  count: number;
  enabled: boolean;
}

interface StatusView {
  state: "off" | "scanning" | "paused" | "ready" | "error";
  indexed: number;
  scanned: number;
  currentPath: string;
  volumes: VolumeView[];
  dbBytes: number;
  lastScanAt: number;
  message: string;
}

export interface FileSearchOpts {
  /** 会话工作目录：只用来在「空查询」时把这一层排前面，不限制搜索范围。 */
  cwd: string;
  send: (msg: unknown) => void;
  /** 行 = 引用：把绝对路径插进输入框。 */
  onQuote: (abs: string) => void;
  /** 行 = 打开：文件在预览里打开；目录直接进文件管理器。 */
  onOpen: (abs: string, isDir: boolean) => void;
  /** 行尾「位置」：文件在这台电脑的资源管理器里选中；目录直接进去看。 */
  onReveal: (abs: string, isDir: boolean) => void;
  onClose: () => void;
}

export interface FileSearchHandle {
  root: HTMLElement;
  focus: () => void;
  /** app 把 `filesearch.*` 的帧转进来。 */
  push: (msg: any) => void;
}

const LIMIT = 200;
const DEBOUNCE_MS = 120;
const QUERY_STORAGE_KEY = "pi.filesearch.query";
const SORT_LABEL: Record<SortKey, string> = { name: "名称", size: "大小", mtime: "修改时间" };

function loadSavedQuery(): string {
  try {
    return localStorage.getItem(QUERY_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveQuery(q: string): void {
  try {
    if (q) localStorage.setItem(QUERY_STORAGE_KEY, q);
    else localStorage.removeItem(QUERY_STORAGE_KEY);
  } catch {
    /* 隐私模式或存储受限时忽略 */
  }
}

export function openFileSearch(opts: FileSearchOpts): FileSearchHandle {
  const back = markSurface(el("div", "sys-back fse-back"), "window");
  back.onclick = (ev) => {
    if (ev.target === back) opts.onClose();
  };

  const shell = el("section", "sys-console fse-console");
  shell.setAttribute("role", "dialog");
  shell.setAttribute("aria-modal", "true");
  shell.setAttribute("aria-label", tr("Everything|搜索面板"));

  // ---------------------------------------------------------------- head
  const head = el("header", "sys-head");
  const headMain = el("div", "sys-head__main");
  headMain.append(
    el("div", "sys-eyebrow", tr("Everything|搜索面板")),
    el("h2", "sys-title", tr("在这台电脑上找文件")),
    el("div", "sys-sub", tr("输入名字的一段就行 · 点一行 = 引用到输入框 · Ctrl+Enter = 在预览里打开")),
  );
  const badges = el("div", "sys-badges");
  const countBadge = el("span", "sys-badge", tr("0 项"));
  const stateBadge = el("span", "sys-badge", tr("读取索引…"));
  badges.append(countBadge, stateBadge, el("span", "sys-badge", tr("Esc 关闭")));
  headMain.append(badges);

  const headActions = el("div", "sys-head__actions");
  const scanBtn = el("button", "btn ghost", tr("重建索引")) as HTMLButtonElement;
  scanBtn.type = "button";
  const closeBtn = el("button", "btn ghost", tr("关闭")) as HTMLButtonElement;
  closeBtn.type = "button";
  closeBtn.onclick = () => opts.onClose();
  headActions.append(scanBtn, closeBtn);
  head.append(headMain, headActions);

  // ---------------------------------------------------------------- search row
  const searchRow = el("div", "fse-search");
  const input = el("input", "fse-input") as HTMLInputElement;
  input.type = "search";
  input.placeholder = tr("搜索文件名或路径…");
  input.spellcheck = false;
  input.autocomplete = "off";
  input.value = loadSavedQuery();
  const chips = el("div", "fse-chips");
  const clearBtn = el("button", "fse-clear", "×") as HTMLButtonElement;
  clearBtn.type = "button";
  clearBtn.title = tr("清空");
  clearBtn.hidden = !input.value;
  searchRow.append(input, clearBtn, chips);

  const sortChip = (key: SortKey): HTMLButtonElement => {
    const b = el("button", "fse-chip", tr(SORT_LABEL[key])) as HTMLButtonElement;
    b.type = "button";
    b.dataset.sort = key;
    b.onclick = () => {
      sort = key;
      paintChips();
      void run();
    };
    return b;
  };

  // ---------------------------------------------------------------- body
  const nav = el("nav", "sys-nav fse-nav");
  const pane = el("div", "sys-pane fse-pane");
  const main = el("div", "sys-main");
  main.append(nav, pane);

  const table = el("div", "fse-table");
  const thead = el("div", "fse-headrow");
  thead.append(
    el("span", "fse-c1", tr("名称")),
    el("span", "fse-c2", tr("位置")),
    el("span", "fse-c3", tr("大小")),
    el("span", "fse-c4", tr("修改时间")),
    el("span", "fse-c5", ""),
  );
  const body = el("div", "fse-body");
  const empty = el("div", "fse-empty");
  table.append(thead, body, empty);
  pane.append(table);

  const foot = el("footer", "sys-foot");
  const footHint = el("span", "sys-foot__hint", tr("↑↓ 选 · Enter 引用 · Ctrl+Enter 预览"));
  const footMeta = el("span", "sys-foot__meta", tr("索引还没就绪"));
  foot.append(footHint, footMeta);

  shell.append(head, searchRow, main, foot);
  back.append(shell);

  // ---------------------------------------------------------------- state
  let status: StatusView | null = null;
  let rows: Row[] = [];
  let sel = -1;
  let sort: SortKey = "name";
  let qid = 0;
  let lastMs = 0;
  let volumeSig = "";
  const active = new Set<string>();
  // 卷集合是「显式清单」：空集 = 用户把卷全勾掉了（后端也是这么理解的），不是「不限范围」。
  // 第一次收到 status 时按机器上的卷填满，之后只跟着用户点。
  let activeReady = false;
  // 打开面板后是否已经列过一遍（首次 ready 时自动跑一次空查询）。
  let seeded = false;
  const allVolIds = (): string[] => (status?.volumes ?? []).map((v) => v.id);
  let timer = 0;

  function paintChips(): void {
    chips.replaceChildren();
    for (const key of ["name", "size", "mtime"] as SortKey[]) {
      const b = sortChip(key);
      b.classList.toggle("on", sort === key);
      b.title = tr("按{p1}排序", { p1: tr(SORT_LABEL[key]) });
      chips.append(b);
    }
  }

  const countText = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} M`;
    if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  };

  function paintNav(): void {
    nav.replaceChildren();
    const group = (label: string): HTMLElement => el("div", "fse-nav-group", label);
    const item = (o: { icon: string; label: string; count?: string; on?: boolean; title?: string }): HTMLButtonElement => {
      const b = el("button", "sys-nav__item") as HTMLButtonElement;
      b.type = "button";
      b.classList.toggle("on", o.on === true);
      const row = el("span", "fse-nav-main");
      row.append(el("span", "fse-nav-ico", o.icon), el("span", "sys-nav__label", o.label));
      b.append(row);
      if (o.count !== undefined) b.append(el("span", "sys-nav__count", o.count));
      if (o.title) b.title = o.title;
      return b;
    };

    nav.append(group(tr("搜索范围")));
    // 扫描期还没有分卷计数，用已扫数代替：显示 0 会让人以为索引是空的。
    const totalText = (): string | undefined => {
      if (!status) return undefined;
      const busy = status.state === "scanning" || status.state === "paused";
      return countText(busy ? status.scanned : status.indexed);
    };
    const all = item({
      icon: "▣",
      label: tr("所有卷"),
      on: active.size > 0 && active.size === allVolIds().length,
      count: totalText(),
      title: tr("不限制盘符；下面勾掉的卷不参与索引"),
    });
    all.onclick = () => {
      active.clear();
      for (const id of allVolIds()) active.add(id);
      activeReady = true;
      sendVolumes();
    };
    nav.append(all);

    for (const vol of status?.volumes ?? []) {
      // 扫描期 count 还是 0（分卷计数扫完才采），照样列出来，数字位置留个破折号。
      const on = active.has(vol.id);
      const b = item({
        icon: "▤",
        label: vol.id,
        on,
        count: vol.count ? countText(vol.count) : "—",
        title: on ? tr("点一下：这一卷不参与索引（会重扫）") : tr("点一下：把这一卷加回索引（会重扫）"),
      });
      b.onclick = () => {
        if (active.has(vol.id)) active.delete(vol.id);
        else active.add(vol.id);
        activeReady = true;
        sendVolumes();
      };
      nav.append(b);
    }

    nav.append(group(tr("索引")));
    const st = status;
    const line = el("div", "fse-nav-note");
    if (!st) line.textContent = tr("连接中…");
    else if (st.state === "off") line.textContent = tr("还没建立索引");
    else if (st.state === "scanning") line.textContent = tr("正在扫描：{p1} 项", { p1: countText(st.scanned) });
    else if (st.state === "paused") line.textContent = tr("已暂停（{p1} 项）", { p1: countText(st.scanned) });
    else if (st.state === "error") line.textContent = st.message || tr("索引不可用");
    else line.textContent = tr("就绪 · {p1} 项", { p1: countText(st.indexed) });
    nav.append(line);
    if (st && st.dbBytes) nav.append(el("div", "fse-nav-note dim", tr("索引文件 {p1}", { p1: fmtSize(st.dbBytes) })));
    if (st?.currentPath) nav.append(el("div", "fse-nav-note dim", st.currentPath));
  }

  function paintStatus(): void {
    const st = status;
    if (st && !activeReady && st.volumes.length) {
      for (const v of st.volumes) if (v.enabled) active.add(v.id);
      activeReady = true;
    }
    if (st) {
      stateBadge.textContent =
        st.state === "off"
          ? tr("未建索引")
          : st.state === "scanning"
            ? tr("扫描中 {p1}", { p1: countText(st.scanned) })
            : st.state === "paused"
              ? tr("已暂停")
              : st.state === "error"
                ? tr("出错")
                : tr("就绪");
      stateBadge.dataset.state = st.state;
      scanBtn.textContent = st.state === "scanning" ? tr("暂停") : st.state === "paused" ? tr("继续") : tr("重建索引");
      const volCount = st.volumes.filter((v) => v.count > 0).length;
      footMeta.textContent = tr("索引 {p1} 卷 · {p2} 项 · {p3} ms", {
        p1: String(volCount),
        p2: countText(st.indexed),
        p3: String(lastMs),
      });
    }
    const sig = (status?.volumes ?? []).map((v) => `${v.id}:${v.count}:${v.enabled ? 1 : 0}`).join("|") + `|${active.size}`;
    if (sig !== volumeSig) {
      volumeSig = sig;
      paintNav();
    }
    // 第一次 ready 就自己列一遍（按修改时间倒序）：样张 A 是「推开门就有一张表」，
    // 不是「先看一句提示、非要你输字才肯干活」。
    if (status?.state === "ready" && !seeded) {
      seeded = true;
      void run();
    }
  }

  // ---------------------------------------------------------------- query
  function sendVolumes(): void {
    opts.send({ type: "filesearch.volumes", volumes: [...active] });
    volumeSig = "";
    paintStatus();
  }

  async function run(): Promise<void> {
    qid += 1;
    const id = qid;
    opts.send({ type: "filesearch.query", id, q: input.value, volumes: [...active], sort, limit: LIMIT });
    clearBtn.hidden = !input.value;
    if (id !== qid) return;
  }

  function schedule(): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(), DEBOUNCE_MS);
  }

  // ---------------------------------------------------------------- render
  function paintRows(): void {
    body.replaceChildren();
    countBadge.textContent = rows.length ? tr("{p1} 项", { p1: String(rows.length) }) : tr("0 项");
    if (!rows.length) {
      paintEmpty();
      return;
    }
    empty.hidden = true;
    const needle = input.value.trim();
    rows.forEach((row, i) => {
      const node = el("div", "fse-row");
      node.dataset.abs = row.path;
      node.classList.toggle("on", i === sel);
      const name = el("span", "fse-c1 fse-name");
      // 图标先分「目录 / 文件」两类，名称后面的徽章再说清是什么类型（用户 2026-11-19：
      // 光看一行 `10581` 分不清是文件夹还是文件）。
      name.prepend(el("span", "fse-ico", row.isDir ? "▤" : "▪"));
      // 高亮片段包在单独一层里：`.fse-name` 是 flex（图标与名字留 6px），
      // 若让 `<mark>` 直接当 flex 子项，每段文字之间都会多出一道 gap，名字看起来像断成几截。
      const label = el("span", "fse-label");
      label.append(marked(row.name, needle));
      name.append(label, el("span", "fse-kind", kindText(row)));
      const dir = el("span", "fse-c2 fse-dir", row.dir);
      dir.title = row.path;
      // 行尾三颗：引用 / 打开 / 所在位置（和文件弹层 `.fc-acts` 同一套做法）。
      // 都先 `stopPropagation()`：整行点击仍然是「引用并关面板」，按钮自己说清楚自己干什么。
      const acts = el("span", "fse-acts");
      const act = (label: string, title: string, run: () => void): HTMLButtonElement => {
        const b = el("button", "fse-act", label) as HTMLButtonElement;
        b.type = "button";
        b.title = title;
        b.tabIndex = -1;
        b.onclick = (ev) => {
          ev.stopPropagation();
          select(i);
          run();
        };
        return b;
      };
      acts.append(
        // 和文件弹层同序：先收回面板，再把焦点交还给输入框 / 预览。
        act(tr("引用"), tr("把 {p1} 的路径引用到输入框", { p1: row.name }), () => {
          opts.onClose();
          opts.onQuote(row.path);
        }),
        // 目录没有「预览」这回事：用户 2026-11-18 要求目录直接就打开目录，所以文案也跟着变。
        // 不关搜索面板：浮窗压在面板之上，点「←」或 Esc 回到 Everything 搜索结果（「从哪来，回哪去」）。
        act(
          row.isDir ? tr("打开目录") : tr("打开"),
          row.isDir ? tr("进到 {p1} 里面看", { p1: row.name }) : tr("在预览里打开 {p1}", { p1: row.name }),
          () => {
            opts.onOpen(row.path, row.isDir);
          },
        ),
      );
      // 第三颗「位置」：文件和目录都有 —— 文件在系统文件管理器里选中，目录直接在系统文件管理器里打开
      // （区别于第二颗「打开目录」：那是留在网页客户端内建的文件浏览器里看；用户 2026-11-20）。
      acts.append(
        act(
          tr("位置"),
          row.isDir
            ? tr("在这台电脑的文件管理器里打开 {p1}", { p1: row.name })
            : tr("在这台电脑的文件管理器里显示 {p1}", { p1: row.name }),
          () => opts.onReveal(row.path, row.isDir),
        ),
      );
      node.append(name, dir, el("span", "fse-c3", row.isDir ? "" : fmtSize(row.size)), el("span", "fse-c4", fmtTime(row.mtime)), acts);
      node.onclick = () => {
        select(i);
        // 整行点击还是样张 A 的规矩「点一行 = 引用到输入框」，顺序同文件弹层：先收面板再插入。
        opts.onClose();
        opts.onQuote(row.path);
      };
      body.append(node);
    });
  }

  function paintEmpty(): void {
    empty.hidden = false;
    empty.replaceChildren();
    const st = status;
    if (!st || st.state === "off") {
      empty.append(
        el("div", "fse-empty__title", tr("还没有索引")),
        el("div", "fse-empty__sub", tr("建一次索引之后，搜索是毫秒级的；首次扫描这台电脑要几十秒到几分钟。")),
      );
      const go = el("button", "btn primary", tr("开始扫描")) as HTMLButtonElement;
      go.type = "button";
      go.onclick = () => opts.send({ type: "filesearch.scan" });
      empty.append(go);
      return;
    }
    if (st.state === "error") {
      empty.append(el("div", "fse-empty__title", tr("索引不可用")), el("div", "fse-empty__sub", st.message));
      return;
    }
    if (st.state === "scanning" || st.state === "paused") {
      empty.append(
        el("div", "fse-empty__title", tr("正在建索引")),
        el("div", "fse-empty__sub", tr("已扫 {p1} 项，扫完就能搜。", { p1: countText(st.scanned) })),
        el("div", "fse-empty__path", st.currentPath || ""),
      );
      return;
    }
    if (input.value.trim()) {
      empty.append(
        el("div", "fse-empty__title", tr("没找到")),
        el("div", "fse-empty__sub", tr("换个词试试：文件名的一段、路径里的目录名都行。")),
      );
      return;
    }
    empty.append(
      el("div", "fse-empty__title", tr("输入点什么")),
      el("div", "fse-empty__sub", tr("索引里有 {p1} 项；直接按修改时间列着。", { p1: countText(st.indexed) })),
    );
  }

  function select(i: number): void {
    sel = i;
    const nodes = body.querySelectorAll<HTMLElement>(".fse-row");
    nodes.forEach((n, k) => n.classList.toggle("on", k === i));
    nodes[i]?.scrollIntoView({ block: "nearest" });
  }

  function current(): Row | null {
    return rows[sel] ?? null;
  }

  // ---------------------------------------------------------------- events
  input.oninput = () => {
    saveQuery(input.value);
    clearBtn.hidden = !input.value;
    sel = -1;
    schedule();
  };
  input.onkeydown = (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!rows.length) return;
      const next = ev.key === "ArrowDown" ? Math.min(rows.length - 1, sel + 1) : Math.max(0, sel - 1);
      select(next);
      return;
    }
    if (ev.key === "Enter") {
      const row = current() ?? rows[0];
      if (!row) return;
      ev.preventDefault();
      if (ev.ctrlKey || ev.metaKey) {
        opts.onOpen(row.path, row.isDir);
        return;
      }
      opts.onQuote(row.path);
      opts.onClose();
    }
  };
  clearBtn.onclick = () => {
    input.value = "";
    saveQuery("");
    clearBtn.hidden = true;
    input.focus();
    void run();
  };
  scanBtn.onclick = () => {
    if (status?.state === "scanning") opts.send({ type: "filesearch.pause" });
    else if (status?.state === "paused") opts.send({ type: "filesearch.resume" });
    else opts.send({ type: "filesearch.scan" });
  };
  back.onkeydown = (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      opts.onClose();
    }
  };

  paintChips();
  paintNav();
  paintStatus();
  paintEmpty();
  opts.send({ type: "filesearch.status" });

  return {
    root: back,
    focus: () => {
      input.focus();
      input.select();
    },
    push: (msg: any) => {
      if (msg?.type === "filesearch.status") {
        status = msg.status as StatusView;
        paintStatus();
        if (!rows.length) paintEmpty();
        return;
      }
      if (msg?.type === "filesearch.result") {
        if (msg.id !== qid) return;
        rows = Array.isArray(msg.rows) ? (msg.rows as Row[]) : [];
        lastMs = Number(msg.ms ?? 0);
        sel = rows.length ? 0 : -1;
        paintRows();
        paintStatus();
      }
    },
  };
}

/** 命中片段包 `<mark>`：用 indexOf 切片，不拼正则（路径里的括号 / 方括号会把正则打坏）。 */
function marked(text: string, query: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const needle = query.trim().toLowerCase();
  if (!needle) {
    frag.append(document.createTextNode(text));
    return frag;
  }
  const hay = text.toLowerCase();
  let at = 0;
  for (;;) {
    const hit = hay.indexOf(needle, at);
    if (hit < 0) break;
    if (hit > at) frag.append(document.createTextNode(text.slice(at, hit)));
    frag.append(el("mark", "fse-hit", text.slice(hit, hit + needle.length)));
    at = hit + needle.length;
  }
  if (at < text.length) frag.append(document.createTextNode(text.slice(at)));
  return frag;
}

/** 名称列尾的类型徽章：目录「文件夹」，文件给后缀（大写），没有后缀就是「文件」。 */
function kindText(row: Row): string {
  if (row.isDir) return tr("文件夹");
  return extOf(row.name) || tr("文件");
}

/** `a.tar.gz` → `GZ`；dotfile（`.gitignore`）与没有后缀都算没有。 */
function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot >= name.length - 1) return "";
  return name.slice(dot + 1).toUpperCase();
}

function fmtSize(n: number): string {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function fmtTime(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const p = (v: number): string => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
