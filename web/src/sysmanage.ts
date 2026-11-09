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
  filterServices,
  formatBytes,
  parseDnsInput,
  presetOf,
  sameServers,
  statusTone,
  uptimeParts,
  visiblePorts,
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
  notice: Notice | null;
}

const EMPTY_LOADING: Record<SysSection, boolean> = {
  overview: false,
  network: false,
  ports: false,
  services: false,
};

const EMPTY_ERROR: Record<SysSection, string> = {
  overview: "",
  network: "",
  ports: "",
  services: "",
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
    notice: null,
  };
  private root: HTMLElement | null = null;
  private headerSub = "";
  private badges: HTMLElement | null = null;
  private banner: HTMLElement | null = null;
  private nav: HTMLElement | null = null;
  private pane: HTMLElement | null = null;
  private customInput: HTMLInputElement | null = null;
  private noticeTimer: number | null = null;
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
      el("span", "sys-foot__hint", tr("DNS 改动会在主机桌面弹 UAC，点「是」才生效。")),
      el("span", "sys-foot__meta", "pi-web-client"),
    );

    consoleNode.append(head, this.banner, body, foot);
    root.append(consoleNode);
    this.root = root;
  }

  // ---------------------------------------------------------------- 数据

  private data(section: SysSection): SysOverview | SysNetwork | SysPorts | SysServices | null {
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
      let value: SysOverview | SysNetwork | SysPorts | SysServices;
      if (section === "overview") value = await api.sysOverview();
      else if (section === "network") value = await api.sysNetwork();
      else if (section === "ports") value = await api.sysPorts();
      else value = await api.sysServices();
      this.state[section] = value as never;
      if (section === "network") this.ensureSelection();
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
    };
    const labels: Record<SysSection, string> = {
      overview: tr("概况"),
      network: tr("网络与 DNS"),
      ports: tr("端口与服务"),
      services: tr("服务"),
    };
    this.nav.replaceChildren();
    (["overview", "network", "ports", "services"] as SysSection[]).forEach((section) => {
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
    } else {
      this.paintServices();
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
    layout.append(list, editor);
    pane.append(layout);
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
    const disabled = this.state.busyDns || data.public || !data.supported;

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

  // ---------------------------------------------------------------- 小件

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
