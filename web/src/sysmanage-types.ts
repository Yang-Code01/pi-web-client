/** #266：桥端 `/api/sys*` 的响应形状（与 bridge/src/sysmanage.ts 对齐）。 */
export type SysSection = "overview" | "network" | "ports" | "services";
export type NetStatus = "up" | "disconnected" | "not_present" | "unknown";
export type PortScope = "all" | "nic" | "loopback";

export interface SysOverview {
  public: boolean;
  platform: string;
  supported: boolean;
  hostname: string;
  os: { name: string; version: string; build: string; arch: string; uptime: number };
  cpu: { model: string; threads: number };
  memory: { total: number; free: number };
  disks: { root: string; total: number; free: number }[];
  bridge: { version: string; pid: number | null; port: number | null; node: string };
  updatedAt: number;
}

export interface SysAdapter {
  guid: string;
  name: string;
  description: string;
  index: number;
  status: NetStatus;
  mac: string;
  ipv4: string[];
  mask: string[];
  gateway: string[];
  dns: string[];
  dhcp: boolean;
  default: boolean;
}

export interface DnsSaved {
  guid: string;
  name: string;
  before: string[];
  dhcp: boolean;
  after: string[];
  at: number;
}

export interface SysNetwork {
  public: boolean;
  platform: string;
  supported: boolean;
  adapters: SysAdapter[];
  saved: DnsSaved[];
  updatedAt: number;
}

export interface SysPort {
  proto: "tcp" | "udp";
  local: string;
  port: number;
  pid: number;
  process: string;
  scope: PortScope;
}

export interface SysPorts {
  public: boolean;
  platform: string;
  supported: boolean;
  ports: SysPort[];
  firewall: { domain: boolean | null; private: boolean | null; public: boolean | null };
  summary: { total: number; external: number; tcp: number; udp: number };
  updatedAt: number;
}

export interface SysService {
  name: string;
  display: string;
  state: string;
  start: string;
  pid: number | null;
  path: string;
  microsoft: boolean;
}

export interface SysServices {
  public: boolean;
  platform: string;
  supported: boolean;
  services: SysService[];
  summary: { total: number; running: number; nonMicrosoft: number };
  updatedAt: number;
}

export interface DnsResult {
  ok: true;
  unchanged?: boolean;
  before: string[];
  after: string[];
  saved: DnsSaved | null;
  dhcp: boolean;
}
