/**
 * 把内网通 MCP 服务注册进 pi 的 `mcp.json`（D439）。
 *
 * 为什么要注册而不是让用户自己配：这项能力是桥自己的（端口、cookie、重连都在桥这边），
 * 让每个人去 `~/.pi/agent/mcp.json` 手抄一遍 `node …/peer-mcp.mjs` 只会抄错路径。
 *
 * 三条规矩：
 * - **只往全局配置里写**（`~/.pi/agent/mcp.json`）：MCP 是给「任何会话」用的，项目级条目
 *   只在那个项目里生效，反而不对。
 * - **名字冲突不抢**：`mcpServers.peer` 已经有别人的条目（不是我们这条路）就报错，不覆盖。
 * - **关掉要记住**：开关落在 `statePath("peer-mcp.json")`。桥每次启动都 `ensure()`，如果只看
 *   「文件里有没有」就会把用户刚删掉的条目又加回来 —— 所以关掉时必须留下 enabled:false。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentDir, ensureDir, readJsonChecked, statePath, writeJson } from "./paths.ts";

export const PEER_MCP_NAME = "peer";

/** `bridge/src/peer-mcp.ts` 与 `bridge/dist/peer-mcp.js` 都在 `bridge/<x>/`，仓库根是两级上。 */
export function peerMcpServerPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "..", "peer", "mcp", "peer-mcp.mjs");
}

export function peerMcpFile(): string {
  return path.join(agentDir(), "mcp.json");
}

export interface PeerMcpState {
  /** 用户想要它开着吗（默认开）。 */
  enabled: boolean;
  /** `mcp.json` 里现在有没有这条。 */
  present: boolean;
  /** 这条是不是我们自己写的（认 args 里的 peer-mcp.mjs）。 */
  ours: boolean;
  /** 写哪份 mcp.json。 */
  file: string;
  /** 服务脚本路径。 */
  path: string;
}

function toggleFile(): string {
  return statePath("peer-mcp.json");
}

function readEnabled(): boolean {
  const res = readJsonChecked<{ enabled?: boolean }>(toggleFile(), { enabled: true });
  return !res.ok || res.value?.enabled !== false;
}

function readServers(file: string): { mcpServers?: Record<string, Record<string, unknown>> } {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as { mcpServers?: Record<string, Record<string, unknown>> };
    return data && typeof data === "object" ? data : {};
  } catch {
    // 没有文件、或者文件坏了：当成空配置（坏文件不动，add 时会先备份成 .bak）。
    return {};
  }
}

function writeServers(file: string, data: { mcpServers?: Record<string, Record<string, unknown>> }): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function isOurs(entry: Record<string, unknown> | undefined): boolean {
  const args = Array.isArray(entry?.args) ? entry.args.map(String) : [];
  return args.some((arg) => arg.replace(/\\/g, "/").endsWith("peer/mcp/peer-mcp.mjs"));
}

export function peerMcpEntry(): Record<string, unknown> {
  return {
    command: "node",
    args: [peerMcpServerPath()],
    // deferred = 按需加载：工具不常驻上下文，tool_search 搜到才出现（pi docs/mcp.md 的 exposure 表）。
    exposure: "deferred",
    description:
      "内网通（局域网聊天）：查联系人 / 读聊天记录 / 发文字 / 共享文件·内容·技能·会话 / 看未读。工具按需加载，用到时先用 tool_search 搜 peer。",
  };
}

export function peerMcpState(): PeerMcpState {
  const file = peerMcpFile();
  const entry = readServers(file).mcpServers?.[PEER_MCP_NAME];
  return {
    enabled: readEnabled(),
    present: Boolean(entry),
    ours: isOurs(entry),
    file,
    path: peerMcpServerPath(),
  };
}

/** 加一条（已存在且是我们的就更新成当前路径）。别人的同名条目不动，直接报错。 */
function addEntry(file: string): boolean {
  const data = readServers(file);
  const servers = (data.mcpServers ??= {});
  const current = servers[PEER_MCP_NAME];
  if (current && !isOurs(current)) throw new Error(`${file} 里已经有别的「${PEER_MCP_NAME}」服务了，不覆盖它`);
  const next = peerMcpEntry();
  if (current && JSON.stringify(current) === JSON.stringify(next)) return false;
  if (!current && fs.existsSync(file)) {
    // 第一次往里写之前留个底：用户手写的配置不该被我们一次意外写坏。
    try {
      fs.copyFileSync(file, `${file}.bak`);
    } catch {
      /* 备份失败不挡注册 */
    }
  }
  servers[PEER_MCP_NAME] = next;
  writeServers(file, data);
  return true;
}

function removeEntry(file: string): boolean {
  const data = readServers(file);
  const servers = data.mcpServers;
  if (!servers || !isOurs(servers[PEER_MCP_NAME])) return false;
  delete servers[PEER_MCP_NAME];
  writeServers(file, data);
  return true;
}

/**
 * 用户点开关。关掉时同时摘掉条目并记住「别再加回来」；打开时按当前路径重新写一条。
 * 返回最新状态，调用方直接回给页面。
 */
export function setPeerMcpEnabled(enabled: boolean): PeerMcpState {
  const file = peerMcpFile();
  // 先动 mcp.json，成了才记「用户要开着」：反过来的话 addEntry 抛错（比如同名条目是别人的）
  // 会留下 enabled:true —— 页面显示开着，实际一条都没注册，重启也不会补。
  if (enabled) addEntry(file);
  else removeEntry(file);
  writeJson(toggleFile(), { enabled });
  return peerMcpState();
}

/**
 * 桥启动时调一次：用户没关过就保证条目在。
 * 失败只回报不抛出 —— MCP 没注册上不该让整台桥起不来。
 */
export function ensurePeerMcp(): { ok: boolean; changed: boolean; error?: string } {
  if (!readEnabled()) return { ok: true, changed: false };
  try {
    return { ok: true, changed: addEntry(peerMcpFile()) };
  } catch (err) {
    return { ok: false, changed: false, error: (err as Error).message };
  }
}
