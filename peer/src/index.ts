import fs from "node:fs";
import { loadConfig, ensureNodeId, stateDir, statePath, PROTO, VERSION } from "./config.ts";
import { Discovery } from "./discovery.ts";
import { createPeerServer, Ignored } from "./http.ts";
import { History } from "./history.ts";
import type { Msg } from "./model.ts";
import { Outbox } from "./outbox.ts";
import { Messages } from "./messages.ts";
import { Relations } from "./peers.ts";
import { Store } from "./store.ts";
import { Files } from "./files.ts";

const cfg = loadConfig();
const nodeId = ensureNodeId();

const log = (msg: string): void => {
  const line = `${new Date().toISOString()} ${msg}`;
  // 写 stdout 而不是 console.log：日志规则（D37）只允许 console.error，而这里就是它的正常出口。
  process.stdout.write(`${line}\n`);
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

const store = new Store(log);
const history = new History(log, nodeId);
const relations = new Relations(log);
const ignored = new Ignored(log);
const messages = new Messages({ cfg, nodeId, discovery, history, outbox: null as never, relations, store, log });

/**
 * 一条消息扇出给多个人时（群聊），状态要等所有投递都有一个结果再定：
 * 有一个送到就算「已送达」，全都失败才红。所以这里按消息 id 记一笔在途账。
 */
const inflight = new Map<string, { left: number; ok: boolean }>();

// 回环没注入 outbox 之前先建好：`deliver` 只依赖网络，`settled` 才依赖 outbox 本身。
const outbox = new Outbox({
  log,
  deliver: (item) => messages.deliver(item),
  settled: (item, verdict) => {
    if (item.kind !== "msg") {
      if (!verdict.ok) log(`控制消息 ${item.kind} → ${item.addr}:${item.port} 没送到：${verdict.error}`);
      return;
    }
    const payload = item.payload as { msg: Msg; target?: string; total?: number };
    const { conv, id } = payload.msg;
    const book = inflight.get(id) ?? { left: payload.total ?? 1, ok: false };
    book.left -= 1;
    if (verdict.ok) {
      book.ok = true;
      // 先给一个「已送达」，气泡不会一直转圈；最后如果全军覆没再补一条 failed。
      const current = history.byId(conv, id);
      if (current?.sendStatus === "sending") history.appendPatch(conv, id, { sendStatus: "success" });
    }
    if (book.left > 0) {
      inflight.set(id, book);
      return;
    }
    inflight.delete(id);
    if (!book.ok) {
      history.appendPatch(conv, id, { sendStatus: "failed" });
      log(`投递失败 ${id.slice(0, 8)} → ${item.addr}:${item.port}：${verdict.ok ? "" : verdict.error}`);
    }
  },
});
messages.attachOutbox(outbox);

const files = new Files({ cfg, nodeId, discovery, history, relations, store, log });

const server = createPeerServer({ cfg, nodeId, discovery, history, messages, relations, files, ignored, store });

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
