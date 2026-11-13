/** #266：桥端 `/api/sys*` 的响应形状（与 bridge/src/sysmanage.ts 对齐）。 */
export type SysSection = "overview" | "network" | "ports" | "services" | "workclock";
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
  /** WinNAT 服务状态；非 Windows 或读不到时为 null。 */
  winnat: WinnatInfo | null;
  updatedAt: number;
}

export interface WinnatInfo {
  status: string;
  start: string;
}

export interface WinnatResult {
  ok: true;
  /** 重启前是否在跑；false 表示这次只是把它启动起来。 */
  wasRunning: boolean;
  /** 被连带停掉、事后没拉起来的依赖服务名。 */
  depsFailed: string[];
  winnat: WinnatInfo;
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

/** 上下班模块：哪天第一次解锁算上班、每天目标工时、下班倒计时。 */
export type WorkclockSource = "event" | "poll" | "log";

export interface WorkclockEvent {
  t: number;
  k: "unlock" | "lock";
  src: "event" | "start" | "poll" | "log";
}

export interface WorkclockSettings {
  hours: number;
  workdays: number[];
  notify: boolean;
  updatedAt: number;
}

export interface WorkclockDay {
  /** 本地日期 YYYY-MM-DD。 */
  date: string;
  firstUnlock: number | null;
  lastEnd: number | null;
  workedMs: number;
  source: WorkclockSource | null;
  workday: boolean;
  met: boolean;
  unlocks: number;
  ongoing: boolean;
}

export interface WorkclockToday extends WorkclockDay {
  target: number | null;
  remainingMs: number | null;
  events: WorkclockEvent[];
}

export interface WorkclockAgent {
  installed: boolean;
  running: boolean;
  autostart: boolean;
  pid: number | null;
  startedAt: number | null;
  lastEventAt: number | null;
  lastEventKind: string;
  lastLockSeen: number | null;
  locksSeen: number;
  heartbeatAt: number | null;
  scriptPath: string;
  taskName: string;
  taskState: string;
  error: string | null;
}

export interface WorkclockCoverage {
  days: number;
  agentDays: number;
  logDays: number;
  from: number | null;
  to: number | null;
}

export interface SysWorkclock {
  public: boolean;
  platform: string;
  supported: boolean;
  settings: WorkclockSettings;
  today: WorkclockToday;
  days: WorkclockDay[];
  agent: WorkclockAgent;
  coverage: WorkclockCoverage;
  updatedAt: number;
}

export interface WorkclockAgentResult {
  ok?: boolean;
  error?: string;
  code?: string;
  agent: WorkclockAgent;
}

export interface WorkclockBackfill {
  ok: boolean;
  count?: number;
  from?: number | null;
  to?: number | null;
  state?: SysWorkclock;
}
