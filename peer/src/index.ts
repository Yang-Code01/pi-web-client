import fs from "node:fs";
import { loadConfig, ensureNodeId, stateDir, statePath, saveConfig, PROTO, VERSION } from "./config.ts";
import { randomAvatar } from "./avatars.ts";
import { Discovery } from "./discovery.ts";
import { createPeerServer, Ignored } from "./http.ts";
import { History } from "./history.ts";
import { Outbox } from "./outbox.ts";
import { Messages, uuidv7 } from "./messages.ts";
import { Reads } from "./reads.ts";
import { Relations } from "./peers.ts";
import { Files } from "./files.ts";
import { LocalActivity } from "./presence.ts";
import { Threads } from "./threads.ts";
import { Groups } from "./groups.ts";

const cfg = loadConfig();
const nodeId = ensureNodeId();

// 第一次启动（配置里还没头像）就随机挑一张并落盘。**只挑这一次**：头像每重启一次就换一个的话，
// 别人那边看着莫名其妙，自己也无从认起。之后换头像只走页面上的「我 → 头像」。
if (!cfg.avatar) {
  cfg.avatar = randomAvatar();
  saveConfig(cfg);
}

const log = (msg: string): void => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(statePath("logs"), { recursive: true });
    fs.appendFileSync(statePath("logs", "peer.log"), `${line}\n`);
  } catch {
    /* 日志写不进去不影响收发 */
  }
};

// 和 bridge 一样：单个 stream 报错不该带走整个进程（PEER 一死，在线列表和半截文件全断）。
process.on("uncaughtException", (err) => log(`uncaughtException: ${(err as Error)?.stack ?? err}`));
process.on("unhandledRejection", (err) => log(`unhandledRejection: ${(err as Error)?.stack ?? err}`));

const discovery = new Discovery(cfg, nodeId, log);
// 在线名单的变化不再写日志（用户要求）：prune 每 5 秒就 emit 一次 change，announce 每 10 秒也来一次，
// 早先那句「在线 N 台」会把控制台和 peer.log 一直刷下去。现在要看人数去页面的内网通里看。

// P4：away 由「最后一次活动」推出来，announce 每 10 秒把当前状态带上。
const activity = new LocalActivity();
discovery.setLocalStatus(() => (cfg.hidden ? "hidden" : activity.status()));

const history = new History(log);
const relations = new Relations(log);
const ignored = new Ignored(log);
const threads = new Threads(log);
const groups = new Groups(log);
const reads = new Reads(log);
const messages = new Messages({ cfg, nodeId, discovery, history, outbox: null as never, relations, groups, reads, log });
// 回环没注入 outbox 之前先建好：`deliver` 只依赖网络，`settled` 才依赖 outbox 本身。
const outbox = new Outbox({
  log,
  deliver: (item) => messages.deliver(item),
  locate: (peerId) => discovery.byId(peerId),
  settled: (item, verdict) => {
    // 文字与记录包是「一条消息」，要回执（页面靠它画已送达 / 发送失败 + 重发）；
    // 好友请求/接受在通讯录里已经有了自己的状态。记录包以前漏在这里：送达后状态一直是空的。
    if (item.kind !== "text" && item.kind !== "note") {
      if (!verdict.ok) log(`控制消息 ${item.kind} → ${item.addr}:${item.port} 没送到：${verdict.error}`);
      return;
    }
    const status = verdict.ok ? "delivered" : "failed";
    const thread = item.thread ?? item.peerId;
    const msgId = item.msgId ?? item.id;
    if (item.thread && !verdict.ok) {
      // 群：某个人没送到不把整条标红。只有「谁都没送到、也没人在排队了」才记一条失败。
      log(`群消息 ${msgId.slice(0, 8)} → ${item.peerId.slice(0, 8)} 没送到：${verdict.error}`);
      const queued = outbox.pending().some((other) => other.msgId === msgId);
      const delivered = history.read(thread, 2000).some((e) => e.kind === "receipt" && e.ack?.id === msgId && e.ack.status === "delivered");
      if (queued || delivered) return;
    }
    history.append(thread, {
      id: uuidv7(),
      at: Date.now(),
      from: { nodeId, nickname: cfg.nickname, port: cfg.port },
      to: item.thread ? { kind: "group", id: thread } : { kind: "node", id: item.peerId },
      kind: "receipt",
      ack: { id: msgId, status, ...(verdict.ok ? {} : { error: verdict.error }) },
    });
    if (!verdict.ok) log(`投递失败 ${item.id.slice(0, 8)} → ${item.addr}:${item.port}：${verdict.error}`);
  },
});
messages.attachOutbox(outbox);

const files = new Files({
  cfg,
  nodeId,
  discovery,
  history,
  log,
  groupMembers: (id) => {
    const group = groups.get(id);
    if (!group || group.left) return null;
    return group.members.map((m) => m.nodeId).filter((m) => m !== nodeId);
  },
  groupAnnounceOnly: (id) => {
    const group = groups.get(id);
    if (!group || group.left) return null;
    return {
      announceOnly: group.announceOnly === true,
      publisher: group.publisher,
      owner: group.owner,
      members: group.members.map((m) => m.nodeId),
    };
  },
});

const server = createPeerServer({ cfg, nodeId, discovery, history, messages, relations, files, ignored, threads, activity, groups });

server.on("error", (err: NodeJS.ErrnoException) => {
  // 端口被占 = 已经有一份 peer 在跑。直接退出而不是自动换端口：bridge 要能看出「没起来」。
  log(`监听 ${cfg.bind}:${cfg.port} 失败：${err.message}`);
  process.exit(err.code === "EADDRINUSE" ? 2 : 1);
});

server.listen(cfg.port, cfg.bind, () => {
  log(`peer ${VERSION} (proto ${PROTO}) — ${cfg.nickname} — ${cfg.bind}:${cfg.port} — state ${stateDir()}`);
  log(`收件目录 ${cfg.inbox}`);
  if (cfg.hidden) log("隐身：只收不发，不会出现在别人的在线列表里");
  discovery.start();
  outbox.start();
});

const shutdown = (sig: string): void => {
  log(`收到 ${sig}，退出`);
  discovery.stop();
  outbox.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
