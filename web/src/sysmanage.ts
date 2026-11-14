/**
 * #266 本机管理：C 双栏控制台。
 *
 * 左边四页：概况 / 网络与 DNS / 端口与服务 / 服务；右边是当前页。
 * 读是本机 + 局域网；公网只读且数据已在桥端打码。DNS 写永远要主机桌面点 UAC。
 */
import { api } from "./api.ts";
import { createEl as el } from "./chat.ts";
import { errText, fmtTime, tr } from "./i18n/index.ts";
import {
  DNS_PRESETS,
  clockText,
  filterServices,
  formatBytes,
  formatCountdown,
  formatDuration,
  parseDnsInput,
  parseHours,
  presetOf,
  sameServers,
  serviceStartLabel,
  serviceStatusLabel,
  statusTone,
  targetText,
  uptimeParts,
  visiblePorts,
  weekdayOf,
  workdayName,
  workedPercent,
} from "./sysmanage-model.ts";
import type {
  DnsResult,
  NetStatus,
  SysAdapter,
  SysNetwork,
  SysOverview,
  SysPort,
  SysPorts,
  SysSection,
  SysServices,
  SysWorkclock,
  WinnatInfo,
  WorkclockDay,
  WorkclockSource,
  WorkclockToday,
} from "./sysmanage-types.ts";
import "./sysmanage.css";

type PortFilterId = "all" | "external" | "bridge";

interface Notice {
  kind: "ok" | "bad";
  text: string;
}

interface State {
  section: SysSection;
  overview: SysOverview | null;
  network: SysNetwork | null;
  ports: SysPorts | null;
  services: SysServices | null;
  workclock: SysWorkclock | null;
  loading: Record<SysSection, boolean>;
  error: Record<SysSection, string>;
  selectedGuid: string;
  draft: string[] | null;
  showLoopback: boolean;
  portFilter: PortFilterId;
  showMicrosoft: boolean;
  showStopped: boolean;
  serviceQuery: string;
  busyDns: boolean;
  busyWinnat: boolean;
  notice: Notice | null;
  /** 工时输入框里的草稿；保存成功后被服务端值覆盖。 */
  wkHours: string;
  /** 空串表示没有正在跑的写入；装记录器、回填可能慢，得把按钮禁掉。 */
  wkBusy: "" | "save" | "install" | "uninstall" | "backfill";
}

const EMPTY_LOADING: Record<SysSection, boolean> = {
  overview: false,
  network: false,
  ports: false,
  services: false,
  workclock: false,
};

const EMPTY_ERROR: Record<SysSection, string> = {
  overview: "",
  network: "",
  ports: "",
  services: "",
  workclock: "",
};

let current: SysPanel | null = null;

/** 打开本机管理。重复调用先关旧的，不会叠两层。 */
export function openSysmanage(): void {
  current?.close();
  current = new SysPanel();
  current.mount();
}

class SysPanel {
  private state: State = {
    section: "overview",
    overview: null,
    network: null,
    ports: null,
    services: null,
    workclock: null,
    loading: { ...EMPTY_LOADING },
    error: { ...EMPTY_ERROR },
    selectedGuid: "",
    draft: null,
    showLoopback: false,
    portFilter: "all",
    showMicrosoft: false,
    showStopped: false,
    serviceQuery: "",
    busyDns: false,
    busyWinnat: false,
    notice: null,
    wkHours: "9",
    wkBusy: "",
  };
  private root: HTMLElement | null = null;
  private headerSub = "";
  private badges: HTMLElement | null = null;
  private banner: HTMLElement | null = null;
  private nav: HTMLElement | null = null;
  private pane: HTMLElement | null = null;
  private customInput: HTMLInputElement | null = null;
  private noticeTimer: number | null = null;
  private countdownTimer: number | null = null;
  private countdownNodes: { digits: HTMLElement; caption: HTMLElement; worked: HTMLElement; bar: HTMLElement } | null = null;
  /** 已经提醒过哪天，别每秒重复 toast 同一个下班点。 */
  private notifiedDate = "";
  private renderedSection: SysSection | null = null;
  private scrollBySection = new Map<SysSection, number>();
  private keyHandler = (ev: KeyboardEvent): void => {
    if (ev.key !== "Escape" || !this.root) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.close();
  };

  mount(): void {
    this.build();
    const app = document.getElementById("app") ?? document.body;
    app.append(this.root!);
    document.addEventListener("keydown", this.keyHandler, true);
    this.root!.querySelector<HTMLButtonElement>(".sys-close")?.focus();
    void Promise.all([this.load("overview"), this.load("network")]);
  }

  close(): void {
    document.removeEventListener("keydown", this.keyHandler, true);
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.stopCountdown();
    this.root?.remove();
    this.root = null;
    if (current === this) current = null;
  }

  // ---------------------------------------------------------------- 外壳

  private build(): void {
    const root = el("div", "sys-back");
    root.addEventListener("mousedown", (ev) => {
      if (ev.target === root) this.close();
    });
    const consoleNode = el("section", "sys-console");
    consoleNode.setAttribute("role", "dialog");
    consoleNode.setAttribute("aria-modal", "true");
    consoleNode.setAttribute("aria-label", tr("本机管理"));

    const head = el("header", "sys-head");
    const main = el("div", "sys-head__main");
    main.append(el("div", "sys-eyebrow", tr("本机管理")));
    const title = el("h2", "sys-title", tr("本机"));
    title.dataset.role = "hostname";
    main.append(title);
    const sub = el("div", "sys-sub");
    sub.dataset.role = "sub";
    main.append(sub);
    this.badges = el("div", "sys-badges");
    main.append(this.badges);

    const actions = el("div", "sys-head__actions");
    const refresh = el("button", "btn ghost", tr("刷新"));
    refresh.type = "button";
    refresh.onclick = () => void this.refresh();
    const close = el("button", "btn ghost sys-close", tr("关闭"));
    close.type = "button";
    close.onclick = () => this.close();
    actions.append(refresh, close);

    head.append(main, actions);

    this.banner = el("div", "sys-banners");

    const body = el("div", "sys-main");
    this.nav = el("nav", "sys-nav");
    this.nav.setAttribute("aria-label", tr("本机管理分区"));
    this.pane = el("div", "sys-pane");
    body.append(this.nav, this.pane);

    const foot = el("footer", "sys-foot");
    foot.append(
      el("span", "sys-foot__hint", tr("DNS 改动与重启 WinNAT 会在主机桌面弹 UAC，点「是」才生效。")),
      el("span", "sys-foot__meta", "pi-web-client"),
    );

    consoleNode.append(head, this.banner, body, foot);
    root.append(consoleNode);
    this.root = root;
  }

  // ---------------------------------------------------------------- 数据

  private data(section: SysSection): SysOverview | SysNetwork | SysPorts | SysServices | SysWorkclock | null {
    return this.state[section];
  }

  private async load(section: SysSection, force = false): Promise<void> {
    if (this.state.loading[section]) return;
    if (!force && this.data(section)) {
      this.render();
      return;
    }
    this.state.loading[section] = true;
    this.state.error[section] = "";
    this.render();
    try {
      let value: SysOverview | SysNetwork | SysPorts | SysServices | SysWorkclock;
      if (section === "overview") value = await api.sysOverview();
      else if (section === "network") value = await api.sysNetwork();
      else if (section === "ports") value = await api.sysPorts();
      else if (section === "services") value = await api.sysServices();
      else value = await api.sysWorkclock();
      this.state[section] = value as never;
      if (section === "network") this.ensureSelection();
      if (section === "workclock") this.state.wkHours = String(this.state.workclock?.settings.hours ?? 9);
    } catch (err) {
      this.state.error[section] = errText(err);
    } finally {
      this.state.loading[section] = false;
      this.render();
    }
  }

  private async refresh(): Promise<void> {
    const section = this.state.section;
    if (section === "overview") await Promise.all([this.load("overview", true), this.load("network", true)]);
    else await this.load(section, true);
  }

  private select(section: SysSection): void {
    if (this.state.section === section) return;
    this.state.section = section;
    this.state.notice = null;
    this.state.draft = null;
    this.render();
    if (!this.data(section)) void this.load(section);
  }

  private ensureSelection(): void {
    const net = this.state.network;
    if (!net?.adapters.length) {
      this.state.selectedGuid = "";
      return;
    }
    if (net.adapters.some((a) => a.guid === this.state.selectedGuid)) return;
    const preferred = net.adapters.find((a) => a.default) ?? net.adapters.find((a) => a.status === "up") ?? net.adapters[0];
    this.state.selectedGuid = preferred.guid;
  }

  private selectedAdapter(): SysAdapter | null {
    return this.state.network?.adapters.find((a) => a.guid === this.state.selectedGuid) ?? null;
  }

  // ---------------------------------------------------------------- 渲染

  private render(): void {
    if (!this.root) return;
    this.paintHeader();
    this.paintNav();
    this.paintPane();
  }

  private paintHeader(): void {
    const overview = this.state.overview;
    const title = this.root?.querySelector<HTMLElement>('[data-role="hostname"]');
    const sub = this.root?.querySelector<HTMLElement>('[data-role="sub"]');
    if (title) title.textContent = overview?.hostname || tr("本机");
    if (sub) {
      const parts: string[] = [];
      if (overview) {
        parts.push([overview.os.name, overview.os.version].filter(Boolean).join(" "));
        if (overview.os.build) parts.push(overview.os.build);
        parts.push(overview.os.arch);
      }
      const next = parts.filter(Boolean).join(" · ");
      if (next !== this.headerSub) {
        this.headerSub = next;
        sub.textContent = next;
      }
    }
    if (this.badges) {
      this.badges.replaceChildren();
      if (overview) {
        this.badges.append(this.badge(`bridge ${overview.bridge.version}`));
        if (overview.bridge.port !== null) this.badges.append(this.badge(`:${overview.bridge.port}`));
        if (overview.public) this.badges.append(this.badge(tr("公网只读"), "warn"));
      }
      if (this.state.network) {
        const up = this.state.network.adapters.filter((a) => a.status === "up").length;
        this.badges.append(this.badge(tr("{p1} / {p2} 张网卡在线", { p1: up, p2: this.state.network.adapters.length })));
      }
    }
    this.paintBanners();
  }

  private paintBanners(): void {
    if (!this.banner) return;
    this.banner.replaceChildren();
    const overview = this.state.overview;
    if (overview?.public) {
      const row = el("div", "sys-banner sys-banner--warn");
      row.append(el("span", "sys-banner__text", tr("公网访问：网卡 IP、MAC、端口和服务名已打码；DNS 改动请回本机操作。")));
      this.banner.append(row);
    }
    const notice = this.state.notice;
    if (notice) {
      const row = el("div", `sys-banner sys-banner--${notice.kind}`);
      row.append(el("span", "sys-banner__text", notice.text));
      const close = el("button", "sys-banner__close", "×");
      close.type = "button";
      close.setAttribute("aria-label", tr("关闭提示"));
      close.onclick = () => {
        this.state.notice = null;
        this.paintBanners();
      };
      row.append(close);
      this.banner.append(row);
    }
  }

  private paintNav(): void {
    if (!this.nav) return;
    const net = this.state.network;
    const ports = this.state.ports;
    const services = this.state.services;
    const counts: Record<SysSection, string> = {
      overview: "",
      network: net ? String(net.adapters.length) : "",
      ports: ports ? String(ports.summary.external) : "",
      services: services ? String(services.summary.nonMicrosoft) : "",
      workclock: this.state.workclock ? `${this.state.workclock.settings.hours}h` : "",
    };
    const labels: Record<SysSection, string> = {
      overview: tr("概况"),
      network: tr("网络与 DNS"),
      ports: tr("端口与服务"),
      services: tr("服务"),
      workclock: tr("上下班"),
    };
    this.nav.replaceChildren();
    (["overview", "network", "ports", "services", "workclock"] as SysSection[]).forEach((section) => {
      const button = el("button", `sys-nav__item${this.state.section === section ? " on" : ""}`);
      button.type = "button";
      button.onclick = () => this.select(section);
      const label = el("span", "sys-nav__label", labels[section]);
      button.append(label);
      if (counts[section]) button.append(el("span", "sys-nav__count", counts[section]));
      this.nav!.append(button);
    });
  }

  private paintPane(): void {
    if (!this.pane) return;
    const section = this.state.section;
    this.stopCountdown();
    if (this.renderedSection !== null) this.scrollBySection.set(this.renderedSection, this.pane.scrollTop);
    this.pane.replaceChildren();
    this.renderedSection = section;
    if (this.state.loading[section] && !this.data(section)) {
      this.pane.append(this.skeleton());
    } else if (this.state.error[section] && !this.data(section)) {
      this.pane.append(this.errorBox(section));
    } else if (section === "overview") {
      this.paintOverview();
    } else if (section === "network") {
      this.paintNetwork();
    } else if (section === "ports") {
      this.paintPorts();
    } else if (section === "services") {
      this.paintServices();
    } else {
      this.paintWorkclock();
    }
    this.pane.scrollTop = this.scrollBySection.get(section) ?? 0;
  }

  // ---------------------------------------------------------------- 概况

  private paintOverview(): void {
    const pane = this.pane!;
    const data = this.state.overview;
    if (!data) return;
    if (!data.supported) {
      pane.append(this.note(tr("这个系统只支持概况与网卡；DNS、端口和服务列表暂不支持。")));
    }
    const grid = el("div", "sys-grid");
    const used = data.memory.total - data.memory.free;
    const memPct = data.memory.total > 0 ? (used / data.memory.total) * 100 : 0;
    grid.append(
      this.card(tr("CPU"), data.cpu.model, tr("{p1} 线程", { p1: data.cpu.threads })),
      this.card(tr("内存"), `${formatBytes(used)} / ${formatBytes(data.memory.total)}`, undefined, this.bar(memPct, memPct > 85 ? "danger" : "accent")),
      this.card(tr("开机"), this.uptimeText(data.os.uptime), tr("自 {p1}", { p1: fmtTime(Date.now() - data.os.uptime * 1000) })),
      this.card(
        tr("桥"),
        data.bridge.pid !== null ? `PID ${data.bridge.pid}` : tr("已打码"),
        `${data.bridge.port !== null ? `:${data.bridge.port} · ` : ""}node ${data.bridge.node}`,
      ),
    );
    pane.append(grid);

    const disksHead = this.sectionHead(tr("磁盘"), tr("{p1} 块", { p1: data.disks.length }));
    pane.append(disksHead);
    const disks = el("div", "sys-disks");
    for (const disk of data.disks) {
      const pct = disk.total > 0 ? ((disk.total - disk.free) / disk.total) * 100 : 0;
      const row = el("div", "sys-disk");
      row.append(el("span", "sys-disk__name", disk.root));
      row.append(this.bar(pct, pct > 90 ? "danger" : pct > 75 ? "warn" : "accent"));
      row.append(el("span", "sys-disk__text", tr("{p1} / {p2} 可用", { p1: formatBytes(disk.free), p2: formatBytes(disk.total) })));
      disks.append(row);
    }
    if (!data.disks.length) disks.append(el("div", "sys-empty", tr("没有可读的磁盘")));
    pane.append(disks);

    const net = this.state.network;
    if (net) {
      const up = net.adapters.filter((a) => a.status === "up");
      pane.append(this.sectionHead(tr("网卡"), tr("{p1} 张在线", { p1: up.length })));
      const list = el("div", "sys-adapters sys-adapters--compact");
      for (const adapter of net.adapters.slice(0, 5)) {
        const row = el("button", "sys-adapter");
        row.type = "button";
        row.onclick = () => this.select("network");
        row.append(this.statusDot(adapter.status));
        const main = el("span", "sys-adapter__main");
        main.append(el("span", "sys-adapter__name", adapter.name));
        main.append(el("span", "sys-adapter__desc", adapter.description));
        row.append(main);
        row.append(el("span", "sys-adapter__value", adapter.ipv4.length ? `${adapter.ipv4[0]}/${this.prefixOf(adapter)}` : tr("未连接")));
        list.append(row);
      }
      pane.append(list);
      const more = el("button", "btn ghost sys-more", tr("查看网络与 DNS"));
      more.type = "button";
      more.onclick = () => this.select("network");
      pane.append(more);
    }
  }

  // ---------------------------------------------------------------- 网络与 DNS

  private paintNetwork(): void {
    const pane = this.pane!;
    const data = this.state.network;
    if (!data) return;
    if (!data.supported) {
      pane.append(this.note(tr("这个系统只支持概况与网卡；DNS 切换暂不支持。")));
    }
    if (!data.adapters.length) {
      pane.append(el("div", "sys-empty", tr("没有找到网卡")));
      return;
    }
    this.ensureSelection();
    const layout = el("div", "sys-net");
    const list = el("div", "sys-net__list");
    list.append(this.sectionHead(tr("网卡"), tr("{p1} 张", { p1: data.adapters.length })));
    for (const adapter of data.adapters) {
      list.append(this.adapterRow(adapter));
    }
    const editor = el("div", "sys-dns");
    this.paintDnsEditor(editor, data);
    // 右栏：DNS 编辑在上、WinNAT 在下；放进同一栏，不再在网卡列表下面另起一整行。
    const side = el("div", "sys-net__side");
    side.append(editor);
    if (data.winnat) side.append(this.winnatCard(data.winnat, data.public || !data.supported, data.public));
    layout.append(list, side);
    pane.append(layout);
  }

  /** 重启 WinNAT（原桌面 netweb_restar.bat）：端口被 Hyper-V / WSL 保留占住时用。 */
  private winnatCard(winnat: WinnatInfo, readOnly: boolean, isPublic: boolean): HTMLElement {
    const card = el("div", "sys-winnat");
    const head = el("div", "sys-winnat__head");
    head.append(el("span", "sys-winnat__title", tr("WinNAT 服务")));
    const running = winnat.status === "Running";
    head.append(el("span", `sys-tag${running ? " sys-tag--accent" : ""}`, serviceStatusLabel(winnat.status)));
    if (winnat.start) head.append(el("span", "sys-tag", serviceStartLabel(winnat.start)));
    card.append(head);
    card.append(
      el(
        "div",
        "sys-hint",
        tr("端口被占用或绑定报「访问权限不允许」时，重启 WinNAT 可以释放 Hyper-V / WSL 保留的端口。会短暂断开 WSL / Docker 的 NAT 网络。"),
      ),
    );
    const actions = el("div", "sys-winnat__actions");
    const busy = this.state.busyWinnat;
    const button = el("button", "btn", busy ? tr("等待 UAC…") : running ? tr("重启 WinNAT") : tr("启动 WinNAT"));
    button.type = "button";
    button.disabled = busy || this.state.busyDns || readOnly;
    button.onclick = () => void this.restartWinnat();
    actions.append(button);
    card.append(actions);
    if (isPublic) card.append(el("div", "sys-hint", tr("公网只读：重启 WinNAT 请回本机操作。")));
    if (busy) card.append(el("div", "sys-busy", tr("正在等主机桌面确认…")));
    return card;
  }

  private async restartWinnat(): Promise<void> {
    if (this.state.busyWinnat || this.state.busyDns) return;
    if (!confirm(tr("重启 WinNAT？WSL / Docker / Hyper-V 虚拟机的网络会断开几秒，主机桌面会弹 UAC。"))) return;
    this.state.busyWinnat = true;
    this.state.notice = null;
    this.render();
    try {
      const result = await api.sysWinnatRestart();
      const status = serviceStatusLabel(result.winnat.status);
      const head = result.wasRunning
        ? tr("WinNAT 已重启（{p1}）。", { p1: status })
        : tr("WinNAT 原本没在运行，这次只是启动了它（{p1}）。", { p1: status });
      const deps = result.depsFailed.length
        ? tr("这些依赖服务没拉起来：{p1}", { p1: result.depsFailed.join(", ") })
        : "";
      this.setNotice("ok", deps ? `${head} ${deps}` : head);
    } catch (err) {
      this.setNotice("bad", errText(err));
    } finally {
      // 成功或失败都重读：停下来却没启动成功时，卡片要显示真实状态。
      this.state.busyWinnat = false;
      await this.load("network", true);
    }
  }

  private adapterRow(adapter: SysAdapter): HTMLElement {
    const row = el("button", `sys-adapter${adapter.guid === this.state.selectedGuid ? " on" : ""}`);
    row.type = "button";
    row.onclick = () => {
      this.state.selectedGuid = adapter.guid;
      this.state.draft = null;
      this.state.notice = null;
      this.render();
    };
    row.append(this.statusDot(adapter.status));
    const main = el("span", "sys-adapter__main");
    const line = el("span", "sys-adapter__name");
    line.append(document.createTextNode(adapter.name));
    if (adapter.default) line.append(el("span", "sys-tag sys-tag--accent", tr("默认路由")));
    if (adapter.dhcp) line.append(el("span", "sys-tag", "DHCP"));
    main.append(line);
    main.append(el("span", "sys-adapter__desc", `#${adapter.index} · ${adapter.description}`));
    main.append(
      el("span", "sys-adapter__meta", tr("掩码 {p1}", { p1: adapter.mask.length ? adapter.mask.join(", ") : "—" })),
    );
    main.append(
      el(
        "span",
        "sys-adapter__meta",
        tr("网关 {p1} · MAC {p2}", {
          p1: adapter.gateway.length ? adapter.gateway.join(", ") : "—",
          p2: adapter.mac || "—",
        }),
      ),
    );
    row.append(main);
    const right = el("span", "sys-adapter__right");
    right.append(el("span", "sys-adapter__value", adapter.ipv4.length ? adapter.ipv4.join(", ") : tr("未连接")));
    right.append(
      el(
        "span",
        "sys-adapter__dns",
        adapter.dns.length ? tr("DNS {p1}", { p1: adapter.dns.join(", ") }) : tr("DNS 自动"),
      ),
    );
    row.append(right);
    return row;
  }

  private paintDnsEditor(editor: HTMLElement, data: SysNetwork): void {
    const adapter = this.selectedAdapter();
    if (!adapter) {
      editor.append(el("div", "sys-empty", tr("选一张网卡")));
      return;
    }
    const saved = data.saved.find((s) => s.guid === adapter.guid);
    const current = adapter.dhcp && !adapter.dns.length ? [] : adapter.dns;
    const draft = this.state.draft;
    const chosen = draft ?? current;
    const disabled = this.state.busyDns || this.state.busyWinnat || data.public || !data.supported;

    const head = el("div", "sys-dns__head");
    const title = el("div", "sys-dns__title", tr("DNS"));
    const name = el("div", "sys-dns__adapter", adapter.name);
    head.append(title, name);
    editor.append(head);

    const currentRow = el("div", "sys-dns__current");
    currentRow.append(el("span", "sys-dns__label", tr("当前")));
    if (current.length) {
      for (const server of current) currentRow.append(el("span", "sys-chip sys-chip--mono", server));
    } else {
      currentRow.append(el("span", "sys-chip", tr("自动（DHCP）")));
    }
    editor.append(currentRow);

    if (saved) {
      const box = el("div", "sys-saved");
      const text = el(
        "span",
        "sys-saved__text",
        tr("原值已保存：{p1}", { p1: saved.dhcp ? tr("自动（DHCP）") : saved.before.join(", ") }),
      );
      const restore = el("button", "btn ghost", tr("恢复原来那组"));
      restore.type = "button";
      restore.disabled = disabled;
      restore.onclick = () => void this.restoreDns(adapter);
      box.append(text, restore);
      editor.append(box);
    }

    const presets = el("div", "sys-presets");
    const activePreset = presetOf(chosen);
    for (const preset of DNS_PRESETS) {
      const button = el("button", `sys-preset${activePreset === preset.id ? " on" : ""}`);
      button.type = "button";
      button.disabled = disabled;
      button.onclick = () => {
        this.state.draft = preset.servers.slice();
        this.state.notice = null;
        this.render();
      };
      button.append(el("span", "sys-preset__name", tr(preset.label)));
      button.append(el("span", "sys-preset__ip", preset.servers.join(", ")));
      presets.append(button);
    }
    editor.append(presets);

    const custom = el("div", "sys-custom");
    const input = el("input", "sys-input") as HTMLInputElement;
    input.type = "text";
    input.placeholder = tr("自定义：10.6.1.10, 10.6.1.11");
    input.value = draft ? draft.join(", ") : "";
    input.disabled = disabled;
    input.oninput = () => {
      this.state.draft = null;
      for (const node of presets.querySelectorAll(".sys-preset.on")) node.classList.remove("on");
    };
    input.onkeydown = (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void this.applyDns(adapter);
      }
    };
    this.customInput = input;
    custom.append(input);

    const actions = el("div", "sys-dns__actions");
    const apply = el("button", "btn primary", this.state.busyDns ? tr("等待 UAC…") : tr("应用 DNS"));
    apply.type = "button";
    apply.disabled = disabled;
    apply.onclick = () => void this.applyDns(adapter);
    actions.append(apply);
    editor.append(custom, actions);

    const hint = el(
      "div",
      "sys-hint",
      data.public
        ? tr("公网只读：DNS 改动请回本机操作。")
        : tr("点「应用 DNS」后，主机桌面会弹 UAC；点「是」才生效。只改 IPv4，IPv6 不动。"),
    );
    editor.append(hint);

    if (this.state.busyDns) {
      editor.append(el("div", "sys-busy", tr("正在等主机桌面确认…")));
    }

    const same = draft ? sameServers(draft, current) : false;
    if (same && !this.state.busyDns) {
      editor.append(el("div", "sys-hint", tr("这组已经在用了；再点应用不会重复弹 UAC。")));
    }
  }

  private async applyDns(adapter: SysAdapter): Promise<void> {
    if (this.state.busyDns) return;
    const text = this.customInput?.value ?? "";
    const draft = this.state.draft;
    let servers: string[];
    if (draft && !text.trim()) {
      servers = draft;
    } else {
      const parsed = parseDnsInput(text);
      if (!parsed.ok) {
        this.setNotice("bad", parsed.error);
        return;
      }
      servers = parsed.servers;
    }
    this.state.busyDns = true;
    this.state.notice = null;
    this.render();
    try {
      const result: DnsResult = await api.sysDnsApply(adapter.guid, servers);
      this.state.draft = null;
      this.setNotice(
        "ok",
        result.unchanged
          ? tr("DNS 已经是这组，没有改动。")
          : tr("DNS 已改为 {p1}", { p1: result.after.join(", ") }),
      );
      await this.load("network", true);
    } catch (err) {
      this.state.busyDns = false;
      this.setNotice("bad", errText(err));
    } finally {
      this.state.busyDns = false;
      this.render();
    }
  }

  private async restoreDns(adapter: SysAdapter): Promise<void> {
    if (this.state.busyDns) return;
    this.state.busyDns = true;
    this.state.notice = null;
    this.render();
    try {
      const result = await api.sysDnsRestore(adapter.guid);
      this.state.draft = null;
      this.setNotice(
        "ok",
        result.dhcp
          ? tr("DNS 已恢复为自动（DHCP）。")
          : tr("DNS 已恢复为 {p1}", { p1: result.after.join(", ") }),
      );
      await this.load("network", true);
    } catch (err) {
      this.state.busyDns = false;
      this.setNotice("bad", errText(err));
    } finally {
      this.state.busyDns = false;
      this.render();
    }
  }

  // ---------------------------------------------------------------- 端口

  private paintPorts(): void {
    const pane = this.pane!;
    const data = this.state.ports;
    if (!data) return;
    if (!data.supported) {
      pane.append(this.note(tr("这个系统只支持概况与网卡；端口列表暂不支持。")));
      return;
    }
    const toolbar = el("div", "sys-toolbar");
    const filters: { id: PortFilterId; label: string }[] = [
      { id: "all", label: tr("全部") },
      { id: "external", label: tr("对外") },
      { id: "bridge", label: tr("桥自身") },
    ];
    const segment = el("div", "sys-segment");
    for (const filter of filters) {
      const button = el("button", `sys-segment__btn${this.state.portFilter === filter.id ? " on" : ""}`, filter.label);
      button.type = "button";
      button.onclick = () => {
        this.state.portFilter = filter.id;
        this.render();
      };
      segment.append(button);
    }
    toolbar.append(segment);
    const loop = el("label", "sys-check");
    const loopInput = el("input") as HTMLInputElement;
    loopInput.type = "checkbox";
    loopInput.checked = this.state.showLoopback;
    loopInput.onchange = () => {
      this.state.showLoopback = loopInput.checked;
      this.render();
    };
    loop.append(loopInput, el("span", "", tr("显示回环")));
    toolbar.append(loop);
    toolbar.append(el("span", "sys-toolbar__meta", tr("{p1} 个对外 · {p2} 个 TCP · {p3} 个 UDP", {
      p1: data.summary.external,
      p2: data.summary.tcp,
      p3: data.summary.udp,
    })));
    pane.append(toolbar);

    const firewall = el("div", "sys-firewall");
    const labels: [keyof SysPorts["firewall"], string][] = [
      ["domain", tr("域")],
      ["private", tr("专用")],
      ["public", tr("公用")],
    ];
    for (const [key, label] of labels) {
      const value = data.firewall[key];
      const chip = el("span", `sys-firewall__chip ${value === true ? "on" : value === false ? "off" : "unknown"}`);
      chip.append(el("span", "sys-firewall__label", tr("防火墙 · {p1}", { p1: label })));
      chip.append(el("span", "sys-firewall__value", value === true ? tr("开") : value === false ? tr("关") : tr("未知")));
      firewall.append(chip);
    }
    pane.append(firewall);

    if (data.public) {
      pane.append(this.note(tr("公网只显示数量；具体端口和进程已打码。")));
      return;
    }
    const overview = this.state.overview;
    const rows = visiblePorts(data.ports, {
      showLoopback: this.state.showLoopback,
      filter: this.state.portFilter,
      bridgePid: overview?.bridge.pid ?? null,
      bridgePort: overview?.bridge.port ?? null,
    });
    if (!rows.length) {
      pane.append(el("div", "sys-empty", tr("没有匹配的端口")));
      return;
    }
    const table = el("table", "sys-table");
    const thead = el("thead");
    const headRow = el("tr");
    for (const label of [tr("协议"), tr("本地地址"), tr("端口"), tr("进程"), "PID", tr("范围")]) {
      headRow.append(el("th", "", label));
    }
    thead.append(headRow);
    const tbody = el("tbody");
    for (const port of rows) {
      const trNode = el("tr", this.isBridgePort(port) ? "is-bridge" : "");
      trNode.append(el("td", "sys-table__mono", port.proto.toUpperCase()));
      trNode.append(el("td", "sys-table__mono", port.local));
      trNode.append(el("td", "sys-table__mono", String(port.port)));
      trNode.append(el("td", "", port.process || "—"));
      trNode.append(el("td", "sys-table__mono", String(port.pid || "—")));
      trNode.append(el("td", "", this.scopeLabel(port.scope)));
      tbody.append(trNode);
    }
    table.append(thead, tbody);
    pane.append(table);
  }

  private isBridgePort(port: SysPort): boolean {
    const bridge = this.state.overview?.bridge;
    if (!bridge) return false;
    return (bridge.pid !== null && port.pid === bridge.pid) || (bridge.port !== null && port.port === bridge.port);
  }

  private scopeLabel(scope: SysPort["scope"]): string {
    if (scope === "all") return tr("所有网卡");
    if (scope === "loopback") return tr("回环");
    return tr("仅此网卡");
  }

  // ---------------------------------------------------------------- 服务

  private paintServices(): void {
    const pane = this.pane!;
    const data = this.state.services;
    if (!data) return;
    if (!data.supported) {
      pane.append(this.note(tr("这个系统只支持概况与网卡；服务列表暂不支持。")));
      return;
    }
    const toolbar = el("div", "sys-toolbar");
    const search = el("input", "sys-input sys-input--search") as HTMLInputElement;
    search.type = "search";
    search.placeholder = tr("搜索名称 / 显示名 / PID");
    search.value = this.state.serviceQuery;
    const checkMs = el("label", "sys-check");
    const msInput = el("input") as HTMLInputElement;
    msInput.type = "checkbox";
    msInput.checked = this.state.showMicrosoft;
    msInput.onchange = () => {
      this.state.showMicrosoft = msInput.checked;
      this.render();
    };
    checkMs.append(msInput, el("span", "", tr("显示 Microsoft")));
    const checkStopped = el("label", "sys-check");
    const stoppedInput = el("input") as HTMLInputElement;
    stoppedInput.type = "checkbox";
    stoppedInput.checked = this.state.showStopped;
    stoppedInput.onchange = () => {
      this.state.showStopped = stoppedInput.checked;
      this.render();
    };
    checkStopped.append(stoppedInput, el("span", "", tr("含已停止")));
    toolbar.append(search, checkMs, checkStopped);
    toolbar.append(
      el("span", "sys-toolbar__meta", tr("{p1} 个运行中 · {p2} 个非 Microsoft", {
        p1: data.summary.running,
        p2: data.summary.nonMicrosoft,
      })),
    );
    pane.append(toolbar);

    if (data.public) {
      pane.append(this.note(tr("公网只显示数量；服务名与路径已打码。")));
      return;
    }

    const table = el("table", "sys-table sys-table--services");
    const thead = el("thead");
    const headRow = el("tr");
    for (const label of [tr("服务"), tr("状态"), tr("启动"), "PID", tr("路径")]) {
      headRow.append(el("th", "", label));
    }
    thead.append(headRow);
    const tbody = el("tbody");
    table.append(thead, tbody);
    const paintRows = (): void => {
      const rows = filterServices(data.services, {
        showMicrosoft: this.state.showMicrosoft,
        showStopped: this.state.showStopped,
        query: this.state.serviceQuery,
      });
      tbody.replaceChildren();
      for (const service of rows) {
        const row = el("tr", service.state === "Running" ? "" : "is-off");
        const name = el("td");
        name.append(el("div", "sys-svc__name", service.display));
        name.append(el("div", "sys-svc__id", service.name));
        row.append(name);
        row.append(el("td", "", service.state === "Running" ? tr("运行中") : service.state || "—"));
        row.append(el("td", "", service.start || "—"));
        row.append(el("td", "sys-table__mono", String(service.pid ?? "—")));
        const path = el("td", "sys-svc__path", service.path || "—");
        path.title = service.path;
        row.append(path);
        tbody.append(row);
      }
      if (!rows.length) {
        const row = el("tr");
        const cell = el("td", "sys-empty", tr("没有匹配的服务"));
        cell.colSpan = 5;
        row.append(cell);
        tbody.append(row);
      }
    };
    search.oninput = () => {
      this.state.serviceQuery = search.value;
      paintRows();
    };
    paintRows();
    pane.append(table);
  }

  // ---------------------------------------------------------------- 上下班

  /**
   * 样张 A：左边大数字倒计时，右边四个指标，下面是工时设置、今日明细 + 记录器、近 30 天。
   * 倒计时不走 re-render —— 每秒重建整个面板会把滚动位置和输入框光标打掉，只改几个节点。
   */
  private paintWorkclock(): void {
    const pane = this.pane!;
    const data = this.state.workclock;
    if (!data) return;
    if (!data.supported) {
      pane.append(this.note(tr("这个系统没有上下班统计：解锁时间要从 Windows 的会话事件和 Security 日志里读。")));
      return;
    }
    const today = data.today;
    const now = Date.now();
    pane.append(this.sectionHead(tr("上下班"), tr("近 {p1} 天", { p1: data.days.length })));

    const grid = el("div", "sys-wk-grid");
    const hero = el("div", "sys-wk-hero");
    const caption = el("div", "sys-wk-hero__caption", this.countdownCaption(today, now));
    const digits = el("div", "sys-wk-hero__digits", today.target === null ? "--:--:--" : formatCountdown(today.target - now));
    if (today.target !== null && today.target <= now) digits.classList.add("is-overtime");
    const sub = el("div", "sys-wk-hero__sub");
    sub.append(el("span", "sys-wk-hero__kv", tr("第一次解锁 {p1}", { p1: today.firstUnlock === null ? "—" : clockText(today.firstUnlock) })));
    sub.append(el("span", "sys-wk-hero__dot", "·"));
    const worked = el("span", "sys-wk-hero__worked", formatDuration(today.firstUnlock === null ? 0 : now - today.firstUnlock));
    const workedKv = el("span", "sys-wk-hero__kv");
    workedKv.append(tr("已工作"), "\u00a0", worked);
    sub.append(workedKv);
    const bar = this.bar(today.firstUnlock === null ? 0 : workedPercent(now - today.firstUnlock, data.settings.hours), "accent");
    hero.append(caption, digits, sub, bar);

    const stats = el("div", "sys-wk-stats");
    stats.append(
      this.card(tr("上班"), today.firstUnlock === null ? "—" : clockText(today.firstUnlock), today.source ? this.sourceLabel(today.source) : tr("没有记录")),
    );
    stats.append(this.card(tr("目标下班"), today.target === null ? "—" : targetText(today.target, now), tr("每天 {p1} 小时", { p1: data.settings.hours })));
    stats.append(this.card(tr("今日解锁"), tr("{p1} 次", { p1: today.unlocks }), today.workday ? tr("工作日") : tr("休息日")));
    const met = data.days.filter((d) => d.met).length;
    const workdays = data.days.filter((d) => d.workday).length;
    stats.append(this.card(tr("达标"), `${met}/${workdays}`, tr("近 {p1} 天里的工作日", { p1: data.days.length })));
    grid.append(hero, stats);
    pane.append(grid);

    const settings = el("div", "sys-wk-panel");
    settings.append(this.sectionHead(tr("每天工时"), tr("改完立刻重算倒计时")));
    const form = el("div", "sys-wk-form");
    form.append(el("span", "sys-wk-form__label", tr("每天工时")));
    const hourInput = document.createElement("input");
    hourInput.type = "number";
    hourInput.className = "sys-wk-input";
    hourInput.min = "0.5";
    hourInput.max = "24";
    hourInput.step = "0.5";
    hourInput.value = this.state.wkHours;
    hourInput.disabled = this.state.wkBusy !== "";
    hourInput.oninput = () => {
      this.state.wkHours = hourInput.value;
    };
    form.append(hourInput, el("span", "sys-wk-form__unit", tr("小时")));
    const save = el("button", "btn ghost", this.state.wkBusy === "save" ? tr("保存中…") : tr("保存"));
    save.type = "button";
    save.disabled = this.state.wkBusy !== "";
    save.onclick = () => void this.saveWorkclock(hourInput.value);
    form.append(save);

    const weekdays = el("div", "sys-wk-days");
    weekdays.append(el("span", "sys-wk-form__label", tr("算上班的星期")));
    for (let i = 0; i < 7; i += 1) {
      const on = data.settings.workdays.includes(i);
      const chip = el("button", `sys-wk-chip${on ? " on" : ""}`, workdayName(i));
      chip.type = "button";
      chip.disabled = this.state.wkBusy !== "";
      chip.setAttribute("aria-pressed", on ? "true" : "false");
      chip.onclick = () => void this.toggleWorkday(i);
      weekdays.append(chip);
    }
    settings.append(form, weekdays);
    pane.append(settings);

    const cols = el("div", "sys-wk-cols");
    cols.append(this.todayPanel(data), this.agentPanel(data));
    pane.append(cols);
    pane.append(this.historyTable(data.days));
    pane.append(this.note(tr("上班 = 当天第一次解锁；倒计时是墙上时间，午休照走；再解锁几次不重置。")));

    this.startCountdown({ digits, caption, worked, bar });
  }

  private todayPanel(data: SysWorkclock): HTMLElement {
    const panel = el("div", "sys-wk-panel");
    const today = data.today;
    panel.append(this.sectionHead(tr("今日明细"), today.ongoing ? tr("还在工作") : tr("已收工")));
    const list = el("div", "sys-wk-events");
    if (!today.events.length) list.append(this.note(tr("今天还没有解锁记录；记录器没装的话，要靠日志回填。")));
    for (const ev of today.events) {
      const row = el("div", "sys-wk-event");
      row.append(el("span", "sys-wk-event__time", clockText(ev.t)));
      row.append(el("span", `sys-wk-event__kind sys-wk-event__kind--${ev.k}`, ev.k === "unlock" ? tr("解锁") : tr("锁屏")));
      row.append(el("span", "sys-wk-event__src", this.sourceLabel(ev.src === "start" ? "event" : ev.src)));
      list.append(row);
    }
    panel.append(list);
    return panel;
  }

  private agentPanel(data: SysWorkclock): HTMLElement {
    const panel = el("div", "sys-wk-panel");
    const agent = data.agent;
    panel.append(this.sectionHead(tr("记录器"), tr("零权限，跟着你登录")));
    const line = el("div", "sys-wk-agent");
    line.append(this.toneDot(agent.running ? "ok" : agent.installed ? "warn" : "dim"));
    line.append(el("span", "sys-wk-agent__state", agent.running ? tr("运行中") : agent.installed ? tr("已安装但没有心跳") : tr("未安装")));
    if (agent.pid !== null && agent.running) line.append(el("span", "sys-wk-agent__meta", `pid ${agent.pid}`));
    panel.append(line);
    const facts = el("div", "sys-wk-facts");
    facts.append(this.fact(tr("登录时自启"), agent.autostart ? tr("已注册") : tr("未注册")));
    facts.append(this.fact(tr("见过锁屏"), tr("{p1} 次", { p1: agent.locksSeen })));
    let lastEvent = "—";
    if (agent.lastEventAt !== null) {
      const kind = agent.lastEventKind === "lock" ? tr("锁屏") : tr("解锁");
      lastEvent = `${clockText(agent.lastEventAt)} ${kind}`;
    }
    facts.append(this.fact(tr("最后事件"), lastEvent));
    panel.append(facts);
    const coverage = data.coverage;
    panel.append(
      this.note(
        coverage.days
          ? tr("历史覆盖 {p1} 天：记录器 {p2} 天，日志回填 {p3} 天", { p1: coverage.days, p2: coverage.agentDays, p3: coverage.logDays })
          : tr("还没有历史：先装记录器，或者导入历史"),
      ),
    );
    const actions = el("div", "sys-wk-actions");
    const install = el("button", "btn", this.state.wkBusy === "install" ? tr("启动中…") : agent.installed ? tr("重新启动记录器") : tr("装上记录器"));
    install.type = "button";
    install.disabled = this.state.wkBusy !== "";
    install.onclick = () => void this.runAgent("install");
    actions.append(install);
    if (agent.installed) {
      const stop = el("button", "btn ghost", this.state.wkBusy === "uninstall" ? tr("正在移除…") : tr("停止并移除"));
      stop.type = "button";
      stop.disabled = this.state.wkBusy !== "";
      stop.onclick = () => void this.runAgent("uninstall");
      actions.append(stop);
    }
    const backfill = el("button", "btn ghost", this.state.wkBusy === "backfill" ? tr("等 UAC 点是…") : tr("导入历史（需管理员）"));
    backfill.type = "button";
    backfill.disabled = this.state.wkBusy !== "" || data.public;
    backfill.onclick = () => void this.runBackfill();
    actions.append(backfill);
    panel.append(actions);
    return panel;
  }

  private historyTable(days: WorkclockDay[]): HTMLElement {
    const panel = el("div", "sys-wk-panel");
    panel.append(this.sectionHead(tr("最近 {p1} 天", { p1: days.length })));
    const table = el("table", "sys-table sys-wk-table");
    const thead = el("thead");
    const head = el("tr");
    for (const label of [tr("日期"), tr("上班"), tr("下班"), tr("工时"), tr("来源"), tr("状态")]) {
      head.append(el("th", "", label));
    }
    thead.append(head);
    table.append(thead);
    const tbody = el("tbody");
    for (const day of days) {
      const row = el("tr", day.workday ? "" : "is-rest");
      row.append(el("td", "sys-wk-table__date", `${day.date.slice(5)} ${weekdayOf(day.date)}`));
      row.append(el("td", "sys-table__mono", day.firstUnlock === null ? "—" : clockText(day.firstUnlock)));
      row.append(el("td", "sys-table__mono", day.lastEnd === null ? "—" : clockText(day.lastEnd)));
      row.append(el("td", "sys-table__mono", day.firstUnlock === null ? "—" : formatDuration(day.workedMs)));
      const source = el("td");
      if (day.source) source.append(el("span", `sys-wk-tag sys-wk-tag--${day.source}`, this.sourceLabel(day.source)));
      else source.append(el("span", "sys-wk-tag", "—"));
      row.append(source);
      const state = el("td");
      state.append(this.dayTag(day));
      row.append(state);
      tbody.append(row);
    }
    table.append(tbody);
    panel.append(table);
    return panel;
  }

  private dayTag(day: WorkclockDay): HTMLElement {
    if (day.firstUnlock === null) return el("span", "sys-wk-tag", tr("没有记录"));
    if (day.ongoing) return el("span", "sys-wk-tag sys-wk-tag--ok", tr("进行中"));
    if (day.met) return el("span", "sys-wk-tag sys-wk-tag--ok", tr("达标"));
    if (!day.workday) return el("span", "sys-wk-tag", tr("休息日"));
    return el("span", "sys-wk-tag sys-wk-tag--warn", tr("未满"));
  }

  private sourceLabel(source: WorkclockSource): string {
    if (source === "log") return tr("日志");
    if (source === "poll") return tr("估计");
    return tr("事件");
  }

  private countdownCaption(today: WorkclockToday, now: number): string {
    if (today.firstUnlock === null) return tr("还没有今天的上班记录");
    if (today.target !== null && today.target <= now) return tr("已过下班点");
    return tr("距离下班");
  }

  /** 每秒只改四个节点（大字、标题、已工作、进度条），不重建 DOM。 */
  private startCountdown(nodes: { digits: HTMLElement; caption: HTMLElement; worked: HTMLElement; bar: HTMLElement }): void {
    this.stopCountdown();
    this.countdownNodes = nodes;
    this.updateCountdown();
    this.countdownTimer = window.setInterval(() => this.updateCountdown(), 1000);
  }

  private stopCountdown(): void {
    if (this.countdownTimer !== null) window.clearInterval(this.countdownTimer);
    this.countdownTimer = null;
    this.countdownNodes = null;
  }

  private updateCountdown(): void {
    const nodes = this.countdownNodes;
    const data = this.state.workclock;
    if (!nodes || !data) return;
    const today = data.today;
    const now = Date.now();
    const target = today.target;
    const first = today.firstUnlock;
    if (target === null || first === null) {
      nodes.digits.textContent = "--:--:--";
      nodes.caption.textContent = tr("还没有今天的上班记录");
      nodes.worked.textContent = "—";
      return;
    }
    nodes.digits.textContent = formatCountdown(target - now);
    nodes.digits.classList.toggle("is-overtime", target <= now);
    nodes.caption.textContent = target <= now ? tr("已过下班点") : tr("距离下班");
    const worked = Math.max(0, now - first);
    nodes.worked.textContent = formatDuration(worked);
    const fill = nodes.bar.firstElementChild;
    if (fill instanceof HTMLElement) fill.style.width = `${workedPercent(worked, data.settings.hours)}%`;
    if (data.settings.notify && target <= now && target > now - 60_000 && this.notifiedDate !== today.date) {
      this.notifiedDate = today.date;
      this.setNotice("ok", tr("到点了：今天的 {p1} 小时满了", { p1: data.settings.hours }));
    }
  }

  private async saveWorkclock(text: string): Promise<void> {
    if (this.state.wkBusy) return;
    const hours = parseHours(text);
    if (hours === null) {
      this.setNotice("bad", tr("工时要在 0.5–24 小时之间"));
      return;
    }
    this.state.wkBusy = "save";
    this.render();
    try {
      await api.sysWorkclockSettings({ hours });
      await this.load("workclock", true);
      this.setNotice("ok", tr("工时改成每天 {p1} 小时", { p1: hours }));
    } catch (err) {
      this.setNotice("bad", errText(err));
    } finally {
      this.state.wkBusy = "";
      this.render();
    }
  }

  private async toggleWorkday(day: number): Promise<void> {
    const data = this.state.workclock;
    if (!data || this.state.wkBusy) return;
    const current = data.settings.workdays;
    const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort((a, b) => a - b);
    if (!next.length) {
      this.setNotice("bad", tr("至少要留一天算上班"));
      return;
    }
    this.state.wkBusy = "save";
    this.render();
    try {
      await api.sysWorkclockSettings({ workdays: next });
      await this.load("workclock", true);
    } catch (err) {
      this.setNotice("bad", errText(err));
    } finally {
      this.state.wkBusy = "";
      this.render();
    }
  }

  private async runAgent(action: "install" | "uninstall"): Promise<void> {
    if (this.state.wkBusy) return;
    this.state.wkBusy = action;
    this.render();
    try {
      const res = await api.sysWorkclockAgent(action);
      if (res.ok === false) this.setNotice("bad", res.error ?? tr("记录器操作失败"));
      else this.setNotice("ok", action === "install" ? tr("记录器已启动") : tr("记录器已移除"));
      await this.load("workclock", true);
    } catch (err) {
      this.setNotice("bad", errText(err));
    } finally {
      this.state.wkBusy = "";
      this.render();
    }
  }

  private async runBackfill(): Promise<void> {
    if (this.state.wkBusy) return;
    this.state.wkBusy = "backfill";
    this.render();
    try {
      const res = await api.sysWorkclockBackfill();
      if (res.ok) this.setNotice("ok", tr("导入了 {p1} 条解锁记录", { p1: res.count ?? 0 }));
      else this.setNotice("bad", tr("导入历史失败"));
      await this.load("workclock", true);
    } catch (err) {
      this.setNotice("bad", errText(err));
    } finally {
      this.state.wkBusy = "";
      this.render();
    }
  }

  // ---------------------------------------------------------------- 小件

  private toneDot(tone: "ok" | "warn" | "dim"): HTMLElement {
    return el("span", `sys-dot sys-dot--${tone}`);
  }

  private fact(label: string, value: string): HTMLElement {
    const box = el("div", "sys-wk-fact");
    box.append(el("span", "sys-wk-fact__label", label));
    box.append(el("span", "sys-wk-fact__value", value));
    return box;
  }

  private badge(text: string, tone?: "warn"): HTMLElement {
    return el("span", `sys-badge${tone ? ` sys-badge--${tone}` : ""}`, text);
  }

  private statusDot(status: NetStatus): HTMLElement {
    return el("span", `sys-dot sys-dot--${statusTone(status)}`);
  }

  private bar(pct: number, tone: "accent" | "warn" | "danger"): HTMLElement {
    const outer = el("span", "sys-bar");
    const inner = el("span", `sys-bar__fill sys-bar__fill--${tone}`);
    inner.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    outer.append(inner);
    return outer;
  }

  private card(label: string, value: string, sub?: string, extra?: HTMLElement): HTMLElement {
    const box = el("div", "sys-card");
    box.append(el("div", "sys-card__label", label));
    box.append(el("div", "sys-card__value", value));
    if (sub) box.append(el("div", "sys-card__sub", sub));
    if (extra) box.append(extra);
    return box;
  }

  private sectionHead(label: string, meta?: string): HTMLElement {
    const head = el("div", "sys-section");
    head.append(el("span", "sys-section__label", label));
    if (meta) head.append(el("span", "sys-section__meta", meta));
    return head;
  }

  private note(text: string): HTMLElement {
    return el("div", "sys-note", text);
  }

  private skeleton(): HTMLElement {
    const box = el("div", "sys-skeleton");
    for (let i = 0; i < 3; i += 1) box.append(el("div", "sys-skeleton__row"));
    box.append(el("div", "sys-skeleton__hint", tr("正在读取本机信息…")));
    return box;
  }

  private errorBox(section: SysSection): HTMLElement {
    const box = el("div", "sys-error");
    box.append(el("div", "sys-error__text", this.state.error[section] || tr("读取失败")));
    const retry = el("button", "btn ghost", tr("重试"));
    retry.type = "button";
    retry.onclick = () => void this.load(section, true);
    box.append(retry);
    return box;
  }

  private uptimeText(seconds: number): string {
    const parts = uptimeParts(seconds);
    if (parts.days > 0) return tr("{p1} 天 {p2} 小时", { p1: parts.days, p2: parts.hours });
    if (parts.hours > 0) return tr("{p1} 小时 {p2} 分钟", { p1: parts.hours, p2: parts.minutes });
    return tr("{p1} 分钟", { p1: parts.minutes });
  }

  private prefixOf(adapter: SysAdapter): string {
    const mask = adapter.mask[0];
    if (!mask) return "—";
    let bits = 0;
    for (const part of mask.split(".")) {
      let value = Number(part);
      while (value > 0) {
        bits += value & 1;
        value >>= 1;
      }
    }
    return String(bits);
  }

  private setNotice(kind: "ok" | "bad", text: string): void {
    this.state.notice = { kind, text };
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      this.state.notice = null;
      this.paintBanners();
    }, 8000);
    this.paintBanners();
  }
}
