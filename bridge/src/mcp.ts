/**
 * A very small MCP server: the Streamable HTTP transport, four tools, no resources, no prompts
 * (D167).
 *
 * Why hand-rolled instead of `@modelcontextprotocol/sdk`: the bridge already speaks HTTP and JSON,
 * and the whole protocol surface we need is `initialize` / `tools/list` / `tools/call` / `ping`.
 * SDK or not, pi's client talks to exactly those. Thirty lines of dispatch beat a dependency whose
 * version has to keep pace with the spec.
 *
 * Auth is the caller's business: index.ts checks the bearer token and that the request came from
 * the loopback interface (a LAN or tunnel client must not be able to send chat on your behalf).
 */
import fs from "node:fs";
import path from "node:path";
import { agentDir, readJson, statePath, writeJson } from "./paths.ts";

export interface McpToolResult {
  /** What the model reads. Strings pass through; objects are pretty-printed JSON. */
  value: unknown;
  isError?: boolean;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<McpToolResult>;
}

export interface McpReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "pi-web-teams", version: "1.0.0" };

/**
 * Handle one JSON-RPC message. `null` means "notification": the transport answers 202 with an
 * empty body, as the spec requires.
 */
export async function handleMcp(body: unknown, tools: McpTool[]): Promise<McpReply | null> {
  // 原样的请求体也收：HTTP 层解析失败时给的就是那串坏 JSON，这里才好回 -32700（Parse error），
  // 而不是笼统的 -32600 —— 客户端据此知道「我发的东西不是 JSON」还是「JSON 但缺 method」。
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return error(null, -32700, "Parse error");
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return error(null, -32600, "Invalid Request");
  }
  const msg = body as { id?: unknown; method?: unknown; params?: unknown };
  const id = msg.id ?? null;
  const method = typeof msg.method === "string" ? msg.method : "";
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const isNotification = !("id" in msg);

  if (isNotification) {
    // `notifications/initialized`, `notifications/cancelled`, …: nothing to do, nothing to say.
    return null;
  }

  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const version = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0]!;
      return result(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "网页版 Teams（你自己的登录态）。teams_chats / teams_read / teams_find 只读；" +
          "teams_send 发给非「与你自己的聊天」的会话前，会在 pi 网页上等人点确认——没确认就不发。",
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, {
        tools: tools.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const tool = tools.find((t) => t.name === name);
      if (!tool) return error(id, -32602, `Unknown tool: ${name}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const out = await tool.run(args);
        const text = typeof out.value === "string" ? out.value : JSON.stringify(out.value, null, 2);
        return result(id, { content: [{ type: "text", text }], ...(out.isError ? { isError: true } : {}) });
      } catch (err) {
        const e = err as { code?: string; message?: string; detail?: string };
        const head = e.code ? `[${e.code}] ${e.message ?? "失败"}` : e.message ?? String(err);
        const text = e.detail ? `${head}\n${e.detail}` : head;
        return result(id, { content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return error(id, -32601, `Method not found: ${method}`);
  }
}

function result(id: unknown, value: unknown): McpReply {
  return { status: 200, body: { jsonrpc: "2.0", id, result: value }, headers: { "content-type": "application/json" } };
}

function error(id: unknown, code: number, message: string): McpReply {
  return { status: 200, body: { jsonrpc: "2.0", id, error: { code, message } }, headers: { "content-type": "application/json" } };
}

// ---------------------------------------------------------------- config

/**
 * The bearer token pi sends. Generated once and kept in the bridge's state dir — it is a local
 * secret, not a Teams credential, and rotating it only means re-running the settings button.
 */
export function mcpToken(): string {
  const file = statePath("mcp-token");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* first run */
  }
  const token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token + "\n", { mode: 0o600 });
  return token;
}

export function mcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

function mcpJsonPath(): string {
  return path.join(agentDir(), "mcp.json");
}

interface McpConfig {
  mcpServers?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/** Does the user-level mcp.json already point at this bridge, with the current token? */
export function mcpInstalled(port: number): boolean {
  const conf = readJson<McpConfig>(mcpJsonPath(), {});
  const entry = conf.mcpServers?.teams as { url?: string; headers?: Record<string, string> } | undefined;
  return entry?.url === mcpUrl(port) && entry?.headers?.Authorization === `Bearer ${mcpToken()}`;
}

/**
 * Write (or refresh) the `teams` entry in `~/.pi/agent/mcp.json`. Everything else in that file is
 * preserved verbatim: pi keeps other servers there and it is not ours to rewrite.
 *
 * A running pi session reads the file at startup (or on `/reload`), so the settings page says so.
 */
export function installMcp(port: number): { changed: boolean; path: string } {
  const file = mcpJsonPath();
  const conf = readJson<McpConfig>(file, {});
  const servers = (conf.mcpServers ??= {});
  const next = {
    url: mcpUrl(port),
    headers: { Authorization: `Bearer ${mcpToken()}` },
    description: "网页版 Teams（自建桥，使用你自己的登录态）：读会话、搜人、发消息",
  };
  const before = JSON.stringify(servers.teams ?? {});
  servers.teams = next;
  const changed = before !== JSON.stringify(next);
  if (changed || !fs.existsSync(file)) writeJson(file, conf);
  return { changed, path: file };
}
