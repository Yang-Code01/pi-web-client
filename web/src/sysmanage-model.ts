/** #266：本机管理面板的纯函数——预设、解析、过滤、格式化。DOM 不在这里，方便单测。 */
import { tr } from "./i18n/index.ts";
import type { NetStatus, SysPort, SysService } from "./sysmanage-types.ts";

export interface DnsPreset {
  id: string;
  label: string;
  servers: string[];
}

/** 公司 DNS 放第一位：这台机器默认就在公司域里，切错了最常用的那个要先够得着。 */
export const DNS_PRESETS: DnsPreset[] = [
  { id: "corp", label: "公司", servers: ["172.28.1.23"] },
  { id: "ali", label: "阿里", servers: ["223.5.5.5"] },
  { id: "tencent", label: "腾讯", servers: ["119.29.29.29"] },
  { id: "114", label: "114", servers: ["114.114.114.114"] },
  { id: "google", label: "Google", servers: ["8.8.8.8"] },
  { id: "cloudflare", label: "Cloudflare", servers: ["1.1.1.1"] },
];

const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export function isIpv4(text: string): boolean {
  return IPV4.test(text.trim());
}

export function sameServers(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** 当前 DNS 对应哪个预设；对不上就是 custom。空列表 = DHCP，单独返回 dhcp。 */
export function presetOf(servers: string[]): string {
  if (!servers.length) return "dhcp";
  const hit = DNS_PRESETS.find((p) => sameServers(p.servers, servers));
  return hit ? hit.id : "custom";
}

/** 输入框里的逗号/空格/分号都当分隔符；最多 3 个，去重。 */
export function parseDnsInput(text: string): { ok: true; servers: string[] } | { ok: false; error: string } {
  const parts = text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return { ok: false, error: tr("至少填一个 IPv4 地址") };
  const servers: string[] = [];
  for (const part of parts) {
    if (!isIpv4(part)) return { ok: false, error: tr("不是 IPv4 地址：{p1}", { p1: part }) };
    if (!servers.includes(part)) servers.push(part);
  }
  if (servers.length > 3) return { ok: false, error: tr("最多 3 个 DNS 地址") };
  return { ok: true, servers };
}

export function statusTone(status: NetStatus): "ok" | "warn" | "dim" {
  if (status === "up") return "ok";
  if (status === "disconnected") return "warn";
  return "dim";
}

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 GB";
  const value = bytes / 1024 ** 3;
  if (value >= 100) return `${value.toFixed(0)} GB`;
  return `${value.toFixed(digits)} GB`;
}

export interface UptimeParts {
  days: number;
  hours: number;
  minutes: number;
}

export function uptimeParts(seconds: number): UptimeParts {
  const total = Math.max(0, Math.floor(seconds));
  return {
    days: Math.floor(total / 86_400),
    hours: Math.floor((total % 86_400) / 3_600),
    minutes: Math.floor((total % 3_600) / 60),
  };
}

export interface PortFilter {
  showLoopback: boolean;
  filter: "all" | "external" | "bridge";
  bridgePid: number | null;
  bridgePort: number | null;
}

export function visiblePorts(ports: SysPort[], opts: PortFilter): SysPort[] {
  return ports.filter((p) => {
    if (opts.filter === "bridge") {
      return (opts.bridgePid !== null && p.pid === opts.bridgePid) || (opts.bridgePort !== null && p.port === opts.bridgePort);
    }
    if (!opts.showLoopback && p.scope === "loopback") return false;
    if (opts.filter === "external") return p.scope !== "loopback";
    return true;
  });
}

export interface ServiceFilter {
  showMicrosoft: boolean;
  showStopped: boolean;
  query: string;
}

export function filterServices(services: SysService[], opts: ServiceFilter): SysService[] {
  const q = opts.query.trim().toLowerCase();
  return services.filter((s) => {
    if (!opts.showMicrosoft && s.microsoft) return false;
    if (!opts.showStopped && s.state !== "Running") return false;
    if (!q) return true;
    return (
      s.name.toLowerCase().includes(q) ||
      s.display.toLowerCase().includes(q) ||
      String(s.pid ?? "").includes(q)
    );
  });
}

/** Windows 服务状态 / 启动类型（PowerShell 枚举名）→ 界面文案；认不出就原样显示。 */
const SERVICE_STATUS_LABELS: Record<string, string> = {
  Running: "运行中",
  Stopped: "已停止",
  StartPending: "正在启动",
  StopPending: "正在停止",
  Paused: "已暂停",
};

const SERVICE_START_LABELS: Record<string, string> = {
  Automatic: "自动",
  Manual: "手动",
  Disabled: "禁用",
};

export function serviceStatusLabel(status: string): string {
  const label = SERVICE_STATUS_LABELS[status];
  return label ? tr(label) : status;
}

export function serviceStartLabel(start: string): string {
  const label = SERVICE_START_LABELS[start];
  return label ? tr(label) : start;
}
