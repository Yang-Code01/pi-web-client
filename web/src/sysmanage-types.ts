/** #266：桥端 `/api/sys*` 的响应形状（与 bridge/src/sysmanage.ts 对齐）。 */
export type SysSection = "overview" | "network" | "ports" | "services" | "workclock" | "attendance";
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
  /** 下班时刻是按「当天最后一次解锁」推的（没有锁屏事件），工时只会偏小。 */
  endInferred: boolean;
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
  /** 注册表值名（测试实例带状态目录哈希后缀）。 */
  autostartName: string;
  /** 已注册的自启命令行；没注册时为空串。 */
  autostartCommand: string;
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

// ---------------------------------------------------------------- 考勤（本机管理第六页）

/** `GET /api/attendance/state`。账号、工号都已经是掩码；这份摘要里没有密码 / token。 */
export interface AttendanceState {
  configured: boolean;
  problem: string | null;
  apiBase: string;
  pageBase: string;
  /** 掩码后的账号，例如 `JS***6`。 */
  account: string;
  /** 有 token 能用，或存着密码（过期时桥会自动重登）—— 两种情况都算已登录。 */
  loggedIn: boolean;
  /** 本机存着密码，可以自动续登录态。 */
  hasPassword: boolean;
  expiresAt: number;
  userName: string;
  workNoMask: string;
  cacheDays: number;
  cacheFetchedAt: number;
  maxDay: string;
}

/** 一天的记录。`raw` 是 OA 原样那一行 —— 语义没坐实的字段只在详情里展开，不猜。 */
export interface AttendanceRowView {
  date: string;
  weekday: string;
  weekend: boolean;
  clockIn: string | null;
  clockOut: string | null;
  overtime: number;
  overtimeEdited: boolean;
  editedBy: string;
  raw: Record<string, unknown>;
}

export interface AttendanceRange {
  start: string;
  end: string;
  clamped: boolean;
  problem: string | null;
}

export interface AttendanceSummary {
  days: number;
  attended: number;
  missing: number;
  overtime: number;
  weekendOvertime: number;
  lastDay: string;
}

export interface AttendanceRecords {
  rows: AttendanceRowView[];
  summary: AttendanceSummary;
  range: AttendanceRange;
  source: "live" | "cache";
  fetchedAt: number;
  stale: boolean;
  problem: string | null;
}

export interface AttendanceLeader {
  userId: number;
  name: string;
  workNo: string;
}

export interface AttendanceApply {
  code: number;
  user_id: number;
  name: string;
  agent_user_id: number;
  agent_name: string;
  start_time: string;
  end_time: string;
  hours: number;
  reason: string;
  reasonParsed?: { type: string; project: string; detail: string };
  /** 0 = 还在审批里。 */
  workflow_result: number;
  expense: number;
  reject_reason: string | null;
}

export interface AttendanceOvertime {
  applyList: AttendanceApply[];
  /** 以申请单号为键的审批链。 */
  workflow: Record<string, unknown>;
  reasons: string[];
  admitTime: string;
  rule: string;
  candidates: { l1: AttendanceLeader[]; l2: AttendanceLeader[] };
  /** 二级审批人：OA 按组织架构给的固定名单，页面上只读。 */
  fixedL2: AttendanceLeader[];
  /** 一级审批人的默认值（上一次申请的那个人），可以改。 */
  defaultL1: AttendanceLeader[];
  userId: number;
}

export interface AttendanceSubmitResult {
  needConfirm?: boolean;
  preview?: Record<string, unknown>;
  ok?: boolean;
}

export interface AttendanceCancelResult {
  needConfirm?: boolean;
  ok?: boolean;
}

/** 加班申请提醒：规则 + 上一次实际发送的情况。 */
export interface AttendanceReminderRule {
  enabled: boolean;
  /** ISO 星期：1 = 周一 … 7 = 周日。 */
  days: number[];
  /** "HH:MM" */
  time: string;
  text: string;
}

export interface AttendanceReminder {
  rule: AttendanceReminderRule;
  /** 最近一次真的发出去的那天；空串表示还没发过。 */
  lastFiredDate: string;
  lastFiredAt: string;
  /** 上次推到几台设备（0 = 没有任何订阅，通知其实没到人手里）。 */
  lastSent: number;
  pushEnabled: boolean;
  pushSubscriptions: number;
}
