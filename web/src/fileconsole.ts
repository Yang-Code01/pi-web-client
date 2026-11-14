import { createEl as el } from "./chat.ts";
import { ATTACHABLE_IMAGE, fileNameOf, joinPath, mountDirPicker, type DirPicker, type DirPickerState } from "./dirpicker.ts";
import { tr } from "./i18n/index.ts";
import "./fileconsole.css";

/**
 * #421：下沿「文件」的附件弹层，以「设置 → 本机管理」的控制台为模板。
 *
 * 外壳、左导航、右表格全部复用 `.sys-*`；这里只负责三件事：左栏的快速位置与最近目录、
 * 右栏的目录表格（dirpicker 的 `layout: "console"` + `tableView`），以及每行的「引用 / 打开」。
 * 文件管理器（viewer 的浏览页）仍走 dirpicker 的行列表，只在自己的 head 里加动作按钮。
 */

export interface FileConsoleOpts {
  start: string;
  cwd: string;
  sessionId: string;
  /** 行 = 引用：把绝对路径插进输入框。 */
  onQuote: (abs: string, name: string) => void;
  /** 行 = 附加：图片直接变成待发图片。 */
  onAttach: (abs: string, name: string) => void;
  /** 行 = 打开：关掉这个列表，在预览里打开。 */
  onOpen: (abs: string, name: string) => void;
  onClose: () => void;
  /** 「从本设备选图片」：手机相册之类，不经桥的本机文件。 */
  onDeviceImages: (files: File[]) => void;
  /** 左栏之外的东西（📎 引用当前文件夹、新建文件夹 / 文件）挂在面包屑右边。 */
  head?: HTMLElement[];
  /** 新建行：放在跳转 / 筛选下面、列表上面。 */
  beforeList?: HTMLElement[];
  /** 每次列完目录都通知一声（app 用它同步 mk 的可用状态）。 */
  onState?: (state: DirPickerState) => void;
  /** D163：按会话记住上次浏览到哪儿。 */
  rememberDir: (path: string) => void;
}

export interface FileConsoleHandle {
  root: HTMLElement;
  picker: DirPicker;
  focus: () => void;
}

const RECENT_MAX = 8;
const NAV_SUB_MAX = 6;

export function openFileConsole(opts: FileConsoleOpts): FileConsoleHandle {
  const recentKey = opts.sessionId ? `pi.attachRecent:${opts.sessionId}` : "";
  let recent = readRecent(recentKey);
  let recentOpen = true;

  const back = el("div", "sys-back fc-back");
  back.onclick = (ev) => {
    if (ev.target === back) opts.onClose();
  };
  // Sheet 的 Esc 走冒泡：焦点在按钮 / 表格行上时也能关；跳转框有字时它自己会先吞掉。
  back.onkeydown = (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      opts.onClose();
    }
  };

  const shell = el("section", "sys-console fc-console");
  shell.setAttribute("role", "dialog");
  shell.setAttribute("aria-modal", "true");
  shell.setAttribute("aria-label", tr("选择文件"));

  const head = el("header", "sys-head");
  const headMain = el("div", "sys-head__main");
  headMain.append(
    el("div", "sys-eyebrow", tr("附件")),
    el("h2", "sys-title", tr("选择文件")),
    el("div", "sys-sub", tr("点一行 = 引用到输入框 · 图片行 = 直接附加 · 「打开」= 在预览里打开")),
  );
  const badges = el("div", "sys-badges");
  const countBadge = el("span", "sys-badge", tr("0 项"));
  badges.append(countBadge, el("span", "sys-badge", tr("Esc 关闭")));
  headMain.append(badges);
  const headActions = el("div", "sys-head__actions");

  const nav = el("nav", "sys-nav fc-nav");
  const pane = el("div", "sys-pane fc-pane");
  const main = el("div", "sys-main");
  main.append(nav, pane);

  const foot = el("footer", "sys-foot");
  const footHint = el("span", "sys-foot__hint", tr("点行 = 引用（图片 = 附加）；「打开」= 先关列表再看预览"));
  const footPath = el("span", "sys-foot__meta", tr("此电脑"));
  foot.append(footHint, footPath);

  head.append(headMain, headActions);
  shell.append(head, main, foot);
  back.append(shell);

  let current = "";
  let picker: DirPicker | null = null;

  const navGroup = (label: string): HTMLElement => el("div", "fc-nav-group", label);

  const navItem = (o: { icon: string; label: string; title?: string; count?: number; on?: boolean; sub?: boolean }): HTMLButtonElement => {
    const button = el("button", `sys-nav__item${o.sub ? " fc-sub" : ""}`) as HTMLButtonElement;
    button.type = "button";
    button.classList.toggle("on", o.on === true);
    const row = el("span", "fc-nav-main");
    row.append(el("span", "fc-nav-ico", o.icon), el("span", "sys-nav__label", o.label));
    button.append(row);
    if (o.count !== undefined) button.append(el("span", "sys-nav__count", String(o.count)));
    if (o.title) button.title = o.title;
    return button;
  };

  const renderNav = (state?: DirPickerState): void => {
    nav.replaceChildren();
    nav.append(navGroup(tr("快速位置")));

    const home = navItem({ icon: "⌂", label: tr("工作目录"), title: opts.cwd, on: current === opts.cwd });
    home.disabled = !opts.cwd;
    home.onclick = () => {
      if (opts.cwd) void picker?.go(opts.cwd);
    };
    nav.append(home);

    const computer = navItem({ icon: "💻", label: tr("此电脑"), on: current === "" });
    computer.onclick = () => void picker?.go("");
    nav.append(computer);

    // 「最近」是这一栏的开关，不是目录：点它折起 / 展开下面那串目录。
    const recentHead = navItem({ icon: "🕘", label: tr("最近"), count: recent.length });
    recentHead.title = recentOpen ? tr("折起最近打开过的目录") : tr("展开最近打开过的目录");
    recentHead.onclick = () => {
      recentOpen = !recentOpen;
      renderNav(state);
    };
    nav.append(recentHead);

    if (recentOpen) {
      const others = recent.filter((p) => p !== current).slice(0, 5);
      for (const path of others) {
        const item = navItem({ icon: "📁", label: fileNameOf(path), title: path, sub: true });
        item.onclick = () => void picker?.go(path);
        nav.append(item);
      }
      if (!others.length) nav.append(el("div", "fc-nav-empty", recent.length ? tr("就是当前目录") : tr("还没进过别的目录")));
    }

    if (current && state?.dirs.length) {
      nav.append(navGroup(tr("当前目录")));
      for (const name of state.dirs.slice(0, NAV_SUB_MAX)) {
        const path = joinPath(current, name);
        const item = navItem({ icon: "📁", label: name, title: path, sub: true });
        item.onclick = () => void picker?.go(path);
        nav.append(item);
      }
    }
  };

  const noteRecent = (path: string): void => {
    if (!path) return;
    recent = [path, ...recent.filter((p) => p !== path)].slice(0, RECENT_MAX);
    if (!recentKey) return;
    try {
      localStorage.setItem(recentKey, JSON.stringify(recent));
    } catch {
      // 隐私模式 / 关了本地存储：记忆是锦上添花，不该把弹层带塌。
    }
  };

  // 「从本设备选图片」：手机 / 另一台机器上的图片不进这台机器的文件系统，只能从浏览器上传。
  const deviceInput = el("input") as HTMLInputElement;
  deviceInput.type = "file";
  deviceInput.accept = "image/*";
  deviceInput.multiple = true;
  deviceInput.hidden = true;
  deviceInput.onchange = () => {
    const files = Array.from(deviceInput.files ?? []);
    deviceInput.value = "";
    if (files.length) opts.onDeviceImages(files);
  };
  const device = el("button", "btn ghost fc-tool", tr("从本设备选图片")) as HTMLButtonElement;
  device.type = "button";
  device.title = tr("从当前浏览器所在的设备（例如手机相册）选图片附加");
  device.onclick = () => deviceInput.click();

  const refresh = el("button", "btn ghost", tr("刷新")) as HTMLButtonElement;
  refresh.onclick = () => picker?.refresh();
  const close = el("button", "btn ghost", tr("关闭")) as HTMLButtonElement;
  close.onclick = () => opts.onClose();
  headActions.append(deviceInput, device, refresh, close);

  renderNav();

  // 每行右侧两颗：图片的第一颗是「附加」，其他文件是「引用」；第二颗永远是「打开」。
  const rowActions = (abs: string, name: string): HTMLElement[] => {
    const attach = ATTACHABLE_IMAGE.test(name);
    const label = attach ? tr("附加") : tr("引用");
    const quote = el("button", "fc-act quote", label) as HTMLButtonElement;
    quote.type = "button";
    quote.title = attach ? tr("把这张图片附加到待发消息") : tr("把 {p1} 的路径引用到输入框", { p1: name });
    quote.onclick = () => {
      opts.onClose();
      if (attach) opts.onAttach(abs, name);
      else opts.onQuote(abs, name);
    };
    const open = el("button", "fc-act", tr("打开")) as HTMLButtonElement;
    open.type = "button";
    open.title = tr("在预览里打开 {p1}", { p1: name });
    open.onclick = () => {
      opts.onClose();
      opts.onOpen(abs, name);
    };
    return [quote, open];
  };

  picker = mountDirPicker(pane, {
    start: opts.start,
    files: true,
    fallback: true,
    pathBox: true,
    layout: "console",
    tableView: true,
    actions: rowActions,
    head: [device, ...(opts.head ?? [])],
    beforeList: opts.beforeList ?? [],
    onState: (state) => {
      current = state.path;
      if (state.path) {
        noteRecent(state.path);
        opts.rememberDir(state.path);
      }
      countBadge.textContent = tr("{p1} 项", { p1: state.dirs.length + state.files.length });
      footPath.textContent = state.path || tr("此电脑");
      renderNav(state);
      opts.onState?.(state);
    },
    onPick: (abs, name) => {
      // 整行点击保持附件弹层原来的语义：图片 = 附加，其他 = 引用路径；先收面板，焦点才能回输入框。
      opts.onClose();
      if (ATTACHABLE_IMAGE.test(name)) opts.onAttach(abs, name);
      else opts.onQuote(abs, name);
    },
  });

  return {
    root: back,
    picker,
    focus: () => pane.querySelector<HTMLInputElement>(".dir-filter")?.focus(),
  };
}

function readRecent(key: string): string[] {
  if (!key) return [];
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((p): p is string => typeof p === "string" && p.trim() !== "");
  } catch {
    return [];
  }
}
