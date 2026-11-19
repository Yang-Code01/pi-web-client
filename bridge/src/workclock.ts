/**
 * 上下班（本机管理第 5 个分区）：每天第一次解锁屏幕的时间 + 下班倒计时。
 *
 * 三条数据来源，页面上分别标出来源，不混为一谈：
 * - `event`：常驻记录器在解锁的那一刻收到系统会话事件（`WM_WTSSESSION_CHANGE`）。最准，零权限。
 * - `poll`：记录器漏了事件时，用「锁屏界面消失 + 最后一次输入」补的近似值。
 * - `log`：点「导入历史」时，提权读 Security 日志回填出来的：解锁取 4624 的 LogonType
 *   （7 = 解锁、2 = 开机后登录…），锁屏仍只有 4800/4801。见 D288。
 *
 * 数据落在状态目录 `workclock/` 下：
 * - `settings.json`   桥写：每天工时（默认 9）、算上班的星期（默认周一到周五）、到点提醒开关。
 * - `agent.jsonl`     记录器写：`{"t":毫秒,"k":"unlock"|"lock","src":"event"|"start"|"poll"}`，追加。
 * - `agent-status.json` 记录器写的心跳：pid、启动时刻、最后事件、见过几次锁屏。
 * - `log-events.json` 桥写：提权回填出来的 `{"t","k"}`，封顶 90 天。
 * - `workclock-agent.ps1` 桥写 + 校验 hash，记录器本体。
 *
 * 口径（DECISIONS 里记了理由）：
 * - 当天第一次解锁 = 上班；下班时刻 = 上班 + 每天工时，走的是墙上时间，午休照走。
 * - 一天之内再解锁几次不重置倒计时，只进「今日明细」。
 * - 以自然日切分；跨午夜的加班算在开工那天（次日 00:00 之后的部分不算工时）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { readJsonChecked, stateDir, statePath, writeJson } from "./paths.ts";
import { psQuote, runElevated, runPowerShell } from "./ps.ts";

/** 页面上的历史窗口。 */
export const WORKCLOCK_DAYS = 30;
/** 「导入历史」最多回填多少天。Security 日志的保留期通常比这短。 */
export const MAX_LOG_DAYS = 90;
/** 记录器心跳超过这么久没动静就算没在跑。 */
const HEARTBEAT_STALE_MS = 90_000;

/**
 * 自启项落在 HKCU 的 Run 里，不是计划任务（D286）：`Register-ScheduledTask` 在这台标准用户机器上
 * 一律 `Access is denied`（未提权的桥进程注册每用户任务也要管理员），Run 项标准用户可写、登录即起。
 */
const AUTOSTART_KEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const AUTOSTART_NAME = "pi-web-client-workclock";
const AGENT_SCRIPT = "workclock-agent.ps1";
const DEFAULT_HOURS = 9;
const DEFAULT_WORKDAYS = [1, 2, 3, 4, 5];

export type WorkclockSource = "event" | "poll" | "log";
export type WorkclockKind = "unlock" | "lock";

/**
 * Security 日志里要读的事件：4624（登录/解锁，默认就审计）+ 4800/4801（锁屏，默认不审计）。
 * 解锁的主力是 4624 —— 4800/4801 属于「Other Logon/Logoff Events」，默认关闭（D288）。
 */
const SECURITY_IDS = [4624, 4800, 4801];

/**
 * 4624 的 LogonType 里哪些算「到岗」：只列交互式登录。
 * 3（网络）/4（批处理）/5（服务）**必须排除** —— 否则每个文件共享访问都会造出一条假解锁。
 * 含义写在这张表里，生成 PS 的 `$unlockTypes` 也从它来，别在两处各抄一份数字。
 */
const LOGON_TYPE_MEANING = {
  2: "开机后登录",
  7: "解锁",
  10: "RDP 连进来",
  11: "缓存凭据登录",
  12: "缓存远程交互",
  13: "缓存解锁",
} as const;

export const LOGON_UNLOCK_TYPES: number[] = Object.keys(LOGON_TYPE_MEANING)
  .map(Number)
  .sort((a, b) => a - b);

export interface WorkclockEvent {
  /** 毫秒时间戳（本地时区语义由 `localDateKey` 决定）。 */
  t: number;
  k: WorkclockKind;
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
  /** 下班时刻没有锁屏事件可依，是按「当天最后一次解锁」推出来的：工时只会偏小，页面上要标出来。 */
  endInferred: boolean;
}

export interface WorkclockToday extends WorkclockDay {
  target: number | null;
  remainingMs: number | null;
  events: WorkclockEvent[];
}

export interface WorkclockAgent {
  /** 自启项已注册、或者进程正在跑 —— 页面据此决定显示「装上」还是「重新启动」。 */
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
  /** 注册表值名（测试实例带状态目录哈希后缀，不碰真实自启项）。 */
  autostartName: string;
  /** 已注册的命令行；没注册时为空串，排障时能直接看出 `-Dir` 指到哪。 */
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

export interface WorkclockState {
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

// ---------------------------------------------------------------- 文件位置

function dir(): string {
  return statePath("workclock");
}

function settingsFile(): string {
  return path.join(dir(), "settings.json");
}

function agentEventsFile(): string {
  return path.join(dir(), "agent.jsonl");
}

function agentStatusFile(): string {
  return path.join(dir(), "agent-status.json");
}

function logEventsFile(): string {
  return path.join(dir(), "log-events.json");
}

function agentScriptFile(): string {
  return path.join(dir(), AGENT_SCRIPT);
}

// ---------------------------------------------------------------- 纯计算（有单测）

/** 本地日期键。用本地分量而不是 `toISOString`，否则东八区凌晨会归到前一天。 */
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayStartMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 逐行读 `agent.jsonl`：坏行跳过，不看时间顺序也没有关系（后面统一排序）。 */
export function parseEventLines(text: string): WorkclockEvent[] {
  const out: WorkclockEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const rec = value as Record<string, unknown>;
    const t = typeof rec.t === "number" ? rec.t : NaN;
    const k = rec.k === "unlock" || rec.k === "lock" ? rec.k : null;
    const src = rec.src === "event" || rec.src === "start" || rec.src === "poll" || rec.src === "log" ? rec.src : "event";
    if (!Number.isFinite(t) || t <= 0 || !k) continue;
    out.push({ t, k, src });
  }
  return out;
}

/** `log-events.json` 是桥自己写的，形状固定；照样容错。 */
export function parseLogEvents(value: unknown): WorkclockEvent[] {
  if (!Array.isArray(value)) return [];
  const out: WorkclockEvent[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const t = typeof rec.t === "number" ? rec.t : NaN;
    const k = rec.k === "unlock" || rec.k === "lock" ? rec.k : null;
    if (!Number.isFinite(t) || t <= 0 || !k) continue;
    out.push({ t, k, src: "log" });
  }
  return out;
}

/** 同一来源里 5 秒内的同种事件去重（记录器启动时可能既报 start 又报 logon）。 */
export function dedupeEvents(events: WorkclockEvent[]): WorkclockEvent[] {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const out: WorkclockEvent[] = [];
  for (const ev of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.k === ev.k && ev.t - prev.t < 5_000) continue;
    out.push(ev);
  }
  return out;
}

function byDay(events: WorkclockEvent[]): Map<string, WorkclockEvent[]> {
  const map = new Map<string, WorkclockEvent[]>();
  for (const ev of events) {
    const key = localDateKey(ev.t);
    const list = map.get(key) ?? [];
    list.push(ev);
    map.set(key, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.t - b.t);
  return map;
}

/**
 * 某一天的上班时刻：真实解锁（事件 / 轮询估计 / 日志回填）里最早的那一条，来源就标它自己的；
 * 记录器启动时刻（`start`）只在一条真实解锁都没有时兜底。
 * 不按来源排先后（D334 取代 D246 第 4 条）：记录器中途才装上时，它看到的第一次解锁会比日志里的晚，
 * 按来源排就会把日志回填出来的真 09:29 压成 11:23。`start` 仍最弱，15:00 装的记录器不顶掉 09:00。
 */
function pickFirstUnlock(list: WorkclockEvent[]): { t: number; src: WorkclockSource } | null {
  const real = list.find((ev) => ev.k === "unlock" && ev.src !== "start");
  if (real) return { t: real.t, src: real.src === "poll" ? "poll" : real.src === "log" ? "log" : "event" };
  const started = list.filter((ev) => ev.k === "unlock");
  if (started.length) return { t: started[0].t, src: "event" };
  return null;
}

/** 汇总最近 `days` 天（含今天）。返回按日期倒序，未开工的日期也占一行（`firstUnlock === null`）。 */
export function summarizeDays(
  events: WorkclockEvent[],
  settings: WorkclockSettings,
  now: number,
  days = WORKCLOCK_DAYS,
): WorkclockDay[] {
  const merged = dedupeEvents(events).filter((ev) => ev.t <= now + 60_000);
  const map = byDay(merged);
  const out: WorkclockDay[] = [];
  const todayStart = dayStartMs(now);
  for (let i = 0; i < days; i += 1) {
    const start = new Date(todayStart);
    start.setDate(start.getDate() - i);
    const date = localDateKey(start.getTime());
    const list = map.get(date) ?? [];
    const first = pickFirstUnlock(list);
    const isToday = i === 0;
    const lastEvent = list[list.length - 1];
    let lastEnd: number | null = null;
    let endInferred = false;
    if (first) {
      const locks = list.filter((ev) => ev.k === "lock" && ev.t >= first.t);
      if (isToday && lastEvent && lastEvent.k === "unlock") lastEnd = now;
      else if (locks.length) lastEnd = locks[locks.length - 1].t;
      else if (list.length) {
        // 只有解锁、没有锁屏（日志回填在没开审核策略的机器上拿不到 4800/4801）：下班就是「当天最后一次
        // 解锁」，工时只会偏小。标 endInferred，页面据此写「推算」，别让人拿它当准数（D288）。
        lastEnd = list[list.length - 1].t;
        endInferred = true;
      }
    }
    const workedMs = first && lastEnd ? Math.max(0, lastEnd - first.t) : 0;
    const workday = settings.workdays.includes(new Date(start.getTime()).getDay());
    out.push({
      date,
      firstUnlock: first ? first.t : null,
      lastEnd,
      workedMs,
      source: first ? first.src : null,
      workday,
      met: workday && workedMs >= settings.hours * 3_600_000,
      unlocks: list.filter((ev) => ev.k === "unlock").length,
      ongoing: isToday && Boolean(first) && lastEvent?.k === "unlock",
      endInferred,
    });
  }
  return out;
}

/** 今天的卡片：上班时刻、目标下班时刻、剩余（负数是加班）。 */
export function summarizeToday(
  days: WorkclockDay[],
  events: WorkclockEvent[],
  settings: WorkclockSettings,
  now: number,
): WorkclockToday {
  const base = days[0];
  const date = base.date;
  let target: number | null = null;
  let remainingMs: number | null = null;
  if (base.firstUnlock !== null) target = base.firstUnlock + settings.hours * 3_600_000;
  if (target !== null) remainingMs = target - now;
  return {
    ...base,
    target,
    remainingMs,
    events: dedupeEvents(events)
      .filter((ev) => localDateKey(ev.t) === date)
      .sort((a, b) => a.t - b.t),
  };
}

export function summarizeCoverage(days: WorkclockDay[]): WorkclockCoverage {
  let agentDays = 0;
  let logDays = 0;
  let from: number | null = null;
  let to: number | null = null;
  for (const day of days) {
    if (!day.firstUnlock) continue;
    if (day.source === "log") logDays += 1;
    else agentDays += 1;
    if (from === null || day.firstUnlock < from) from = day.firstUnlock;
    if (to === null || day.firstUnlock > to) to = day.firstUnlock;
  }
  return { days: agentDays + logDays, agentDays, logDays, from, to };
}

export function normalizeSettings(value: unknown): WorkclockSettings {
  const rec = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawHours = typeof rec.hours === "number" && Number.isFinite(rec.hours) ? rec.hours : DEFAULT_HOURS;
  const hours = Math.min(24, Math.max(0.5, Math.round(rawHours * 2) / 2));
  const rawDays = Array.isArray(rec.workdays) ? rec.workdays : DEFAULT_WORKDAYS;
  const workdays = [...new Set(rawDays.filter((d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6))].sort(
    (a, b) => a - b,
  );
  return {
    hours,
    workdays: workdays.length ? workdays : [...DEFAULT_WORKDAYS],
    notify: rec.notify !== false,
    updatedAt: typeof rec.updatedAt === "number" ? rec.updatedAt : 0,
  };
}

// ---------------------------------------------------------------- 读数据

function readSettings(): WorkclockSettings {
  return normalizeSettings(readJsonChecked(settingsFile(), null).value);
}

function readAgentEvents(): WorkclockEvent[] {
  try {
    return parseEventLines(fs.readFileSync(agentEventsFile(), "utf8"));
  } catch {
    return [];
  }
}

function readLogEvents(): WorkclockEvent[] {
  return parseLogEvents(readJsonChecked<unknown>(logEventsFile(), []).value);
}

interface AgentStatus {
  pid?: number;
  startedAt?: number;
  updatedAt?: number;
  lastEventAt?: number;
  lastEventKind?: string;
  locksSeen?: number;
  lastLockSeen?: number;
}

interface AutostartInfo {
  exists: boolean;
  /** 注册的命令行；没注册时为空串。 */
  command: string;
}

interface RegResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 直接跑 `reg.exe`：比开机 PowerShell 快一个数量级，而且参数据精确传递（不经过命令行拼接）。 */
function runReg(args: string[], timeoutMs = 10_000): Promise<RegResult> {
  return new Promise((resolve) => {
    const child = spawn("reg.exe", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (result: RegResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ code: -1, stdout, stderr: `${stderr}超时` });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err: Error) => finish({ code: -1, stdout, stderr: err.message }));
    child.on("close", (code: number | null) => finish({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * 自启项的值名。默认就一个；测试实例（`PI_WEB_STATE` 改了状态目录）按目录哈希后缩——
 * 否则隔离实例一装就把用户真实的自启项覆盖成指向测试目录。
 */
export function autostartValueName(env: NodeJS.ProcessEnv = process.env, state: string = stateDir()): string {
  if (!env.PI_WEB_STATE) return AUTOSTART_NAME;
  // 取哈希的低位：djb2 末尾字符的差异只落在低位上，拿前 6 位会让 wk-a / wk-b 撞名。
  return `${AUTOSTART_NAME}-${agentHash(state).padStart(6, "0").slice(-6)}`;
}

/**
 * 解析 `reg query <key> /v <name>` 的输出（`    Name    REG_SZ    data`），没有这一项就 null。
 * 纯函数，单测直接喂文本。
 */
export function parseRegQueryValue(stdout: string, name: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    // reg.exe 把值名补到列宽，短名字后面是一串空格，所以中间不能要求正好四个：
    // 名字与类型至少隔两个空白，类型与内容至少隔两个（内容里的空白原样保留）。
    const match = /^\s+(.+?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/.exec(line);
    if (!match || match[1].trim() !== name) continue;
    return match[3].replace(/\s+$/, "");
  }
  return null;
}

async function readAutostart(): Promise<AutostartInfo> {
  if (process.platform !== "win32") return { exists: false, command: "" };
  const name = autostartValueName();
  const result = await runReg(["query", `HKCU\\${AUTOSTART_KEY}`, "/v", name]);
  const command = parseRegQueryValue(result.stdout, name);
  return { exists: command !== null, command: command ?? "" };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程在、只是不是我们能发的；ESRCH 才是真没了。
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readStatus(): AgentStatus | null {
  const parsed = readJsonChecked<unknown>(agentStatusFile(), null).value;
  return parsed && typeof parsed === "object" ? (parsed as AgentStatus) : null;
}

/**
 * 心跳新鲜 + 进程真在 —— 两个都成立才算在跑。刚死的进程在 90 秒内还留着新鲜心跳，只看时间会骗人。
 *
 * `readAgent`（页面要不要说运行中）与 `installAgent`（要不要再起一份）共用这一个判定：两边各写一份，
 * 早晚会漂成「装的时候觉得在跑、页面觉得是死的」。
 */
function statusRunning(status: AgentStatus | null, now: number): boolean {
  if (typeof status?.updatedAt !== "number" || now - status.updatedAt >= HEARTBEAT_STALE_MS) return false;
  const pid = typeof status.pid === "number" ? status.pid : null;
  return pid === null || pidAlive(pid);
}

async function readAgent(now: number): Promise<WorkclockAgent> {
  const scriptPath = agentScriptFile();
  const status = readStatus();
  const heartbeatAt = typeof status?.updatedAt === "number" ? status.updatedAt : null;
  const pid = typeof status?.pid === "number" ? status.pid : null;
  // 心跳新鲜还得进程真在 —— 判定只有一份，见 statusRunning。
  const running = statusRunning(status, now);
  const autostart = await readAutostart();
  return {
    installed: autostart.exists || running,
    running,
    autostart: autostart.exists,
    pid,
    startedAt: typeof status?.startedAt === "number" ? status.startedAt : null,
    lastEventAt: typeof status?.lastEventAt === "number" ? status.lastEventAt : null,
    lastEventKind: typeof status?.lastEventKind === "string" ? status.lastEventKind : "",
    lastLockSeen: typeof status?.lastLockSeen === "number" ? status.lastLockSeen : null,
    locksSeen: typeof status?.locksSeen === "number" ? status.locksSeen : 0,
    heartbeatAt,
    scriptPath,
    autostartName: autostartValueName(),
    autostartCommand: autostart.command,
    error: fs.existsSync(scriptPath) || autostart.exists ? null : "记录器还没装上",
  };
}

export async function readWorkclock(publicReq: boolean, now = Date.now()): Promise<WorkclockState> {
  const supported = process.platform === "win32";
  const settings = readSettings();
  const events = dedupeEvents([...readAgentEvents(), ...readLogEvents()]);
  const days = summarizeDays(events, settings, now);
  return {
    public: publicReq,
    platform: process.platform,
    supported,
    settings,
    today: summarizeToday(days, events, settings, now),
    days,
    agent: supported ? await readAgent(now) : emptyAgent(),
    coverage: summarizeCoverage(days),
    updatedAt: now,
  };
}

function emptyAgent(): WorkclockAgent {
  return {
    installed: false,
    running: false,
    autostart: false,
    pid: null,
    startedAt: null,
    lastEventAt: null,
    lastEventKind: "",
    lastLockSeen: null,
    locksSeen: 0,
    heartbeatAt: null,
    scriptPath: agentScriptFile(),
    autostartName: autostartValueName(),
    autostartCommand: "",
    error: "这个系统没有记录器（只支持 Windows）",
  };
}

// ---------------------------------------------------------------- 记录器脚本

/**
 * 记录器本体。两条通道：
 * - `SystemEvents.SessionSwitch`（WTS 会话变更）在解锁的那一刻投消息，脚本只把原因塞进并发队列，
 *   由主循环落盘 —— 事件回调跑在别的线程上，不能直接碰 PowerShell 变量。
 * - 15 秒一轮的兜底：`LogonUI.exe` 在 = 锁屏；它消失且刚才没收到解锁事件 = 补一条 `poll`。
 *
 * 心跳每 15 秒写一次 `agent-status.json`，桥据此判断「在跑」；`locksSeen` 用来验证事件通道真的通。
 */
const AGENT_SCRIPT_BODY = String.raw`param([string]$Dir)
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
if (-not (Test-Path $Dir)) { New-Item -ItemType Directory -Force -Path $Dir | Out-Null }
$eventsPath = Join-Path $Dir 'agent.jsonl'
$statusPath = Join-Path $Dir 'agent-status.json'
$script:utf8 = New-Object Text.UTF8Encoding($false)
$script:queue = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'
$script:lastKind = ''
$script:lastMs = 0
$script:lastEventAt = 0
$script:lastEventKind = ''
$script:locksSeen = 0
$script:lastLockSeen = 0
$script:startedAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
$script:wasLocked = $false

function Now-Ms { [DateTimeOffset]::Now.ToUnixTimeMilliseconds() }

function Add-Event([string]$kind, [string]$src) {
  $now = Now-Ms
  if ($script:lastKind -eq $kind -and ($now - $script:lastMs) -lt 10000) { return }
  $script:lastKind = $kind
  $script:lastMs = $now
  $line = '{"t":' + $now + ',"k":"' + $kind + '","src":"' + $src + '"}'
  # AppendAllLines 自己补真换行；不要在 PS 里拼转义写法（PS 5.1 只认反引号，写出字面反斜杠 n 就是坏行）。
  [IO.File]::AppendAllLines($eventsPath, [string[]]@($line), $script:utf8)
  $script:lastEventAt = $now
  $script:lastEventKind = $kind
}

function Write-Status {
  $o = [ordered]@{
    pid = $PID
    startedAt = $script:startedAt
    updatedAt = (Now-Ms)
    lastEventAt = $script:lastEventAt
    lastEventKind = $script:lastEventKind
    locksSeen = $script:locksSeen
    lastLockSeen = $script:lastLockSeen
  }
  try { [IO.File]::WriteAllText($statusPath, ($o | ConvertTo-Json -Compress), $script:utf8) } catch { }
}

Add-Event 'unlock' 'start'
Write-Status

try {
  Add-Type -AssemblyName System.Windows.Forms
  [Microsoft.Win32.SystemEvents]::add_SessionSwitch({
    param($sender, $e)
    $script:queue.Enqueue([string]$e.Reason)
  })
} catch {
  # 接不上会话事件就只靠下面的 LogonUI 轮询；不往事件流里写假 lock（会把「已收工」写错）。
}

$tick = 0
while ($true) {
  [System.Windows.Forms.Application]::DoEvents()
  $reason = ''
  while ($script:queue.TryDequeue([ref]$reason)) {
    switch ($reason) {
      'SessionUnlock' { Add-Event 'unlock' 'event' }
      'SessionLogon'  { Add-Event 'unlock' 'event' }
      'SessionLock'   { Add-Event 'lock' 'event'; $script:locksSeen++; $script:lastLockSeen = (Now-Ms) }
      'SessionLogoff' { Add-Event 'lock' 'event' }
    }
  }
  $tick++
  if ($tick % 15 -eq 0) {
    $locked = @(Get-Process LogonUI -ErrorAction SilentlyContinue).Count -gt 0
    if ($locked) {
      $script:wasLocked = $true
    } elseif ($script:wasLocked) {
      $script:wasLocked = $false
      if (-not $script:lastEventKind -or $script:lastEventKind -ne 'unlock' -or ((Now-Ms) - $script:lastEventAt) -gt 30000) {
        Add-Event 'unlock' 'poll'
      }
    }
    Write-Status
  }
  Start-Sleep -Milliseconds 1000
}
`;

function agentScript(): string {
  return AGENT_SCRIPT_BODY;
}

function agentHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return hash.toString(16);
}

// ---------------------------------------------------------------- 记录器装 / 卸

interface AgentAction {
  ok: boolean;
  code?: string;
  error?: string;
  agent: WorkclockAgent;
}

/** 记录器自己的命令行（不含 `powershell.exe`）；自启项与 `Start-Process` 共用一份。 */
function agentArgs(): string {
  return `-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${agentScriptFile()}" -Dir "${dir()}"`;
}

/**
 * PowerShell 的可执行文件绝对路径。
 *
 * 写绝对路径是因为登录时的 Run 项由 explorer 拉起、靠 PATH 解析：System32 正常在 PATH 里，但用户把 PATH
 * 改坏、或者前面有条冒牌的 `powershell.exe`，就会跑到别的东西上。找不到就退回裸名字（至少在 PATH 里）。
 */
function powershellExe(): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? "";
  const abs = root ? path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "";
  return abs && fs.existsSync(abs) ? abs : "powershell.exe";
}

/** Windows 命令行里的程序路径：Run 项走 CreateProcess，只认双引号，不认 PowerShell 的单引号。 */
function winQuote(text: string): string {
  return text.includes(" ") ? `"${text}"` : text;
}

/** 自启项里注册的整行命令。 */
function agentCommandLine(): string {
  return `${winQuote(powershellExe())} ${agentArgs()}`;
}

/**
 * 立刻拉起记录器，与桥、与这层 PowerShell 都脱钩。
 *
 * 不能用 node 的 `detached`：Windows 上它是 DETACHED_PROCESS + 无控制台，PS 5.1 会启动即退（实测 exit 0、
 * 什么都没做）；不 detached 又会跟着桥一起死（实测桥一退，记录器进程跟心跳一起停）。走 `Start-Process`：
 * 内层进程自成一体，桥重启后记录器继续跑。`-ArgumentList` 必须是一整条**带引号**的字符串
 * （Start-Process 用空格拼接数组，路径带空格会断），所以直接塞 `agentArgs()`。
 */
async function launchAgent(): Promise<void> {
  const ps =
    `$ErrorActionPreference='Stop'\n` +
    `Start-Process -FilePath ${psQuote(powershellExe())} -ArgumentList ${psQuote(agentArgs())} -WindowStyle Hidden\n`;
  await runPowerShell(ps, 20_000);
}

/** 等记录器自己写下一份心跳；带上限，没等到就返回 false。 */
async function waitHeartbeat(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const status = readStatus();
    if (typeof status?.updatedAt === "number" && Date.now() - status.updatedAt < HEARTBEAT_STALE_MS) return true;
  }
  return false;
}

export async function installAgent(now = Date.now()): Promise<AgentAction> {
  if (process.platform !== "win32") {
    return { ok: false, code: "not_windows", error: "记录器只支持 Windows", agent: emptyAgent() };
  }
  fs.mkdirSync(dir(), { recursive: true });
  // PowerShell 5.1 读无 BOM 的 .ps1 按 ANSI 解，中文注释会变成乱码字节把语法拆坏 —— 存 UTF-8 with BOM。
  const script = `\ufeff${agentScript()}`;
  const target = agentScriptFile();
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  if (current !== script) fs.writeFileSync(target, script, "utf8");

  // ① 自启项。写完回读一次——reg.exe 的退出码靠不住，注册表里真有了才算装上。
  const name = autostartValueName();
  const add = await runReg(["add", `HKCU\\${AUTOSTART_KEY}`, "/v", name, "/t", "REG_SZ", "/d", agentCommandLine(), "/f"]);
  const after = await readAutostart();
  if (!after.exists) {
    const message = (add.stderr || add.stdout || "写自启项失败").trim();
    return { ok: false, code: "agent_autostart_failed", error: message, agent: await readAgent(now) };
  }

  // ② 已经在跑就别再起一份（不然两个记录器抢同一个 agent.jsonl）。
  const alive = statusRunning(readStatus(), Date.now());
  if (!alive) await launchAgent();

  // ③ 心跳为证：起没起来不靠退出码，靠记录器自己写的那份 `agent-status.json`。
  const beat = alive || (await waitHeartbeat(8_000));
  const agent = await readAgent(Date.now());
  if (!beat || !agent.running) {
    return {
      ok: false,
      code: "agent_not_running",
      error: `自启项写好了，但记录器没起来。直接跑一次 ${target} 看报什么错，或者看 ${agentStatusFile()} 的时间戳`,
      agent,
    };
  }
  return { ok: true, agent };
}

export async function uninstallAgent(now = Date.now()): Promise<AgentAction> {
  if (process.platform !== "win32") {
    return { ok: false, code: "not_windows", error: "记录器只支持 Windows", agent: emptyAgent() };
  }
  const script = agentScriptFile();
  const name = autostartValueName();
  await runReg(["delete", `HKCU\\${AUTOSTART_KEY}`, "/v", name, "/f"]);
  const status = readStatus();
  const pid = typeof status?.pid === "number" ? status.pid : null;
  // 先按心跳里的 pid 收，再按完整脚本路径兜底（只匹配本实例的 `-Dir`，不会误杀测试实例或真实记录器）。
  const ps =
    `$ErrorActionPreference='SilentlyContinue'\n` +
    (pid !== null ? `Stop-Process -Id ${pid} -Force\n` : "") +
    `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like ${psQuote(`*${script}*`)} -and $_.CommandLine -like ${psQuote(`*-Dir*${dir()}*`)} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }\n` +
    `[pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress`;
  const result = await runPowerShell(ps, 30_000);
  // 卸掉后心跳文件还在，清掉它，免得页面把「已停」读成「在跑」。
  try {
    fs.rmSync(agentStatusFile(), { force: true });
  } catch {
    /* 下一次心跳会覆盖它，无所谓 */
  }
  try {
    fs.rmSync(script, { force: true });
  } catch {
    /* 文件被占用时留着，装上时会覆盖 */
  }
  const agent = await readAgent(now);
  if (agent.autostart || agent.running) {
    const message = result.timedOut
      ? "停止记录器超时"
      : (result.stderr || "自启项或记录器进程还在（可能有别的窗口又把它拉起来了）").trim();
    return { ok: false, code: "agent_uninstall_failed", error: message, agent };
  }
  return { ok: true, agent };
}

export function agentFingerprint(): string {
  return agentHash(agentScript());
}

// ---------------------------------------------------------------- 导入历史（一次 UAC）

interface BackfillResult {
  ok: boolean;
  code?: string;
  error?: string;
  count?: number;
  from?: number | null;
  to?: number | null;
  state?: WorkclockState;
}

/**
 * 提权跑的助手脚本：把 Security 日志里的事件读成 `[{"t":毫秒,"k":"unlock"|"lock"}]` 写盘，
 * 成功/失败都写回执。解锁来自 4624 的 LogonType（默认就审计），锁屏只有 4800/4801（默认不审计）。
 *
 * 字段一律走 XML：`.Properties` 会**静默返回空值**（login_audit 的脚本注释记了这条，我没在有 Security
 * 权限的环境里复验），那样会得到「读到了日志但 0 条」的假象。`FilterHashtable` 没有 EndTime，只能
 * StartTime + 上限截断。
 */
export function backfillScript(outFile: string): string {
  return (
    `$since = [DateTime]::Now.AddDays(-${MAX_LOG_DAYS})\n` +
    `$who = ([Security.Principal.WindowsIdentity]::GetCurrent()).Name\n` +
    // 用 [char]92 而不是 '\\\\'：`-match` 当正则、`LastIndexOf` 当字面量，两边对 `'\\\\'` 的理解不一样（实测拿不到短名）。
    `$me = if ($who.Contains([char]92)) { $who.Substring($who.LastIndexOf([char]92) + 1) } else { $who }\n` +
    `$unlockTypes = @(${LOGON_UNLOCK_TYPES.join(",")})\n` +
    `$events = @()\n` +
    `try {\n` +
    `  $events = @(Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=${SECURITY_IDS.join(",")}; StartTime=$since } -MaxEvents 50000 -ErrorAction Stop)\n` +
    `} catch {\n` +
    `  $msg = $_.Exception.Message\n` +
    `  if ($msg -notmatch 'No events were found|没有找到') {\n` +
    `    if ($msg -match 'unauthorized|未经授权|拒绝访问|Access is denied') {\n` +
    `      Write-Receipt ([pscustomobject]@{ ok = $false; code = 'no_security_access'; error = $msg }); exit 1\n` +
    `    }\n` +
    `    Write-Receipt ([pscustomobject]@{ ok = $false; code = 'security_read_failed'; error = $msg }); exit 1\n` +
    `  }\n` +
    `}\n` +
    `$list = New-Object Collections.Generic.List[object]\n` +
    `foreach ($e in $events) {\n` +
    `  $ms = ([DateTimeOffset]$e.TimeCreated).ToUnixTimeMilliseconds()\n` +
    `  if ($e.Id -eq 4800) { $list.Add([ordered]@{ t = $ms; k = 'lock' }); continue }\n` +
    `  if ($e.Id -eq 4801) { $list.Add([ordered]@{ t = $ms; k = 'unlock' }); continue }\n` +
    `  $xml = $null\n` +
    `  try { $xml = [xml]$e.ToXml() } catch { continue }\n` +
    `  $data = @{}\n` +
    `  foreach ($d in @($xml.Event.EventData.Data)) { if ($d.Name) { $data[$d.Name] = $d.InnerText } }\n` +
    `  if ($data['TargetUserName'] -ne $me) { continue }\n` +
    `  $lt = 0\n` +
    `  if (-not [int]::TryParse([string]$data['LogonType'], [ref]$lt)) { continue }\n` +
    `  if ($unlockTypes -notcontains $lt) { continue }\n` +
    `  $list.Add([ordered]@{ t = $ms; k = 'unlock' })\n` +
    `}\n` +
    `[IO.File]::WriteAllText(${psQuote(outFile)}, (ConvertTo-Json -InputObject $list -Compress), (New-Object Text.UTF8Encoding($false)))\n` +
    // 回执只报「写下了多少条原始事件」；给用户看的条数由 TS 去重后重算（去重规则只留 dedupeEvents 一份）。
    `Write-Receipt ([pscustomobject]@{ ok = $true; count = $list.Count })`
  );
}

/**
 * 读 Security 日志回填解锁历史。只有这一步需要管理员（非管理员连 4624 都读不到，实测拒绝访问）。
 * 提权脚本把事件写进 `log-events.json`，桥只读结果 —— 桥自己的 stdout 拿不到提权进程的输出。
 */
export async function backfillHistory(now = Date.now()): Promise<BackfillResult> {
  if (process.platform !== "win32") {
    return { ok: false, code: "not_windows", error: "只有 Windows 有 Security 日志" };
  }
  fs.mkdirSync(dir(), { recursive: true });
  const data = await runElevated("workclock", backfillScript(logEventsFile()), "backfill_failed");
  if (data.ok !== true) {
    const code = typeof data.code === "string" ? data.code : "backfill_failed";
    return { ok: false, code, error: backfillErrorText(code, data.error) };
  }
  // 条数按页面真正会显示的明细算：脚本写的是原始事件（一次解锁常有两三条重复 4624），
  // 去重规则只有 dedupeEvents 这一份，不在这里另抄一遍（D288）。
  const unlocks = dedupeEvents(readLogEvents()).filter((ev) => ev.k === "unlock");
  const count = unlocks.length;
  const from = count ? unlocks[0].t : null;
  const to = count ? unlocks[count - 1].t : null;
  return { ok: true, count, from, to, state: await readWorkclock(false, now) };
}

// ---------------------------------------------------------------- 设置

export function saveSettings(patch: Record<string, unknown>): WorkclockSettings {
  const current = readSettings();
  const next = normalizeSettings({
    hours: typeof patch.hours === "number" ? patch.hours : current.hours,
    workdays: Array.isArray(patch.workdays) ? patch.workdays : current.workdays,
    notify: typeof patch.notify === "boolean" ? patch.notify : current.notify,
    updatedAt: Date.now(),
  });
  fs.mkdirSync(dir(), { recursive: true });
  writeJson(settingsFile(), next);
  return next;
}

/** 事件文件超过 512KB 时按 90 天压实一次，别让它无限长。 */
export function compactAgentEvents(now = Date.now()): void {
  try {
    const file = agentEventsFile();
    const stat = fs.statSync(file);
    if (stat.size < 512 * 1024) return;
    const cutoff = now - MAX_LOG_DAYS * 24 * 3_600_000;
    const kept = dedupeEvents(readAgentEvents().filter((ev) => ev.t >= cutoff));
    const text = kept.map((ev) => JSON.stringify({ t: ev.t, k: ev.k, src: ev.src })).join("\n");
    fs.writeFileSync(file, text ? `${text}\n` : "", "utf8");
  } catch {
    /* 压实失败不影响读 */
  }
}

// ---------------------------------------------------------------- 路由

export interface WorkclockReply {
  status: number;
  body: unknown;
}

/**
 * `/api/sys/workclock*` 的写接口 + 记录器控制。读接口在 `handleSysmanage` 的 section 分支里。
 * 返回 null 表示「不是我管的路径」。写入一律拒绝公网（与 DNS 同一条边界）。
 */
export async function handleWorkclockAction(
  url: URL,
  method: string,
  body: Record<string, unknown> | null,
  publicReq: boolean,
): Promise<WorkclockReply | null> {
  if (!url.pathname.startsWith("/api/sys/workclock")) return null;
  if (method !== "POST") return { status: 405, body: { error: "这个接口只支持 POST", code: "sys_method" } };
  if (publicReq) return { status: 403, body: { error: "公网不能改本机的上下班设置；请回本机操作", code: "public_workclock" } };
  if (url.pathname === "/api/sys/workclock/settings") {
    // 越界就直接回绝，别静默夹到 24 —— 用户填 99 却看到「24」会以为是自己手误。
    if (body?.hours !== undefined && (typeof body.hours !== "number" || !Number.isFinite(body.hours) || body.hours < 0.5 || body.hours > 24)) {
      return { status: 400, body: { error: "工时要在 0.5 到 24 小时之间", code: "bad_hours" } };
    }
    if (body?.workdays !== undefined) {
      const ok = Array.isArray(body.workdays) && body.workdays.every((d) => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6);
      if (!ok) return { status: 400, body: { error: "算上班的星期要是 0–6 的整数数组", code: "bad_workdays" } };
    }
    return { status: 200, body: saveSettings(body ?? {}) };
  }
  if (url.pathname === "/api/sys/workclock/agent") {
    const action = typeof body?.action === "string" ? body.action : "";
    if (action === "install") {
      const done = await installAgent();
      return { status: done.ok ? 200 : 500, body: swapAgent(done) };
    }
    if (action === "uninstall") {
      const done = await uninstallAgent();
      return { status: done.ok ? 200 : 500, body: swapAgent(done) };
    }
    return { status: 400, body: { error: "action 只能是 install / uninstall", code: "workclock_action" } };
  }
  if (url.pathname === "/api/sys/workclock/backfill") {
    compactAgentEvents();
    const done = await backfillHistory();
    if (!done.ok) return { status: done.code === "uac_denied" ? 403 : 500, body: { error: done.error, code: done.code } };
    return { status: 200, body: { ok: true, count: done.count ?? 0, from: done.from ?? null, to: done.to ?? null, state: done.state } };
  }
  return { status: 404, body: { error: "没有这个上下班接口", code: "workclock_path" } };
}

interface AgentReply {
  ok?: boolean;
  error?: string;
  code?: string;
  agent: WorkclockAgent;
}

function swapAgent(done: AgentAction): AgentReply {
  return done.ok ? { ok: true, agent: done.agent } : { error: done.error, code: done.code, agent: done.agent };
}

/** 提权回填失败的三种已知原因各给一句人话，其余照搬 PowerShell 的原话。 */
function backfillErrorText(code: string, raw: unknown): string {
  if (code === "no_security_access") return "读不到 Security 日志：需要管理员权限";
  if (code === "uac_denied") return "取消了 UAC，没有导入";
  if (typeof raw === "string" && raw.trim()) return raw;
  return "导入历史失败";
}
