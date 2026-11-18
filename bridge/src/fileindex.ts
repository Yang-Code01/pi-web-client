import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * 全盘文件索引（#未编号 · D321）。
 *
 * 为什么是这儿的一套而不是抄 Everything：Everything 快是因为拿管理员权限 `FSCTL_ENUM_USN_DATA`
 * 直读 NTFS 的 MFT。那套在非 Windows、没有管理员权限的机器上直接不存在，所以这里退一步 ——
 * 首次全盘遍历一次（30–90 s，后台、可暂停），之后 `fs.watch` 增量，模糊查询 ~100 ms（100 万行实测）。
 *
 * 三条硬约束（都是实测出来的，改之前先读 `.scratch/filesearch/bench.mjs` 的数字）：
 * 1. **不上 FTS5 / trigram**：只把 100 ms 降到 1 ms，库翻倍。前缀查询本来就走 `nlow` 索引（0.4 ms）。
 * 2. **SQLite 只开一个连接、同步 API**：`node:sqlite` 没有异步版本，靠「500 行一个事务 + 让出事件循环」
 *    把单次阻塞压在 1–3 ms，不让一份索引拖慢正在跑的会话。
 * 3. **`node:sqlite` 用动态 import**：Node 22.5–22.12 需要 `--experimental-sqlite`，静态 import 会让
 *    那些机器上的 bridge 直接起不来。拿不到就把 `state` 留在 `error`，面板显示原因，其余功能照常。
 */

type SqliteDB = import("node:sqlite").DatabaseSync;
type SqliteStatement = import("node:sqlite").StatementSync;

export type IndexState = "off" | "scanning" | "paused" | "ready" | "error";

export interface VolumeInfo {
  id: string;
  count: number;
  enabled: boolean;
}

export interface IndexStatus {
  state: IndexState;
  /** 库里的行数。 */
  indexed: number;
  /** 本轮扫描已经访问过的条目（进度用，扫完等于 indexed 附近）。 */
  scanned: number;
  /** 正在读的目录，扫描时给面板当「进度条」的说明。 */
  currentPath: string;
  volumes: VolumeInfo[];
  dbBytes: number;
  lastScanAt: number;
  message: string;
}

export interface FileRow {
  path: string;
  name: string;
  dir: string;
  size: number;
  mtime: number;
  isDir: boolean;
  vol: string;
}

export interface QueryOptions {
  volumes?: string[];
  sort?: "name" | "size" | "mtime";
  offset?: number;
  limit?: number;
}

export interface QueryResult {
  rows: FileRow[];
  ms: number;
  /** 还有更多（`offset + rows.length` 之后）。 */
  truncated: boolean;
}

/** 不进入的目录：都是「几万个文件但用户从不按名字找」的。`WinSxS` 单个就有 20 万条硬链接。 */
const SKIP = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "$Recycle.Bin",
  "System Volume Information",
  "WinSxS",
  "Windows.old",
]);

const BATCH = 500;
const LIMIT_DEFAULT = 200;
const LIMIT_MAX = 1000;

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `LIKE` 的通配符转义（`%` `_` 与转义符本身）。 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 根目录 → 卷标识：Windows 是 `C:`，其余平台统一 `/`。 */
export function volumeOf(root: string): string {
  return process.platform === "win32" && /^[A-Za-z]:/.test(root) ? root.slice(0, 2).toUpperCase() : "/";
}

/** 本机可扫的根：Windows 枚举 A–Z 里能读的盘，其余平台只 `/`。测试用 `PI_WEB_FILEINDEX_ROOTS` 顶掉。 */
export function defaultRoots(): string[] {
  const configured = (process.env.PI_WEB_FILEINDEX_ROOTS ?? "").trim();
  if (configured) return configured.split(path.delimiter).map((p) => p.trim()).filter(Boolean);
  if (process.platform !== "win32") return ["/"];
  const roots: string[] = [];
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    try {
      if (fs.statSync(root).isDirectory()) roots.push(root);
    } catch {
      // 没插的盘、没权限的盘：跳过。
    }
  }
  return roots;
}

function basenameOf(abs: string): string {
  const i = Math.max(abs.lastIndexOf("/"), abs.lastIndexOf("\\"));
  return i >= 0 ? abs.slice(i + 1) : abs;
}

function dirOf(abs: string): string {
  const i = Math.max(abs.lastIndexOf("/"), abs.lastIndexOf("\\"));
  return i > 0 ? abs.slice(0, i) : abs;
}

export class FileIndex {
  private db: SqliteDB | null = null;
  private dbFile: string;
  private roots: string[];
  private enabled: Set<string> | null = null;
  private gen = 0;
  private scanGen = 0;
  private stateValue: IndexState = "off";
  private indexed = 0;
  private scanned = 0;
  private currentPath = "";
  private message = "";
  private paused = false;
  private cancelled = false;
  private scanning: Promise<void> | null = null;
  private watchers: fs.FSWatcher[] = [];
  private watchTimers = new Map<string, NodeJS.Timeout>();
  private listeners = new Set<(status: IndexStatus) => void>();
  private lastScanAt = 0;
  /** 分卷计数：只在扫描收尾 / 开库时查一次，`status()` 不再扫表（100 万行的 GROUP BY 是 100 ms 量级）。 */
  private volCounts = new Map<string, number>();
  private upsert: SqliteStatement | null = null;
  private remove: SqliteStatement | null = null;
  private readonly log: (line: string) => void;

  constructor(opts: { dbFile: string; roots?: string[]; log?: (line: string) => void }) {
    this.dbFile = opts.dbFile;
    this.roots = opts.roots ?? defaultRoots();
    this.log = opts.log ?? (() => {});
  }

  // ---------------------------------------------------------------- lifecycle

  async open(): Promise<void> {
    if (process.env.PI_WEB_FILEINDEX === "0") {
      this.stateValue = "off";
      this.message = "索引已关闭（PI_WEB_FILEINDEX=0）";
      return;
    }
    try {
      const { DatabaseSync } = await import("node:sqlite");
      fs.mkdirSync(path.dirname(this.dbFile), { recursive: true });
      const db = new DatabaseSync(this.dbFile);
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("PRAGMA synchronous=NORMAL");
      db.exec("PRAGMA cache_size=-64000");
      db.exec(`
        CREATE TABLE IF NOT EXISTS files(
          path TEXT PRIMARY KEY,
          nlow TEXT NOT NULL,
          size INTEGER NOT NULL DEFAULT 0,
          mtime INTEGER NOT NULL DEFAULT 0,
          is_dir INTEGER NOT NULL DEFAULT 0,
          vol TEXT NOT NULL,
          gen INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_files_nlow ON files(nlow);
        CREATE INDEX IF NOT EXISTS idx_files_vol ON files(vol);
        CREATE INDEX IF NOT EXISTS idx_files_gen ON files(gen);
        CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
      `);
      this.upsert = db.prepare(
        `INSERT INTO files(path,nlow,size,mtime,is_dir,vol,gen) VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(path) DO UPDATE SET nlow=excluded.nlow, size=excluded.size, mtime=excluded.mtime,
           is_dir=excluded.is_dir, vol=excluded.vol, gen=excluded.gen`,
      );
      this.remove = db.prepare("DELETE FROM files WHERE path = ?");
      this.db = db;
      this.gen = Number(db.prepare("SELECT COALESCE(MAX(gen), 0) g FROM files").get()?.g ?? 0);
      this.indexed = Number(db.prepare("SELECT COUNT(*) c FROM files").get()?.c ?? 0);
      const stored = db.prepare("SELECT v FROM meta WHERE k = 'volumes'").get()?.v;
      if (typeof stored === "string" && stored) {
        try {
          const ids: unknown = JSON.parse(stored);
          if (Array.isArray(ids)) this.enabled = new Set(ids.filter((v): v is string => typeof v === "string"));
        } catch {
          // 存坏了就当没设置过：全部卷都扫。
        }
      }
      const last = db.prepare("SELECT v FROM meta WHERE k = 'lastScanAt'").get()?.v;
      if (typeof last === "string") this.lastScanAt = Number(last) || 0;
      // 上次扫描没走完（库里只有前半截）：告诉调用方需要重扫，别把半套索引当就绪。
      const interrupted = db.prepare("SELECT v FROM meta WHERE k = 'scanStartedAt'").get()?.v;
      this.refreshCounts();
      this.stateValue = this.indexed > 0 && !interrupted ? "ready" : "off";
      if (interrupted) this.message = "上次扫描没扫完，重新扫一遍";
    } catch (ex) {
      this.stateValue = "error";
      this.message = `索引不可用：${ex instanceof Error ? ex.message : String(ex)}`;
      return;
    }
    this.watchAll();
  }

  close(): void {
    this.cancelled = true;
    for (const timer of this.watchTimers.values()) clearTimeout(timer);
    this.watchTimers.clear();
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // 已经关掉的 watcher 再关一次会抛，忽略。
      }
    }
    this.watchers = [];
    try {
      this.db?.close();
    } catch {
      // 同上：退出路径上不该因为一句 close 失败而卡住进程。
    }
    this.db = null;
    this.listeners.clear();
  }

  onChange(fn: (status: IndexStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private publish(): void {
    const status = this.status();
    for (const fn of this.listeners) {
      try {
        fn(status);
      } catch {
        // 监听者（一次 ws 广播）出错不该把扫描带停。
      }
    }
  }

  // ---------------------------------------------------------------- status

  status(): IndexStatus {
    const volumes: VolumeInfo[] = this.roots.map((root) => {
      const id = volumeOf(root);
      return { id, count: this.volCounts.get(id) ?? 0, enabled: this.isEnabled(id) };
    });
    let dbBytes = 0;
    try {
      dbBytes = fs.statSync(this.dbFile).size;
    } catch {
      dbBytes = 0;
    }
    return {
      state: this.stateValue,
      indexed: this.indexed,
      scanned: this.scanned,
      currentPath: this.currentPath,
      volumes,
      dbBytes,
      lastScanAt: this.lastScanAt,
      message: this.message,
    };
  }

  // ---------------------------------------------------------------- scan

  /** 开一轮扫描。已经在扫就什么都不做（面板按钮可以安心连点）。 */
  start(rebuild = false): void {
    if (!this.db || this.stateValue === "error" || this.scanning) return;
    if (rebuild) {
      try {
        this.db.exec("DELETE FROM files");
        this.indexed = 0;
        this.volCounts.clear();
      } catch {
        return;
      }
    }
    this.cancelled = false;
    this.paused = false;
    this.scanning = this.runScan()
      .catch((ex: any) => {
        this.stateValue = "error";
        this.message = `扫描失败：${String(ex?.message ?? ex)}`;
      })
      .finally(() => {
        this.scanning = null;
        this.currentPath = "";
        this.publish();
      });
  }

  pause(): void {
    if (this.stateValue !== "scanning") return;
    this.paused = true;
    this.stateValue = "paused";
    this.publish();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.scanning) this.stateValue = "scanning";
    this.publish();
  }

  private async runScan(): Promise<void> {
    const db = this.db;
    if (!db) return;
    // gen 每轮 +1：本轮见过的高过它，扫完把旧 gen 的行删掉 —— 关机期间被删的文件就是这样消失的。
    this.scanGen = ++this.gen;
    this.scanned = 0;
    this.stateValue = "scanning";
    // 扫到一半进程被杀（bridge 重启、关窗口）时库里只落了一半的行，而 lastScanAt 不会写。
    // 留个 scanStartedAt：下次 open() 看见它就知道「该重扫」，否则半套索引会被当成已经就绪。
    db.prepare("INSERT INTO meta(k, v) VALUES('scanStartedAt', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(Date.now()));
    this.publish();

    const started = performance.now();
    const stack = [...this.roots];
    let batch: Array<[string, string, number, number, number, string, number]> = [];
    let sincePublish = 0;

    const flush = (): void => {
      if (!batch.length || !this.upsert) return;
      db.exec("BEGIN");
      try {
        for (const row of batch) this.upsert.run(...row);
        db.exec("COMMIT");
      } catch (ex) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // 事务已经不在：忽略。
        }
        throw ex;
      }
      batch = [];
    };

    try {
      while (stack.length) {
        if (this.cancelled) return;
        if (this.paused) {
          flush();
          await sleep(200);
          continue;
        }
        const dir = stack.pop() ?? "";
        if (!dir) continue;
        let dh: fs.Dir;
        try {
          dh = await fsp.opendir(dir);
        } catch {
          continue;
        }
        this.currentPath = dir;
        try {
          for await (const ent of dh) {
            if (this.paused || this.cancelled) break;
            const abs = path.join(dir, ent.name);
            let size = 0;
            let mtime = 0;
            let isDir = ent.isDirectory();
            if (isDir) {
              if (SKIP.has(ent.name)) continue;
              stack.push(abs);
            } else {
              // 目录的体积 / 时间没人看，省掉这一万次系统调用里的一半。
              try {
                const st = await fsp.lstat(abs);
                size = st.size;
                mtime = st.mtimeMs;
                isDir = st.isDirectory();
                if (isDir) {
                  stack.push(abs);
                }
              } catch {
                continue;
              }
            }
            batch.push([abs, ent.name.toLowerCase(), size, Math.round(mtime), isDir ? 1 : 0, volumeOf(dir), this.scanGen]);
            this.scanned += 1;
            if (batch.length >= BATCH) {
              flush();
              await tick();
              sincePublish += BATCH;
              if (sincePublish >= 5000) {
                sincePublish = 0;
                // 扫描期用已扫条数近似「库里有几条」——再跑一次 COUNT(*) 只是把扫描拖慢一倍。
                this.indexed = this.scanned;
                this.publish();
              }
            }
          }
        } finally {
          await dh.close().catch(() => undefined);
        }
      }
      flush();
      // 本轮没再见的行：删。再顺手把库里现有行数采一次，state 转 ready 之前一定是真值。
      db.prepare("DELETE FROM files WHERE gen != ?").run(this.scanGen);
      db.prepare("DELETE FROM meta WHERE k = 'scanStartedAt'").run();
      db.prepare("INSERT INTO meta(k, v) VALUES('lastScanAt', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(Date.now()));
      this.lastScanAt = Date.now();
      this.refreshCounts();
      this.stateValue = "ready";
      this.message = "";
      this.reportScan(started);
    } catch (ex) {
      flush();
      throw ex;
    }
  }

  // ---------------------------------------------------------------- volumes

  private isEnabled(id: string): boolean {
    // null = 从没设过（全开）；空集合 = 用户把卷全勾掉了（全关）—— 两种状态不能混成一个。
    if (!this.enabled) return true;
    return this.enabled.has(id);
  }

  private activeRoots(): string[] {
    return this.roots.filter((root) => this.isEnabled(volumeOf(root)));
  }

  setVolumes(ids: string[]): void {
    const known = new Set(this.roots.map((root) => volumeOf(root)));
    this.enabled = new Set(ids.filter((id) => known.has(id)));
    const db = this.db;
    if (db) {
      try {
        db.prepare("INSERT INTO meta(k, v) VALUES('volumes', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify([...this.enabled]));
      } catch {
        // 落盘失败只是下次启动要重设一次，不该让这次勾选失败。
      }
    }
    this.watchAll();
    this.publish();
  }

  // ---------------------------------------------------------------- watch

  private watchAll(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // 见 close()。
      }
    }
    this.watchers = [];
    for (const root of this.activeRoots()) {
      try {
        const w = fs.watch(root, { recursive: true }, (_ev, filename) => {
          if (!filename) return;
          const abs = path.join(root, filename.toString());
          this.noteChange(abs);
        });
        w.on("error", () => {
          // 根被拔掉 / 没权限：这一卷退回「只能靠下次重扫」。
        });
        this.watchers.push(w);
      } catch {
        // `recursive` 在某些平台上不支持：没有它也能搜，只是不实时。
      }
    }
  }

  private noteChange(abs: string): void {
    const existing = this.watchTimers.get(abs);
    if (existing) clearTimeout(existing);
    this.watchTimers.set(
      abs,
      setTimeout(() => {
        this.watchTimers.delete(abs);
        void this.syncPath(abs);
      }, 800),
    );
  }

  /** 把总数与分卷计数从库里采一次（扫完、开库、删库后各一次，不进热路径）。 */
  private refreshCounts(): void {
    const db = this.db;
    if (!db) return;
    const counts = new Map<string, number>();
    try {
      for (const row of db.prepare("SELECT vol, COUNT(*) c FROM files GROUP BY vol").all()) {
        counts.set(String(row.vol), Number(row.c));
      }
      this.indexed = Number(db.prepare("SELECT COUNT(*) c FROM files").get()?.c ?? 0);
    } catch {
      return;
    }
    this.volCounts = counts;
  }

  /** 扫描收尾的一行日志（bridge 的 log 在 index.ts，这里只回状态；耗时给状态对象外的日志用）。 */
  private reportScan(started: number): void {
    const seconds = (performance.now() - started) / 1000;
    for (const fn of this.listeners) {
      try {
        fn(this.status());
      } catch {
        // 同 publish()：监听者出错不该影响扫描收尾。
      }
    }
    if (process.env.PI_WEB_FILEINDEX_VERBOSE === "1") {
      this.log(`fileindex: scanned ${this.indexed} entries in ${seconds.toFixed(1)}s`);
    }
  }

  /** 一次 watch 事件的落地：还在就 upsert，没了就删（整棵子树被删时只删这一个，靠下次重扫收尾）。 */
  private async syncPath(abs: string): Promise<void> {
    if (!this.upsert || !this.remove) return;
    const name = basenameOf(abs);
    if (SKIP.has(name)) return;
    if (this.stateValue === "scanning" || this.stateValue === "paused") return;
    try {
      const st = await fsp.lstat(abs);
      this.upsert.run(abs, name.toLowerCase(), st.size, Math.round(st.mtimeMs), st.isDirectory() ? 1 : 0, volumeOf(abs), this.gen);
    } catch {
      try {
        this.remove.run(abs);
      } catch {
        // 已经不在库里：无事可做。
      }
    }
    this.publish();
  }

  // ---------------------------------------------------------------- query

  query(rawq: string, opts: QueryOptions = {}): QueryResult {
    const started = performance.now();
    const db = this.db;
    if (!db) return { rows: [], ms: 0, truncated: false };
    const limit = Math.min(LIMIT_MAX, Math.max(1, Math.round(opts.limit ?? LIMIT_DEFAULT)));
    const offset = Math.max(0, Math.round(opts.offset ?? 0));
    const q = rawq.trim();
    const filter = this.volFilter(opts.volumes);
    // null = 范围是空集（卷全被勾掉），不是「不限范围」。
    if (!filter) return this.toResult([], limit, started);
    const volSql = filter.sql;
    const volArgs: string[] = filter.args;

    if (!q) {
      const order = this.emptyOrder(opts.sort);
      const emptySql = `SELECT path, nlow, size, mtime, is_dir, vol FROM files WHERE 1=1${volSql} ORDER BY ${order} LIMIT ? OFFSET ?`;
      const rows = db.prepare(emptySql).all(...volArgs, limit + 1, offset);
      return this.toResult(rows, limit, started);
    }

    const low = q.toLowerCase();
    const glob = escapeLike(low);
    const order = this.orderSql(opts.sort);
    const cols = "SELECT path, nlow, size, mtime, is_dir, vol FROM files";
    const seen = new Set<string>();
    const out: any[] = [];
    const take = (rows: any[]): void => {
      for (const row of rows) {
        const key = String(row.path);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(row);
        if (out.length >= limit + 1) return;
      }
    };

    // 拼的只有排序键与占位符个数：`orderSql()` 只返回三个字面量之一，`volArgs` 全是绑定值。
    const prefixSql = `${cols} WHERE nlow LIKE ? ESCAPE '\\'${volSql} ORDER BY ${order} LIMIT ?`;
    const prefixStmt = db.prepare(prefixSql);
    // 第一段：名字前缀 —— 走 idx_files_nlow，100 万行 0.4 ms。搜索框逐键都先走这条。
    take(prefixStmt.all(`${glob}%`, ...volArgs, limit + 1));
    // 第二段：还不够才补子串（名字或整条路径）。全表扫 ~100 ms，所以只在必要时跑。
    if (out.length < limit + 1) {
      const excluded = out.map(() => "?").join(",") || "''";
      const subSql = `${cols} WHERE (nlow LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\') AND path NOT IN (${excluded})${volSql} ORDER BY ${order} LIMIT ?`;
      const subStmt = db.prepare(subSql);
      take(subStmt.all(`%${glob}%`, `%${glob}%`, ...out.map((r) => String(r.path)), ...volArgs, limit + 1));
    }
    return this.toResult(out, limit, started);
  }

  /**
   * 卷过滤片段。调用方显式给范围就用它，没给就服从「这台机器上勾掉的卷」；
   * 返回 null 表示范围是个空集 —— 调用方必须当场回空，不能退化成「不过滤」。
   */
  private volFilter(optsVolumes?: string[]): { sql: string; args: string[] } | null {
    const wanted = optsVolumes ?? (this.enabled ? [...this.enabled] : null);
    if (!wanted) return { sql: "", args: [] };
    const vols = wanted.filter((v) => this.roots.some((root) => volumeOf(root) === v));
    if (!vols.length) return null;
    return { sql: ` AND vol IN (${vols.map(() => "?").join(",")})`, args: vols };
  }

  /** 排序键：只认三个字面量，任何别的一律回「按名字」。 */
  private orderSql(sort: QueryOptions["sort"]): string {
    if (sort === "size") return "size DESC";
    if (sort === "mtime") return "mtime DESC";
    return "nlow";
  }

  /** 空查询（刚打开面板）的默认排序：最近改动的在前，和 Everything / 文件管理器一致。 */
  private emptyOrder(sort: QueryOptions["sort"]): string {
    if (sort === "name") return "nlow";
    if (sort === "size") return "size DESC";
    return "mtime DESC";
  }

  private toResult(rows: any[], limit: number, started: number): QueryResult {
    const truncated = rows.length > limit;
    const sliced = truncated ? rows.slice(0, limit) : rows;
    return {
      rows: sliced.map((row) => {
        const abs = String(row.path);
        return {
          path: abs,
          name: basenameOf(abs),
          dir: dirOf(abs),
          size: Number(row.size ?? 0),
          mtime: Number(row.mtime ?? 0),
          isDir: Number(row.is_dir ?? 0) === 1,
          vol: String(row.vol ?? ""),
        };
      }),
      ms: Math.round((performance.now() - started) * 10) / 10,
      truncated,
    };
  }
}
