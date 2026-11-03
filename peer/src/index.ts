import fs from "node:fs";
import { loadConfig, ensureNodeId, stateDir, statePath, PROTO, VERSION } from "./config.ts";
import { Discovery } from "./discovery.ts";
import { createPeerServer } from "./http.ts";
import { History } from "./history.ts";
import { Outbox } from "./outbox.ts";
import { Messages, uuidv7 } from "./messages.ts";
import { Relations } from "./peers.ts";

const cfg = loadConfig();
const nodeId = ensureNodeId();

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
discovery.on("change", (online: unknown[]) => log(`在线 ${online.length} 台`));

const history = new History(log);
const relations = new Relations(log);
const messages = new Messages({ cfg, nodeId, discovery, history, outbox: null as never, relations, log });
// 回环没注入 outbox 之前先建好：`deliver` 只依赖网络，`settled` 才依赖 outbox 本身。
const outbox = new Outbox({
  log,
  deliver: (item) => messages.deliver(item),
  settled: (item, verdict) => {
    // 只有文字需要回执；好友请求/接受在通讯录里已经有了自己的状态。
    if (item.kind !== "text") {
      if (!verdict.ok) log(`控制消息 ${item.kind} → ${item.addr}:${item.port} 没送到：${verdict.error}`);
      return;
    }
    const status = verdict.ok ? "delivered" : "failed";
    history.append(item.peerId, {
      id: uuidv7(),
      at: Date.now(),
      from: { nodeId, nickname: cfg.nickname, port: cfg.port },
      to: { kind: "node", id: item.peerId },
      kind: "receipt",
      ack: { id: item.id, status, ...(verdict.ok ? {} : { error: verdict.error }) },
    });
    if (!verdict.ok) log(`投递失败 ${item.id.slice(0, 8)} → ${item.addr}:${item.port}：${verdict.error}`);
  },
});
messages.attachOutbox(outbox);

const server = createPeerServer({ cfg, nodeId, discovery, history, messages, relations });

server.on("error", (err: NodeJS.ErrnoException) => {
  // 端口被占 = 已经有一份 peer 在跑。直接退出而不是自动换端口：bridge 要能看出「没起来」。
  log(`监听 ${cfg.bind}:${cfg.port} 失败：${err.message}`);
  process.exit(err.code === "EADDRINUSE" ? 2 : 1);
});

server.listen(cfg.port, cfg.bind, () => {
  log(`peer ${VERSION} (proto ${PROTO}) — ${cfg.nickname} — ${cfg.bind}:${cfg.port} — state ${stateDir()}`);
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
