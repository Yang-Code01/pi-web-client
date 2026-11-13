/**
 * 上下班（本机管理第 5 个分区）：每天第一次解锁屏幕的时间 + 下班倒计时。
 *
 * 三条数据来源，页面上分别标出来源，不混为一谈：
 * - `event`：常驻记录器在解锁的那一刻收到系统会话事件（`WM_WTSSESSION_CHANGE`）。最准，零权限。
 * - `poll`：记录器漏了事件时，用「锁屏界面消失 + 最后一次输入」补的近似值。
 * - `log`：点「导入历史」时，提权读 Security 日志的 4801（解锁）/ 4800（锁屏）回填出来的。
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
import { readJsonChecked, statePath, writeJson } from "./paths.ts";
import { parseJson, psQuote, runElevated, runPowerShell } from "./ps.ts";

/** 页面上的历史窗口。 */
export const WORKCLOCK_DAYS = 30;
/** 「导入历史」最多回填多少天。Security 日志的保留期通常比这短。 */
export const MAX_LOG_DAYS = 90;
/** 记录器心跳超过这么久没动静就算没在跑。 */
const HEARTBEAT_STALE_MS = 90_000;
/** 计划任务状态的缓存时间：读一次要起一次 PowerShell，别每次 GET 都问。 */
const TASK_CACHE_MS = 20_000;

const TASK_NAME = "pi-web-client-workclock";
const AGENT_SCRIPT = "workclock-agent.ps1";
const DEFAULT_HOURS = 9;
const DEFAULT_WORKDAYS = [1, 2, 3, 4, 5];

export type WorkclockSource = "event" | "poll" | "log";
export type WorkclockKind = "unlock" | "lock";

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
 * 某一天的上班时刻。优先级：记录器看到的真实会话事件 > 轮询估计 > 日志回填 > 记录器启动时刻。
 * 同一天几种都有时不用 min() 混算 —— 让来源在页面上说得清，也别拿「中途才装上的记录器」冒充上班时间。
 */
function pickFirstUnlock(list: WorkclockEvent[]): { t: number; src: WorkclockSource } | null {
  const real = list.filter((ev) => ev.k === "unlock" && (ev.src === "event" || ev.src === "poll"));
  if (real.length) return { t: real[0].t, src: real[0].src === "poll" ? "poll" : "event" };
  const logged = list.filter((ev) => ev.k === "unlock" && ev.src === "log");
  if (logged.length) return { t: logged[0].t, src: "log" };
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
    if (first) {
      const locks = list.filter((ev) => ev.k === "lock" && ev.t >= first.t);
      if (isToday && lastEvent && lastEvent.k === "unlock") lastEnd = now;
      else if (locks.length) lastEnd = locks[locks.length - 1].t;
      else if (list.length) lastEnd = list[list.length - 1].t;
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

interface TaskInfo {
  exists: boolean;
  state: string;
  lastRun: string;
  lastResult: number;
}

let taskCache: { at: number; value: TaskInfo } | null = null;

async function readTaskInfo(force = false): Promise<TaskInfo> {
  if (!force && taskCache && Date.now() - taskCache.at < TASK_CACHE_MS) return taskCache.value;
  const script =
    `$t = Get-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -ErrorAction SilentlyContinue\n` +
    `$i = Get-ScheduledTaskInfo -TaskName ${psQuote(TASK_NAME)} -ErrorAction SilentlyContinue\n` +
    `[pscustomobject]@{ exists = [bool]$t; state = [string]$t.State; lastRun = [string]$i.LastRunTime; lastResult = [int]$i.LastTaskResult } | ConvertTo-Json -Compress`;
  const result = await runPowerShell(script, 20_000);
  const parsed = parseJson<TaskInfo>(result.stdout);
  const value: TaskInfo = {
    exists: parsed?.exists === true,
    state: typeof parsed?.state === "string" ? parsed.state : "",
    lastRun: typeof parsed?.lastRun === "string" ? parsed.lastRun : "",
    lastResult: typeof parsed?.lastResult === "number" ? parsed.lastResult : 0,
  };
  taskCache = { at: Date.now(), value };
  return value;
}

function readStatus(): AgentStatus | null {
  const parsed = readJsonChecked<unknown>(agentStatusFile(), null).value;
  return parsed && typeof parsed === "object" ? (parsed as AgentStatus) : null;
}

async function readAgent(now: number): Promise<WorkclockAgent> {
  const scriptPath = agentScriptFile();
  const installed = fs.existsSync(scriptPath);
  const status = readStatus();
  const heartbeatAt = typeof status?.updatedAt === "number" ? status.updatedAt : null;
  const task = installed && process.platform === "win32" ? await readTaskInfo() : { exists: false, state: "", lastRun: "", lastResult: 0 };
  return {
    installed,
    running: heartbeatAt !== null && now - heartbeatAt < HEARTBEAT_STALE_MS,
    autostart: task.exists,
    pid: typeof status?.pid === "number" ? status.pid : null,
    startedAt: typeof status?.startedAt === "number" ? status.startedAt : null,
    lastEventAt: typeof status?.lastEventAt === "number" ? status.lastEventAt : null,
    lastEventKind: typeof status?.lastEventKind === "string" ? status.lastEventKind : "",
    lastLockSeen: typeof status?.lastLockSeen === "number" ? status.lastLockSeen : null,
    locksSeen: typeof status?.locksSeen === "number" ? status.locksSeen : 0,
    heartbeatAt,
    scriptPath,
    taskName: TASK_NAME,
    taskState: task.state,
    error: fs.existsSync(scriptPath) ? null : "记录器还没装上",
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
    taskName: TASK_NAME,
    taskState: "",
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

function agentArgs(): string {
  return `-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${agentScriptFile()}" -Dir "${dir()}"`;
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
  // 只由本机拼出来、没有外部输入的命令；用单个脚本块注册 + 立刻拉起，不需要管理员。
  const ps =
    `$ErrorActionPreference='Stop'\n` +
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${psQuote(agentArgs())}\n` +
    `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME\n` +
    `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable\n` +
    `Register-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null\n` +
    `Start-ScheduledTask -TaskName ${psQuote(TASK_NAME)}\n` +
    `[pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress`;
  const result = await runPowerShell(ps, 40_000);
  if (result.timedOut) {
    return { ok: false, code: "agent_timeout", error: "注册计划任务超时", agent: await readAgent(now) };
  }
  const parsed = parseJson<{ ok?: boolean; error?: string }>(result.stdout);
  if (parsed?.ok !== true) {
    const message = (result.stderr || parsed?.error || "注册计划任务失败").trim();
    return { ok: false, code: "agent_install_failed", error: message, agent: await readAgent(now) };
  }
  // 心跳要等记录器自己写第一份；这里给它 1.5 秒，免得刚点完就显示「没在跑」。
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const status = readStatus();
    if (typeof status?.updatedAt === "number" && now - status.updatedAt < HEARTBEAT_STALE_MS) break;
  }
  taskCache = null;
  return { ok: true, agent: await readAgent(Date.now()) };
}

export async function uninstallAgent(now = Date.now()): Promise<AgentAction> {
  if (process.platform !== "win32") {
    return { ok: false, code: "not_windows", error: "记录器只支持 Windows", agent: emptyAgent() };
  }
  const script = agentScriptFile();
  const ps =
    `$ErrorActionPreference='SilentlyContinue'\n` +
    `Stop-ScheduledTask -TaskName ${psQuote(TASK_NAME)}\n` +
    `Unregister-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Confirm:$false\n` +
    `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like ${psQuote(`*${AGENT_SCRIPT}*`)} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }\n` +
    `[pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress`;
  const result = await runPowerShell(ps, 30_000);
  taskCache = null;
  if (result.timedOut) {
    return { ok: false, code: "agent_timeout", error: "停止记录器超时", agent: await readAgent(now) };
  }
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
  return { ok: true, agent: await readAgent(Date.now()) };
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
 * 读 Security 日志回填解锁历史。只有这一步需要管理员（4800/4801 非管理员读不到，实测拒绝访问）。
 * 提权脚本把事件写进 `log-events.json`，桥只读结果 —— 桥自己的 stdout 拿不到提权进程的输出。
 */
export async function backfillHistory(now = Date.now()): Promise<BackfillResult> {
  if (process.platform !== "win32") {
    return { ok: false, code: "not_windows", error: "只有 Windows 有 Security 日志" };
  }
  const out = logEventsFile();
  fs.mkdirSync(dir(), { recursive: true });
  const body =
    `$since = [DateTime]::Now.AddDays(-${MAX_LOG_DAYS})\n` +
    `$events = @()\n` +
    `try {\n` +
    `  $events = @(Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=4800,4801; StartTime=$since } -ErrorAction Stop)\n` +
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
    `  $kind = if ($e.Id -eq 4801) { 'unlock' } else { 'lock' }\n` +
    `  $ms = ([DateTimeOffset]$e.TimeCreated).ToUnixTimeMilliseconds()\n` +
    `  $list.Add([ordered]@{ t = $ms; k = $kind })\n` +
    `}\n` +
    `[IO.File]::WriteAllText(${psQuote(out)}, (ConvertTo-Json -InputObject $list -Compress), (New-Object Text.UTF8Encoding($false)))\n` +
    `$unlocks = @($list | Where-Object { $_.k -eq 'unlock' })\n` +
    `$first = if ($unlocks.Count -gt 0) { ($unlocks | Measure-Object -Property t -Minimum).Minimum } else { $null }\n` +
    `$last = if ($unlocks.Count -gt 0) { ($unlocks | Measure-Object -Property t -Maximum).Maximum } else { $null }\n` +
    `Write-Receipt ([pscustomobject]@{ ok = $true; count = $unlocks.Count; from = $first; to = $last })`;
  const data = await runElevated("workclock", body, "backfill_failed");
  if (data.ok !== true) {
    const code = typeof data.code === "string" ? data.code : "backfill_failed";
    return { ok: false, code, error: backfillErrorText(code, data.error) };
  }
  const count = typeof data.count === "number" ? data.count : 0;
  const from = typeof data.from === "number" ? data.from : null;
  const to = typeof data.to === "number" ? data.to : null;
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
