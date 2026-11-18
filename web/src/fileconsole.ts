import { createEl as el } from "./chat.ts";
import { ATTACHABLE_IMAGE, fileNameOf, joinPath, mountDirPicker, type DirPicker, type DirPickerState } from "./dirpicker.ts";
import { tr } from "./i18n/index.ts";
import "./fileconsole.css";

/**
 * 目录入口的控制台：**一份实现、两种壳**。
 *
 * - `dialog`：下沿「文件」的附件弹层（#421），遮罩 + 标题栏 + 页脚，行 = 引用 / 附加。
 * - `pane`：顶栏 📁 文件管理器 viewer 里的浏览页，没有遮罩与标题栏（viewer 自己的头就够了），
 *   行 = 打开预览。左栏、表格、状态栏、窄版折叠全部共用。
 *
 * 两种壳的行语义都由调用方给（`actions` / `onPick` / `onContext`），这里只管壳与左栏。
 */

export interface DeviceUploadUi {
  /** null = 已经开传但还算不出比例；0..1 = 已传字节 / 总字节。 */
  progress: (ratio: number | null) => void;
  /** 失败：按钮复原，弹层里留一句 5 秒的红字。 */
  fail: (message: string) => void;
}

export type FileConsoleChrome = "dialog" | "pane";

export interface FileConsoleOpts {
  /** dialog = 附件弹层（默认）；pane = viewer 浏览页。 */
  chrome?: FileConsoleChrome;
  start: string;
  cwd: string;
  sessionId: string;
  /** 工具条右侧的额外按钮（工作目录 / 复制路径 / ＋文件夹 / ＋文件）。 */
  head?: HTMLElement[];
  /** 新建行：放在跳转 / 筛选下面、列表上面。 */
  beforeList?: HTMLElement[];
  /** 每行右侧的按钮。不给时（只有 dialog 会这样）按「引用 / 附加 + 打开」自己造。 */
  actions?: (abs: string, name: string) => HTMLElement[];
  /** 点一整个文件行。不给时按 dialog 的语义：收起弹层 + 引用 / 附加。 */
  onPick?: (abs: string, name: string) => void;
  onContext?: (abs: string, name: string, ev: MouseEvent) => void;
  /** dialog 行语义要用到的三件事；pane 不传。 */
  onQuote?: (abs: string, name: string) => void;
  onAttach?: (abs: string, name: string) => void;
  onOpen?: (abs: string, name: string) => void;
  onClose?: () => void;
  /** 每次列完目录都通知一声（调用方用它同步按钮的可用状态）。 */
  onState?: (state: DirPickerState) => void;
  /** 记住浏览到哪儿（dialog 按会话记、pane 写进 viewer 的 lastDir）。 */
  rememberDir?: (path: string) => void;
  /** 「从本设备选文件」：只有 dialog 有这个按钮（手机上的文件不在这台机器的盘里）。 */
  onDeviceFiles?: (files: File[], ui: DeviceUploadUi) => void;
}

export interface FileConsoleHandle {
  root: HTMLElement;
  picker: DirPicker;
  focus: () => void;
}

const RECENT_MAX = 8;
const NAV_SUB_MAX = 6;
/**
 * 折左栏 / 收列的门槛，单位是**布局 px**（`clientWidth`，不含 zoom）。
 * 够宽才立左栏；再窄就折成顶上一条横标签，最窄时连标签也收掉（面包屑与 ⌂ 工作目录还在）。
 */
const RAIL_PX = 780;
/** 这两档收的是表格的列：先收「修改时间」，再收「大小」。 */
const MID_PX = 560;
const TIGHT_PX = 430;

export function openFileConsole(opts: FileConsoleOpts): FileConsoleHandle {
  const dialog = (opts.chrome ?? "dialog") === "dialog";
  const recentKey = opts.sessionId ? `${dialog ? "pi.attachRecent:" : "pi.fsRecent:"}${opts.sessionId}` : "";
  let recent = readRecent(recentKey);
  let recentOpen = true;

  const shell = el("section", "sys-console fc-console");
  shell.classList.add(dialog ? "fc-dialog" : "fc-pane-shell");
  let root: HTMLElement = shell;

  // ---- 壳
  const back = el("div", "sys-back fc-back");
  back.onclick = (ev) => {
    if (ev.target === back) opts.onClose?.();
  };
  // Sheet 的 Esc 走冒泡：焦点在按钮 / 表格行上时也能关；跳转框有字时它自己会先吞掉。
  back.onkeydown = (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      opts.onClose?.();
    }
  };

  const head = el("header", "sys-head");
  const headActions = el("div", "sys-head__actions");
  const nav = el("nav", "sys-nav fc-nav");
  const pane = el("div", "sys-pane fc-pane");
  const main = el("div", "sys-main");
  main.append(nav, pane);

  const foot = el("footer", "sys-foot");
  const footHint = el("span", "sys-foot__hint", tr("点行 = 引用（图片 = 附加）；「打开」= 先关列表再看预览"));
  const footPath = el("span", "sys-foot__meta", tr("此电脑"));
  foot.append(footHint, footPath);

  let countBadge: HTMLElement | null = null;

  if (dialog) {
    shell.setAttribute("role", "dialog");
    shell.setAttribute("aria-modal", "true");
    shell.setAttribute("aria-label", tr("选择文件"));
    const headMain = el("div", "sys-head__main");
    headMain.append(
      el("div", "sys-eyebrow", tr("附件")),
      el("h2", "sys-title", tr("选择文件")),
      el("div", "sys-sub", tr("点一行 = 引用到输入框 · 图片行 = 直接附加 · 「打开」= 在预览里打开")),
    );
    const badges = el("div", "sys-badges");
    countBadge = el("span", "sys-badge", tr("0 项"));
    badges.append(countBadge, el("span", "sys-badge", tr("Esc 关闭")));
    headMain.append(badges);
    head.append(headMain, headActions);
    shell.append(head, main, foot);
    back.append(shell);
    root = back;
  } else {
    shell.append(main);
  }

  let current = "";
  let picker: DirPicker | null = null;

  // 按控制台自己的宽度折左栏 / 收列（D312）。窗口宽度说不准：792px 的浏览页常挂在 1440px 的窗口上。
  const fitShell = (): void => {
    // clientWidth 是布局 px：`#app` 上的 zoom 不会把这几个门槛再乘一次（D158 / D312）。
    const width = shell.clientWidth;
    shell.classList.toggle("fc-rail", width >= RAIL_PX);
    shell.classList.toggle("fc-mid", width > 0 && width < MID_PX);
    shell.classList.toggle("fc-tight", width > 0 && width < TIGHT_PX);
  };
  const fitObserver = new ResizeObserver(() => {
    if (!shell.isConnected) {
      fitObserver.disconnect();
      return;
    }
    fitShell();
  });
  fitObserver.observe(shell);
  fitShell();

  const navGroup = (label: string, count?: number): HTMLElement => {
    const group = el("div", "fc-nav-group");
    group.append(el("span", "fc-nav-group__label", label));
    if (count !== undefined) group.append(el("span", "fc-nav-group__count", String(count)));
    return group;
  };

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
      nav.append(navGroup(tr("当前目录"), state.total ?? state.dirs.length));
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
      // 隐私模式 / 关了本地存储：记忆是锦上添花，不该把面板带塌。
    }
  };

  // ---- 「从本设备选文件」（只有弹层有）
  const deviceInput = el("input") as HTMLInputElement;
  deviceInput.type = "file";
  deviceInput.multiple = true;
  deviceInput.hidden = true;
  let deviceBusy = false;
  let errorTimer = 0;
  const deviceError = el("div", "fc-upload-error");
  const resetDevice = (): void => {
    deviceBusy = false;
    device.disabled = false;
    device.dataset.busy = "0";
    device.textContent = tr("从本设备选文件");
  };
  const deviceUi: DeviceUploadUi = {
    progress: (ratio) => {
      deviceBusy = true;
      device.disabled = true;
      device.dataset.busy = "1";
      device.textContent =
        ratio === null ? tr("上传中…") : tr("上传中 {p1}%", { p1: String(Math.round(Math.min(1, Math.max(0, ratio)) * 100)) });
    },
    fail: (message) => {
      resetDevice();
      deviceError.textContent = message;
      window.clearTimeout(errorTimer);
      errorTimer = window.setTimeout(() => {
        deviceError.textContent = "";
      }, 5000);
    },
  };
  deviceInput.onchange = () => {
    const files = Array.from(deviceInput.files ?? []);
    deviceInput.value = "";
    if (!files.length || deviceBusy) return;
    opts.onDeviceFiles?.(files, deviceUi);
  };
  const device = el("button", "btn ghost fc-tool", tr("从本设备选文件")) as HTMLButtonElement;
  device.type = "button";
  device.title = tr("从当前浏览器所在的设备选文件；图片按图片附加，其他文件上传到这台机器并插入路径");
  device.onclick = () => {
    if (!deviceBusy) deviceInput.click();
  };

  const refresh = el("button", "btn ghost fc-ico", "⟳") as HTMLButtonElement;
  refresh.type = "button";
  refresh.title = tr("重新列出这个目录");
  refresh.setAttribute("aria-label", tr("刷新"));
  refresh.onclick = () => picker?.refresh();

  if (dialog) {
    const refreshHead = el("button", "btn ghost", tr("刷新")) as HTMLButtonElement;
    refreshHead.type = "button";
    refreshHead.onclick = () => picker?.refresh();
    const close = el("button", "btn ghost", tr("关闭")) as HTMLButtonElement;
    close.type = "button";
    close.onclick = () => opts.onClose?.();
    headActions.append(deviceInput, device, refreshHead, close);
  }

  renderNav();

  // 每行右侧两颗：图片的第一颗是「附加」，其他文件是「引用」；第二颗永远是「打开」。
  const sheetActions = (abs: string, name: string): HTMLElement[] => {
    const attach = ATTACHABLE_IMAGE.test(name);
    const label = attach ? tr("附加") : tr("引用");
    const quote = el("button", "fc-act quote", label) as HTMLButtonElement;
    quote.type = "button";
    quote.title = attach ? tr("把这张图片附加到待发消息") : tr("把 {p1} 的路径引用到输入框", { p1: name });
    quote.onclick = () => {
      opts.onClose?.();
      if (attach) opts.onAttach?.(abs, name);
      else opts.onQuote?.(abs, name);
    };
    const open = el("button", "fc-act", tr("打开")) as HTMLButtonElement;
    open.type = "button";
    open.title = tr("在预览里打开 {p1}", { p1: name });
    open.onclick = () => {
      opts.onClose?.();
      opts.onOpen?.(abs, name);
    };
    return [quote, open];
  };

  const sheetPick = (abs: string, name: string): void => {
    // 整行点击保持附件弹层原来的语义：图片 = 附加，其他 = 引用路径；先收面板，焦点才能回输入框。
    opts.onClose?.();
    if (ATTACHABLE_IMAGE.test(name)) opts.onAttach?.(abs, name);
    else opts.onQuote?.(abs, name);
  };

  // 工具条右侧的一组按钮：面包屑让位时它们整组换行，不会剩一颗 ⟳ 孤零零挂在下一行。
  const actionGroup = el("div", "fc-actions");
  actionGroup.append(...(dialog ? [device] : []), ...(opts.head ?? []), refresh);

  picker = mountDirPicker(pane, {
    // pane 壳里跳转框与筛选框并排，行内是四列表格；表格滚动区自己带表头。
    layout: "console",
    tableView: true,
    start: opts.start,
    files: true,
    fallback: true,
    pathBox: true,
    // #499：控制台也是文件入口 —— 默认按修改时间降序，和文件管理器一致。
    defaultSort: { key: "mtime", dir: "desc" },
    // 状态栏右侧那格写当前目录（弹层里已经在页脚写了一份，不再重复）。
    statusPath: !dialog,
    head: [actionGroup],
    beforeList: opts.beforeList ?? [],
    actions: opts.actions ?? sheetActions,
    onPick: opts.onPick ?? sheetPick,
    onContext: opts.onContext,
    onState: (state) => {
      current = state.path;
      if (state.path) {
        noteRecent(state.path);
        opts.rememberDir?.(state.path);
      }
      // #499：这是整目录的条数（分页时 dirs/files 只有这一页）。
      if (countBadge) countBadge.textContent = tr("{p1} 项", { p1: String(state.total ?? state.dirs.length + state.files.length) });
      footPath.textContent = state.path || tr("此电脑");
      renderNav(state);
      opts.onState?.(state);
    },
  });
  pane.append(deviceError);

  return {
    root,
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
