import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { avatarHash, knownAvatar } from "./avatars.ts";

export const VERSION = "0.2.0";
/** 协议版本：announce / inbox 都带着它，将来换协议靠它挡掉旧对端。 */
export const PROTO = 1;

export const DEFAULT_GROUP = "239.255.42.99";
export const DEFAULT_ANNOUNCE_PORT = 7866;
export const DEFAULT_PORT = 7865;
/** 「我 → 头像」里最多保留多少张自己上传过的图（hash，最近在前）。 */
export const MAX_AVATAR_HISTORY = 24;

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
  /** 头像 id（见 `avatars.ts` 的 AVATAR_IDS）。空串 = 还没挑过，index.ts 会随机补一张。 */
  avatar: string;
  /** 自己上传过的头像 hash（最近在前）。和 avatars/ 里别人的缓存分仗靠它。 */
  avatarHistory: string[];
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

/**
 * 读一个**会回写**的状态文件：把「文件不存在」和「读失败 / 解析失败」分开。
 *
 * `readJson` 把两者都揉成 fallback，对只读调用够用；但 outbox / peers / threads 这些
 * 「开机读一次、改一次就整份写回」的存储不能这么用 —— 一次截断或 EBUSY 就会让内存从空状态
 * 长出来，下一次写回把盘上的真数据整份覆盖，且不可逆。
 */
export function readJsonChecked<T>(file: string, fallback: T): { ok: boolean; value: T; error?: string; code?: string } {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) as T };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: true, value: fallback };
    return { ok: false, value: fallback, error: (err as Error)?.message ?? String(err), code };
  }
}

/**
 * 把读不出来的状态文件原地留档，再让调用方从空状态起步。
 * 重命名失败（目录只读 / 被独占）返回 null —— 调用方应暂停落盘，别拿空状态覆盖它。
 */
export function quarantineStateFile(file: string): string | null {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${file}.corrupt-${stamp}`;
  try {
    fs.renameSync(file, bak);
    return bak;
  } catch {
    return null;
  }
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
    // 名单外的 id（手改过 / 将来删掉的头像）当没设，别让页面拿到一张画不出来的图。
    avatar: knownAvatar(saved.avatar),
    // 上传记录只存 hash；格式不对 / 重复的丢掉，顺序保持「最近在前」。hash 形状只在 avatars.ts 写一次。
    avatarHistory: Array.isArray(saved.avatarHistory)
      ? [...new Set(saved.avatarHistory.map((h) => avatarHash(h)).filter((h) => h !== ""))].slice(0, MAX_AVATAR_HISTORY)
      : [],
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
