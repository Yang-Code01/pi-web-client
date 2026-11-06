import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const VERSION = "0.1.0";
/** 协议版本：announce / inbox 都带着它，将来换协议靠它挡掉旧对端。 */
export const PROTO = 1;

export const DEFAULT_GROUP = "239.255.42.99";
export const DEFAULT_ANNOUNCE_PORT = 7866;
export const DEFAULT_PORT = 7865;

export interface PeerConfig {
  /** 本机 HTTP 端口（对端往这里投递）。 */
  port: number;
  /** 监听地址：局域网要给别的机器投递，所以默认 0.0.0.0；`/status` 另外单独限回环。 */
  bind: string;
  /** 对方看到的名字，可以自填（所以不能当身份用，见决定 16）。 */
  nickname: string;
  /** 收件箱目录，可选别的盘（决定 19/20）。 */
  inbox: string;
  hidden: boolean;
  pauseFiles: boolean;
  dnd: boolean;
  group: { address: string; port: number };
  /** 手动地址兜底：`["192.168.1.5:7865"]`。组播不通时唯一的出路。 */
  manual: string[];
}

/** `~/.pi-peer`，`PI_PEER_STATE` 可改（e2e 用它隔离两份实例）。 */
export function stateDir(): string {
  return process.env.PI_PEER_STATE || path.join(os.homedir(), ".pi-peer");
}

export function statePath(...parts: string[]): string {
  return path.join(stateDir(), ...parts);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return { ...fallback, ...(JSON.parse(fs.readFileSync(file, "utf8")) as object) } as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function defaultNickname(): string {
  let user = "pi";
  try {
    user = os.userInfo().username || user;
  } catch {
    /* 没有 userInfo 的容器里就用 pi */
  }
  return `${user} · ${os.hostname()}`;
}

export function loadConfig(): PeerConfig {
  const saved = readJson<Partial<PeerConfig>>(statePath("config.json"), {});
  const group = saved.group ?? { address: DEFAULT_GROUP, port: DEFAULT_ANNOUNCE_PORT };
  return {
    port: Number(process.env.PI_PEER_PORT || saved.port || DEFAULT_PORT),
    bind: process.env.PI_PEER_BIND || saved.bind || "0.0.0.0",
    nickname: process.env.PI_PEER_NICKNAME || saved.nickname || defaultNickname(),
    inbox: process.env.PI_PEER_INBOX || saved.inbox || statePath("inbox"),
    hidden: saved.hidden === true,
    pauseFiles: saved.pauseFiles === true,
    dnd: saved.dnd === true,
    group: {
      address: process.env.PI_PEER_GROUP || group.address,
      port: Number(process.env.PI_PEER_ANNOUNCE_PORT || group.port),
    },
    manual: Array.isArray(saved.manual) ? saved.manual.filter((s) => typeof s === "string") : [],
  };
}

/**
 * 把生效中的配置写回 `config.json`。
 *
 * 只给「运行中能改的开关」用（隐身 / 免打扰 / 暂停收文件）：这些值改完必须活过重启，
 * 否则页面上拨了开关、下次开 pi 又弹回去。env 覆盖出来的值也照写——写的是用户此刻
 * 看到的那份配置，不是重新推导的。
 */
export function saveConfig(cfg: PeerConfig): void {
  fs.mkdirSync(stateDir(), { recursive: true });
  writeJson(statePath("config.json"), cfg);
}

/**
 * nodeId：一台机器一个稳定 uuid（决定 6）。它只代表「这台机器的这份 state」——换机器、
 * 删掉 state 目录都是新身份，所以不能拿它当「人」用。
 */
export function ensureNodeId(): string {
  const file = statePath("nodeId");
  try {
    const id = fs.readFileSync(file, "utf8").trim();
    if (id) return id;
  } catch {
    /* 第一次跑 */
  }
  const id = crypto.randomUUID();
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(file, `${id}\n`);
  return id;
}
