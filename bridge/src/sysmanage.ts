/**
 * 本机管理（#266）：只读的本机信息 + 逐网卡的 DNS 切换。
 *
 * 三条边界：
 * - 读：本机与局域网照常；公网隧道只回打码后的数据（主机名 / IP / MAC / 端口 / 服务名）。
 * - 写：只有 DNS，而且必须在本机桌面点 UAC「是」；公网一律 403。
 * - 平台：Windows 走 PowerShell/CIM；其它平台只回概况与网卡，DNS/端口/服务明确「暂不支持」。
 *
 * 采集尽量少起 PowerShell：概况用 Node `os` + `statfs` + 一次注册表；网卡/服务用带 TTL 的 CIM
 * 缓存；端口用 `netstat` + `Win32_Process`。冷启动的 CIM 可能十几秒，所以每个 section 分开取，
 * 页面按需加载。
 */
import fs from "node:fs";
import http from "node:http";
import { isIP } from "node:net";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readJsonChecked, statePath, writeJson } from "./paths.ts";

const MAX_BODY = 8 * 1024;
const PS_TIMEOUT = 30_000;
const DNS_TIMEOUT = 120_000;

export type SysSection = "overview" | "network" | "ports" | "services";
export type NetStatus = "up" | "disconnected" | "not_present" | "unknown";

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

export type PortScope = "all" | "nic" | "loopback";

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

export interface SysmanageCtx {
  publicReq: boolean;
  port: number;
  version: string;
  log?: (line: string) => void;
}

class SysError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------- 进程 / JSON 小件

interface PsResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * 跑一段 Windows PowerShell。脚本从 stdin 进（`-Command -`），避免命令行长度与引号问题。
 * 不 detached：D52 的教训是 Windows 上 detached 会变成 DETACHED_PROCESS，Start-Process 提权
 * 拿不到桌面会话，UAC 静默失败。
 */
function runPowerShell(script: string, timeoutMs = PS_TIMEOUT): Promise<PsResult> {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (result: PsResult) => {
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
      finish({ code: -1, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => finish({ code: -1, stdout, stderr: err.message, timedOut: false }));
    child.on("close", (code) => finish({ code: code ?? -1, stdout, stderr, timedOut: false }));
    child.stdin.end(
      `$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n[Console]::OutputEncoding=[Text.Encoding]::UTF8\n${script}\n`,
    );
  });
}

function parseJson<T>(stdout: string): T | null {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    // 有的 PowerShell 会在 JSON 前打一行警告；取最后一个完整对象再试一次。
    const start = text.lastIndexOf("{");
    if (start < 0) return null;
    try {
      return JSON.parse(text.slice(start)) as T;
    } catch {
      return null;
    }
  }
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ---------------------------------------------------------------- 缓存

interface CacheEntry {
  at: number;
  value: unknown;
}

const cache = new Map<string, CacheEntry>();

async function cached<T>(key: string, ttlMs: number, read: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await read();
  cache.set(key, { at: Date.now(), value });
  return value;
}

function bust(prefix: string): void {
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}

// ---------------------------------------------------------------- 概况

function diskRows(): { root: string; total: number; free: number }[] {
  const roots: string[] = [];
  if (process.platform === "win32") {
    for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") roots.push(`${letter}:/`);
  } else {
    roots.push("/");
  }
  const rows: { root: string; total: number; free: number }[] = [];
  for (const root of roots) {
    try {
      const stat = fs.statfsSync(root);
      const total = stat.blocks * stat.bsize;
      const free = stat.bavail * stat.bsize;
      if (total > 0) rows.push({ root: root.replace(/\/$/, ""), total, free });
    } catch {
      /* 空光驱 / 未挂载 */
    }
  }
  return rows;
}

async function windowsVersion(): Promise<{ version: string; build: string } | null> {
  if (process.platform !== "win32") return null;
  const result = await runPowerShell(
    `$p=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'\n` +
      `[pscustomobject]@{version=[string]$p.DisplayVersion;build=[string]$p.CurrentBuild;ubr=[int]$p.UBR} | ConvertTo-Json -Compress`,
    15_000,
  );
  const data = parseJson<{ version?: string; build?: string; ubr?: number }>(result.stdout);
  if (!data) return null;
  return {
    version: data.version ?? "",
    build: data.build ? `${data.build}${data.ubr ? `.${data.ubr}` : ""}` : "",
  };
}

export async function readOverview(ctx: SysmanageCtx): Promise<SysOverview> {
  const version = process.platform === "win32" ? await windowsVersion() : null;
  const cpus = os.cpus();
  const raw: SysOverview = {
    public: false,
    platform: process.platform,
    supported: process.platform === "win32",
    hostname: os.hostname(),
    os: {
      name: os.version() || process.platform,
      version: version?.version ?? os.release(),
      build: version?.build ?? "",
      arch: os.arch(),
      uptime: os.uptime(),
    },
    cpu: { model: cpus[0]?.model?.trim() || "—", threads: cpus.length },
    memory: { total: os.totalmem(), free: os.freemem() },
    disks: diskRows(),
    bridge: { version: ctx.version, pid: process.pid, port: ctx.port, node: process.version },
    updatedAt: Date.now(),
  };
  return ctx.publicReq ? publicOverview(raw) : raw;
}

function maskText(text: string, keep = 2): string {
  if (!text) return text;
  if (text.length <= keep) return "•••";
  const dots = Math.min(8, Math.max(3, text.length - keep));
  return `${text.slice(0, keep)}${"•".repeat(dots)}`;
}

function maskIp(ip: string): string {
  const parts = ip.split(".");
  return parts.length === 4 && parts.every((p) => /^\d+$/.test(p)) ? `${parts[0]}.•••.•••.•••` : maskText(ip);
}

function maskMac(mac: string): string {
  const parts = mac.split(":");
  if (parts.length !== 6) return maskText(mac);
  return `${parts[0]}:${parts.slice(1).map(() => "••").join(":")}`;
}

function publicOverview(raw: SysOverview): SysOverview {
  return {
    ...raw,
    public: true,
    hostname: maskText(raw.hostname),
    bridge: { ...raw.bridge, pid: null, port: null },
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------- 网卡

interface RawAdapter {
  InterfaceIndex?: number;
  NetConnectionID?: string | null;
  Description?: string | null;
  MACAddress?: string | null;
  GUID?: string | null;
  NetConnectionStatus?: number | null;
}

interface RawConfig {
  InterfaceIndex?: number;
  IPAddress?: string | string[] | null;
  IPSubnet?: string | string[] | null;
  DefaultIPGateway?: string | string[] | null;
  DNSServerSearchOrder?: string | string[] | null;
  DHCPEnabled?: boolean | null;
  IPConnectionMetric?: number | null;
}

const NET_STATUS: Record<number, NetStatus> = { 2: "up", 7: "disconnected", 4: "not_present", 0: "unknown" };

function isIPv4Mask(value: unknown): value is string {
  return typeof value === "string" && /^(\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split(".").every((part) => Number(part) <= 255);
}

export function normalizeAdapters(rawAdapters: RawAdapter[], rawConfigs: RawConfig[]): SysAdapter[] {
  const byIndex = new Map<number, RawConfig>();
  for (const cfg of rawConfigs) {
    if (typeof cfg.InterfaceIndex === "number") byIndex.set(cfg.InterfaceIndex, cfg);
  }
  const rows: SysAdapter[] = [];
  for (const adapter of rawAdapters) {
    const name = (adapter.NetConnectionID ?? "").trim();
    if (!name) continue;
    const index = adapter.InterfaceIndex ?? 0;
    const cfg = byIndex.get(index);
    const gateway = asArray(cfg?.DefaultIPGateway).filter((v): v is string => typeof v === "string" && v.length > 0);
    const ipv4 = asArray(cfg?.IPAddress).filter((v): v is string => typeof v === "string" && isIP(v) === 4);
    rows.push({
      guid: adapter.GUID ?? "",
      name,
      description: adapter.Description ?? "",
      index,
      status: NET_STATUS[adapter.NetConnectionStatus ?? 0] ?? "unknown",
      mac: (adapter.MACAddress ?? "").toUpperCase(),
      ipv4,
      mask: asArray(cfg?.IPSubnet).filter(isIPv4Mask),
      gateway,
      dns: asArray(cfg?.DNSServerSearchOrder).filter((v): v is string => typeof v === "string" && v.length > 0),
      dhcp: cfg?.DHCPEnabled === true,
      default: false,
    });
  }
  // 网关最少的那张当默认路由；都一样就取第一张在线的。
  const withGateway = rows.filter((r) => r.gateway.length && r.status === "up");
  if (withGateway.length) {
    withGateway.sort((a, b) => {
      const ma = byIndex.get(a.index)?.IPConnectionMetric ?? 9999;
      const mb = byIndex.get(b.index)?.IPConnectionMetric ?? 9999;
      return ma - mb;
    });
    withGateway[0].default = true;
  }
  return rows.sort((a, b) => {
    if (a.default !== b.default) return a.default ? -1 : 1;
    if ((a.status === "up") !== (b.status === "up")) return a.status === "up" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

async function readNetworkRaw(): Promise<SysAdapter[]> {
  if (process.platform !== "win32") return [];
  const script =
    `$ads=@(Get-CimInstance Win32_NetworkAdapter | Select-Object InterfaceIndex,NetConnectionID,Description,MACAddress,GUID,NetConnectionStatus)\n` +
    `$cfgs=@(Get-CimInstance Win32_NetworkAdapterConfiguration | Select-Object InterfaceIndex,IPAddress,IPSubnet,DefaultIPGateway,DNSServerSearchOrder,DHCPEnabled,IPConnectionMetric)\n` +
    `[pscustomobject]@{adapters=$ads;configs=$cfgs} | ConvertTo-Json -Depth 6 -Compress`;
  const result = await runPowerShell(script, 30_000);
  if (result.timedOut) throw new SysError(504, "sys_timeout", "读取网卡超时");
  const data = parseJson<{ adapters?: RawAdapter | RawAdapter[]; configs?: RawConfig | RawConfig[] }>(result.stdout);
  if (!data) throw new SysError(500, "sys_network", result.stderr.trim() || "读不到网卡信息");
  return normalizeAdapters(asArray(data.adapters), asArray(data.configs));
}

export async function readNetwork(ctx: SysmanageCtx): Promise<SysNetwork> {
  const adapters = await cached("network", 30_000, readNetworkRaw);
  const raw: SysNetwork = {
    public: false,
    platform: process.platform,
    supported: process.platform === "win32",
    adapters,
    saved: savedDns(ctx),
    updatedAt: Date.now(),
  };
  if (!ctx.publicReq) return raw;
  return {
    ...raw,
    public: true,
    saved: [],
    adapters: adapters.map((a) => ({
      ...a,
      description: maskText(a.description, 4),
      mac: maskMac(a.mac),
      ipv4: a.ipv4.map(maskIp),
      gateway: a.gateway.map(maskIp),
      dns: a.dns.map(maskIp),
    })),
  };
}

// ---------------------------------------------------------------- 端口

function splitEndpoint(text: string): { host: string; port: number } | null {
  const at = text.lastIndexOf(":");
  if (at <= 0) return null;
  const port = Number(text.slice(at + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  let host = text.slice(0, at);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host || host === "*") host = "0.0.0.0";
  return { host, port };
}

function scopeOf(host: string): PortScope {
  if (host === "0.0.0.0" || host === "::") return "all";
  if (host === "127.0.0.1" || host === "::1") return "loopback";
  return "nic";
}

export function parseNetstat(text: string): Omit<SysPort, "process">[] {
  const rows: Omit<SysPort, "process">[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const proto = cols[0]?.toUpperCase();
    if (proto !== "TCP" && proto !== "UDP") continue;
    if (proto === "TCP" && cols[3] !== "LISTENING") continue;
    const endpoint = splitEndpoint(cols[1] ?? "");
    if (!endpoint) continue;
    const pid = Number(proto === "TCP" ? cols[4] : cols[3]);
    const key = `${proto}:${endpoint.host}:${endpoint.port}:${pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      proto: proto === "TCP" ? "tcp" : "udp",
      local: endpoint.host,
      port: endpoint.port,
      pid: Number.isInteger(pid) ? pid : 0,
      scope: scopeOf(endpoint.host),
    });
  }
  return rows;
}

async function readProcessNames(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const result = await runPowerShell(
    `Get-CimInstance Win32_Process | Select-Object ProcessId,Name | ConvertTo-Json -Compress`,
    20_000,
  );
  const data = parseJson<{ ProcessId?: number; Name?: string } | { ProcessId?: number; Name?: string }[]>(result.stdout);
  for (const row of asArray(data)) {
    if (typeof row.ProcessId === "number" && typeof row.Name === "string") map.set(row.ProcessId, row.Name);
  }
  return map;
}

async function readFirewall(): Promise<SysPorts["firewall"]> {
  if (process.platform !== "win32") return { domain: null, private: null, public: null };
  const base = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters\\FirewallPolicy";
  const result = await runPowerShell(
    `$b='${base}'\n` +
      `$out=@{};foreach($n in 'DomainProfile','StandardProfile','PublicProfile'){try{$p=Get-ItemProperty "$b\\$n" -ErrorAction Stop;$out[$n]=[bool]$p.EnableFirewall}catch{$out[$n]=$null}}\n` +
      `[pscustomobject]@{domain=$out['DomainProfile'];private=$out['StandardProfile'];public=$out['PublicProfile']} | ConvertTo-Json -Compress`,
    15_000,
  );
  const data = parseJson<{ domain?: boolean | null; private?: boolean | null; public?: boolean | null }>(result.stdout);
  if (!data) return { domain: null, private: null, public: null };
  return {
    domain: typeof data.domain === "boolean" ? data.domain : null,
    private: typeof data.private === "boolean" ? data.private : null,
    public: typeof data.public === "boolean" ? data.public : null,
  };
}

async function readPortsRaw(): Promise<{ ports: SysPort[]; firewall: SysPorts["firewall"] }> {
  if (process.platform !== "win32") return { ports: [], firewall: { domain: null, private: null, public: null } };
  const netstat = await new Promise<{ out: string; err: string }>((resolve) => {
    let out = "";
    let err = "";
    const child = spawn("netstat.exe", ["-ano"], { windowsHide: true });
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
    child.on("error", () => resolve({ out, err }));
    child.on("close", () => resolve({ out, err }));
  });
  const rows = parseNetstat(netstat.out);
  const [names, firewall] = await Promise.all([readProcessNames().catch(() => new Map<number, string>()), readFirewall()]);
  const ports = rows.map((row) => ({ ...row, process: names.get(row.pid) ?? "" }));
  const scopeOrder = { all: 0, nic: 1, loopback: 2 } as const;
  ports.sort((a, b) => {
    if (a.scope !== b.scope) return scopeOrder[a.scope] - scopeOrder[b.scope];
    if (a.proto !== b.proto) return a.proto === "tcp" ? -1 : 1;
    return a.port - b.port;
  });
  return { ports, firewall };
}

export async function readPorts(ctx: SysmanageCtx): Promise<SysPorts> {
  const rawData = await cached("ports", 10_000, readPortsRaw);
  const external = rawData.ports.filter((p) => p.scope !== "loopback").length;
  const raw: SysPorts = {
    public: false,
    platform: process.platform,
    supported: process.platform === "win32",
    ports: rawData.ports,
    firewall: rawData.firewall,
    summary: {
      total: rawData.ports.length,
      external,
      tcp: rawData.ports.filter((p) => p.proto === "tcp").length,
      udp: rawData.ports.filter((p) => p.proto === "udp").length,
    },
    updatedAt: Date.now(),
  };
  if (!ctx.publicReq) return raw;
  return { ...raw, public: true, ports: [] };
}

// ---------------------------------------------------------------- 服务

interface RawService {
  Name?: string;
  DisplayName?: string;
  State?: string;
  StartMode?: string;
  ProcessId?: number | null;
  PathName?: string | null;
}

export function normalizeServices(raw: RawService[]): SysService[] {
  return raw
    .filter((s) => typeof s.Name === "string" && s.Name)
    .map((s) => {
      const path = (s.PathName ?? "").trim();
      const lower = path.toLowerCase();
      const display = s.DisplayName ?? s.Name ?? "";
      const microsoft =
        !lower ||
        /^microsoft(\s|$)/i.test(display) ||
        /(^|\\)(windows|microsoft)(\\| |$)/i.test(lower) ||
        lower.startsWith("c:\\windows");
      return {
        name: s.Name ?? "",
        display: s.DisplayName ?? s.Name ?? "",
        state: s.State ?? "",
        start: s.StartMode ?? "",
        pid: typeof s.ProcessId === "number" && s.ProcessId > 0 ? s.ProcessId : null,
        path,
        microsoft,
      };
    })
    .sort((a, b) => a.display.localeCompare(b.display));
}

async function readServicesRaw(): Promise<SysService[]> {
  if (process.platform !== "win32") return [];
  const result = await runPowerShell(
    `Get-CimInstance Win32_Service | Select-Object Name,DisplayName,State,StartMode,ProcessId,PathName | ConvertTo-Json -Depth 4 -Compress`,
    35_000,
  );
  if (result.timedOut) throw new SysError(504, "sys_timeout", "读取服务超时");
  const data = parseJson<RawService | RawService[]>(result.stdout);
  if (!data) throw new SysError(500, "sys_services", result.stderr.trim() || "读不到服务列表");
  return normalizeServices(asArray(data));
}

export async function readServices(ctx: SysmanageCtx): Promise<SysServices> {
  const services = await cached("services", 30_000, readServicesRaw);
  const running = services.filter((s) => s.state === "Running").length;
  const raw: SysServices = {
    public: false,
    platform: process.platform,
    supported: process.platform === "win32",
    services,
    summary: {
      total: services.length,
      running,
      nonMicrosoft: services.filter((s) => s.state === "Running" && !s.microsoft).length,
    },
    updatedAt: Date.now(),
  };
  if (!ctx.publicReq) return raw;
  return { ...raw, public: true, services: [] };
}

// ---------------------------------------------------------------- DNS 状态

interface DnsFile {
  version: 1;
  adapters: Record<string, DnsSaved>;
}

function dnsFile(): string {
  return statePath("sysmanage.json");
}

function readDnsFile(): DnsFile {
  const { ok, value, error } = readJsonChecked<DnsFile>(dnsFile(), { version: 1, adapters: {} });
  if (!ok) throw new SysError(500, "dns_state", `DNS 原值读不出来：${error ?? "未知错误"}`);
  if (!value || typeof value !== "object" || value.version !== 1 || typeof value.adapters !== "object" || !value.adapters) {
    throw new SysError(500, "dns_state", "DNS 原值文件格式不对，拒绝覆盖");
  }
  return value;
}

function writeDnsFile(file: DnsFile): void {
  writeJson(dnsFile(), file);
}

interface DnsTarget {
  index: number;
  name: string;
  dns: string[];
  dhcp: boolean;
}

function isGuid(value: string): boolean {
  return /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i.test(value);
}

async function readDnsTarget(guid: string): Promise<DnsTarget> {
  if (!isGuid(guid)) throw new SysError(400, "dns_guid", "网卡标识不对");
  const script =
    `$g='${guid}'\n` +
    `$a=Get-CimInstance Win32_NetworkAdapter -Filter "GUID='$g'" -ErrorAction Stop\n` +
    `if(-not $a){throw 'adapter not found'}\n` +
    `$c=Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "InterfaceIndex=$($a.InterfaceIndex)" -ErrorAction Stop\n` +
    `[pscustomobject]@{index=[int]$a.InterfaceIndex;name=[string]$a.NetConnectionID;dns=@($c.DNSServerSearchOrder);dhcp=[bool]$c.DHCPEnabled} | ConvertTo-Json -Compress`;
  const result = await runPowerShell(script, 25_000);
  const data = parseJson<{ index?: number; name?: string; dns?: string | string[]; dhcp?: boolean }>(result.stdout);
  if (!data || typeof data.index !== "number") {
    throw new SysError(404, "adapter_not_found", result.stderr.trim() || "找不到这张网卡");
  }
  return {
    index: data.index,
    name: data.name ?? "",
    dns: asArray(data.dns).filter((v): v is string => typeof v === "string" && v.length > 0),
    dhcp: data.dhcp === true,
  };
}

function normalizeServers(input: unknown): string[] {
  if (!Array.isArray(input)) throw new SysError(400, "dns_servers", "DNS 地址要一个数组");
  const out: string[] = [];
  for (const item of input) {
    const text = typeof item === "string" ? item.trim() : "";
    if (!text || isIP(text) !== 4) throw new SysError(400, "dns_servers", `不是 IPv4 地址：${text || "空"}`);
    if (!out.includes(text)) out.push(text);
  }
  if (!out.length) throw new SysError(400, "dns_servers", "至少给一个 DNS 地址");
  if (out.length > 3) throw new SysError(400, "dns_servers", "最多 3 个 DNS 地址");
  return out;
}

function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

interface ElevatedResult {
  ok: boolean;
  code?: string;
  error?: string;
  after: string[];
}

/**
 * 用 UAC 提权跑一次 DNS 改动。助手脚本只由校验过的值拼成；回执是 JSON，桥再读回来。
 * 取消 UAC 时 Start-Process 抛 1223，包装脚本把它写成 `uac_denied`。
 */
async function runElevatedDns(target: DnsTarget, servers: string[], reset: boolean): Promise<ElevatedResult> {
  const token = randomUUID();
  const helper = statePath(`sysmanage-dns-${token}.ps1`);
  const receipt = statePath(`sysmanage-dns-${token}.json`);
  const action = reset
    ? `Set-DnsClientServerAddress -InterfaceIndex ${target.index} -ResetServerAddresses`
    : `Set-DnsClientServerAddress -InterfaceIndex ${target.index} -ServerAddresses @(${servers.map(psQuote).join(",")})`;
  const helperScript =
    `$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n` +
    `$receipt=${psQuote(receipt)}\n` +
    `function Write-Receipt([object]$o){[IO.File]::WriteAllText($receipt,($o|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))}\n` +
    `try{\n${action}\nClear-DnsClientCache\n` +
    `$after=@(Get-DnsClientServerAddress -InterfaceIndex ${target.index} -AddressFamily IPv4 | Select-Object -ExpandProperty ServerAddresses)\n` +
    `Write-Receipt ([pscustomobject]@{ok=$true;after=$after})\n` +
    `}catch{Write-Receipt ([pscustomobject]@{ok=$false;code='dns_failed';error=$_.Exception.Message});exit 1}\n`;
  // -ArgumentList 这里必须是一整条字符串：Start-Process 用空格拼接数组，路径带空格会断。
  const argLine = `-NoProfile -ExecutionPolicy Bypass -File "${helper}"`;
  const wrapperScript =
    `$ErrorActionPreference='Stop'\n` +
    `$receipt=${psQuote(receipt)}\n` +
    `try{\n` +
    `$p=Start-Process -FilePath 'powershell.exe' -ArgumentList ${psQuote(argLine)} -Verb RunAs -Wait -PassThru\n` +
    `exit $p.ExitCode\n` +
    `}catch{\n` +
    `$m=$_.Exception.Message\n` +
    `[IO.File]::WriteAllText($receipt,(@{ok=$false;code='uac_denied';error=$m}|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))\n` +
    `exit 1\n}\n`;
  try {
    fs.writeFileSync(helper, helperScript, "utf8");
    const result = await runPowerShell(wrapperScript, DNS_TIMEOUT);
    if (result.timedOut) {
      return { ok: false, code: "uac_timeout", error: "等了 120 秒还没有回执：UAC 可能还开着", after: [] };
    }
    type Receipt = { ok?: boolean; code?: string; error?: string; after?: string | string[] };
    let data: Receipt | null = null;
    try {
      data = JSON.parse(fs.readFileSync(receipt, "utf8")) as Receipt;
    } catch {
      data = null;
    }
    if (!data) {
      return {
        ok: false,
        code: "no_receipt",
        error: result.stderr.trim() || "提权助手没有留下回执",
        after: [],
      };
    }
    if (data.ok !== true) {
      return {
        ok: false,
        code: typeof data.code === "string" ? data.code : "dns_failed",
        error: typeof data.error === "string" ? data.error : "DNS 改动失败",
        after: [],
      };
    }
    return { ok: true, after: asArray(data.after).filter((v): v is string => typeof v === "string" && v.length > 0) };
  } finally {
    for (const file of [helper, receipt]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* 留在状态目录里也不影响下一次 */
      }
    }
  }
}

let dnsBusy = false;

export async function applyDns(guid: string, servers: unknown, ctx: SysmanageCtx): Promise<DnsResult> {
  if (ctx.publicReq) throw new SysError(403, "public_dns", "公网不能改本机 DNS；请回本机操作");
  if (process.platform !== "win32") throw new SysError(501, "unsupported_platform", "这个系统暂不支持改 DNS");
  if (dnsBusy) throw new SysError(409, "dns_busy", "另一个 DNS 改动还在等 UAC");
  const clean = normalizeServers(servers);
  dnsBusy = true;
  try {
    const target = await readDnsTarget(guid);
    if (sameList(target.dns, clean)) {
      const file = readDnsFile();
      return {
        ok: true,
        unchanged: true,
        before: target.dns,
        after: target.dns,
        saved: file.adapters[guid] ?? null,
        dhcp: target.dhcp,
      };
    }
    const file = readDnsFile();
    const existing = file.adapters[guid];
    if (!existing) {
      file.adapters[guid] = {
        guid,
        name: target.name,
        before: target.dns.slice(),
        dhcp: target.dhcp,
        after: clean.slice(),
        at: Date.now(),
      };
      writeDnsFile(file);
    }
    ctx.log?.(`sysmanage dns apply ${guid} [${target.dns.join(",")}] -> [${clean.join(",")}]`);
    const result = await runElevatedDns(target, clean, false);
    if (!result.ok) {
      // 没改成：刚存的那条原值要撤回，否则会显示一个并不存在的「可恢复」。
      if (!existing) {
        const after = readDnsFile();
        delete after.adapters[guid];
        writeDnsFile(after);
      }
      throw new SysError(
        result.code === "uac_denied" ? 403 : 500,
        result.code ?? "dns_failed",
        result.error ?? "DNS 改动失败",
      );
    }
    const after = readDnsFile();
    const saved = after.adapters[guid];
    if (saved) {
      saved.after = result.after.length ? result.after : clean;
      saved.at = Date.now();
      writeDnsFile(after);
    }
    bust("network");
    return {
      ok: true,
      before: target.dns,
      after: result.after.length ? result.after : clean,
      saved: saved ?? null,
      dhcp: target.dhcp,
    };
  } finally {
    dnsBusy = false;
  }
}

export async function restoreDns(guid: string, ctx: SysmanageCtx): Promise<DnsResult> {
  if (ctx.publicReq) throw new SysError(403, "public_dns", "公网不能改本机 DNS；请回本机操作");
  if (process.platform !== "win32") throw new SysError(501, "unsupported_platform", "这个系统暂不支持改 DNS");
  if (dnsBusy) throw new SysError(409, "dns_busy", "另一个 DNS 改动还在等 UAC");
  if (!isGuid(guid)) throw new SysError(400, "dns_guid", "网卡标识不对");
  dnsBusy = true;
  try {
    const file = readDnsFile();
    const saved = file.adapters[guid];
    if (!saved) throw new SysError(404, "no_saved_dns", "没有这张网卡的原值记录");
    if (!saved.dhcp && !saved.before.length) throw new SysError(500, "no_saved_dns", "原值是空的，无法恢复");
    const target = await readDnsTarget(guid);
    ctx.log?.(`sysmanage dns restore ${guid} -> ${saved.dhcp ? "DHCP" : `[${saved.before.join(",")}]`}`);
    const result = await runElevatedDns(target, saved.dhcp ? [] : saved.before, saved.dhcp);
    if (!result.ok) {
      throw new SysError(
        result.code === "uac_denied" ? 403 : 500,
        result.code ?? "dns_failed",
        result.error ?? "恢复 DNS 失败",
      );
    }
    const after = readDnsFile();
    delete after.adapters[guid];
    writeDnsFile(after);
    bust("network");
    return {
      ok: true,
      before: target.dns,
      after: result.after.length ? result.after : saved.before,
      saved: null,
      dhcp: saved.dhcp,
    };
  } finally {
    dnsBusy = false;
  }
}

/** 当前保存了原值的网卡（页面用来显示「可恢复」）。公网不回。 */
export function savedDns(ctx: SysmanageCtx): DnsSaved[] {
  if (ctx.publicReq) return [];
  const file = readDnsFile();
  return Object.values(file.adapters);
}

// ---------------------------------------------------------------- HTTP

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function fail(res: http.ServerResponse, status: number, code: string, error: string): void {
  json(res, status, { error, code });
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve(null);
      try {
        const parsed = JSON.parse(text) as unknown;
        resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null);
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * 处理 `/api/sys*`；返回 true 表示这个请求归它管。调用方在鉴权闸之后接线。
 * 读：本机 + 局域网；公网也读，但数据已打码。写：只有 DNS，公网 403。
 */
export async function handleSysmanage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: SysmanageCtx,
): Promise<boolean> {
  if (url.pathname !== "/api/sys" && !url.pathname.startsWith("/api/sys/")) return false;
  try {
    if (url.pathname === "/api/sys" && req.method === "GET") {
      const section = (url.searchParams.get("section") ?? "overview") as SysSection;
      switch (section) {
        case "overview": {
          json(res, 200, await readOverview(ctx));
          return true;
        }
        case "network": {
          json(res, 200, await readNetwork(ctx));
          return true;
        }
        case "ports": {
          json(res, 200, await readPorts(ctx));
          return true;
        }
        case "services": {
          json(res, 200, await readServices(ctx));
          return true;
        }
        default:
          fail(res, 400, "sys_section", `没有这个 section：${section}`);
          return true;
      }
    }

    if (url.pathname === "/api/sys/dns" && req.method === "POST") {
      if (ctx.publicReq) throw new SysError(403, "public_dns", "公网不能改本机 DNS；请回本机操作");
      const body = await readJsonBody(req).catch(() => null);
      const guid = typeof body?.guid === "string" ? body.guid : "";
      json(res, 200, await applyDns(guid, body?.servers, ctx));
      return true;
    }

    if (url.pathname === "/api/sys/dns/restore" && req.method === "POST") {
      if (ctx.publicReq) throw new SysError(403, "public_dns", "公网不能改本机 DNS；请回本机操作");
      const body = await readJsonBody(req).catch(() => null);
      const guid = typeof body?.guid === "string" ? body.guid : "";
      json(res, 200, await restoreDns(guid, ctx));
      return true;
    }

    fail(res, 405, "sys_method", "这个接口不支持这个请求方法");
    return true;
  } catch (err) {
    if (err instanceof SysError) {
      fail(res, err.status, err.code, err.message);
      return true;
    }
    const message = (err as Error)?.message ?? String(err);
    ctx.log?.(`sysmanage failed: ${message}`);
    fail(res, 500, "sys_failed", "读取本机信息失败");
    return true;
  }
}
