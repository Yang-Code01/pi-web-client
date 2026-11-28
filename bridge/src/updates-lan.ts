import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readJsonChecked, statePath, writeJson } from "./paths.ts";
import { whatsnewBatches, type WhatsnewBatch } from "./whatsnew.ts";
import type { PeerGroup, PeerHost } from "./peer.ts";

/**
 * D441：局域网更新组。发布者定时看自己检出里的 `origin/main`，有新提交就往「固定 id 的只读群」
 * 里推一条公告；同仓库的机器靠 announce 里的仓库标识被自动拉进这个组。
 *
 * 没有服务器、没有注册表：仓库标识就是 `owner/name`，组 id 从它派生（`grp-updates-<slug>`），
 * 所以两台机器各自算出同一个组 id 才算「同一个更新组」。
 *
 * 发布者只做四件事：`git fetch` → 比对上次播报的 commit → 保证组和人都在 → 发一条公告。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const run = promisify(execFile);

/** 扫描间隔（决定里的「最短 30 分钟」就是这个：定时器本身就是节流）。 */
const INTERVAL_MS = 30 * 60_000;
/** 启动后先等内网通把 announce 收一圈，再去看第一次。 */
const FIRST_CHECK_MS = 30_000;
/** 拉人循环：成员新上线 / 新装本项目的机器，10 秒内被拉进组。 */
const INVITE_MS = 10_000;
/** git 命令超时：fetch 卡住时别把整个进程拖住。 */
const GIT_TIMEOUT_MS = 20_000;
const MAX_COMMIT_SUBJECTS = 20;

export interface UpdatesState {
  /** 上次播报到哪个 commit（短 SHA，7 位）。 */
  lastCommit: string;
  /** 上次播报那条公告的批次标题：下次从它往前切 `whatsnewBatches()`。 */
  lastBatchTitle: string;
  lastAnnouncedAt: number;
  lastCheckAt: number;
  /** 最近一次失败的原因（成功就清空）。 */
  lastError: string;
}

export interface UpdatesView {
  ok: true;
  /** 这个检出是不是认得出仓库（有 git remote origin）。 */
  available: boolean;
  repo: string;
  groupId: string;
  groupName: string;
  /** 这台机器是不是发布者（来自 peer config，是唯一权威）。 */
  publisher: boolean;
  /** 本机在不在这个组里（退过就 false，设置页给「重新加入」）。 */
  joined: boolean;
  memberCount: number;
  onlineCount: number;
  lastCommit: string;
  lastBatchTitle: string;
  lastAnnouncedAt: number;
  lastCheckAt: number;
  lastError: string;
  /** 本机有没有热部署入口：决定公告卡片上的「怎么更新」写哪一种。 */
  hotdeploy: boolean;
  peerRunning: boolean;
}

interface RepoInfo {
  repo: string;
  groupId: string;
  groupName: string;
}

/** `git@host:owner/name.git`、`https://host/owner/name`、`ssh://git@host/owner/name` 都认。 */
export function repoSlugFromRemote(url: string): string | null {
  const s = url.trim();
  const m =
    /^git@([\w.-]+):([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(s) ??
    /^ssh:\/\/git@([\w.-]+)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(s) ??
    /^https?:\/\/(?:[^@/]+@)?([\w.-]+)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(s);
  if (!m) return null;
  return `${m[2]}/${m[3]}`;
}

/** 组 id 只允许字母、数字、下划线与短横线（peer 侧会校验），所以 slug 也要归一。 */
export function groupIdFor(repo: string): string {
  const slug = repo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `grp-updates-${slug || "repo"}`;
}

export class UpdatesLan {
  private readonly stateFile = statePath("updates", "publisher.json");
  private state: UpdatesState = { lastCommit: "", lastBatchTitle: "", lastAnnouncedAt: 0, lastCheckAt: 0, lastError: "" };
  private timer: NodeJS.Timeout | null = null;
  private firstTimer: NodeJS.Timeout | null = null;
  private inviteTimer: NodeJS.Timeout | null = null;
  private checking = false;
  private repoCache: { at: number; info: RepoInfo | null } | null = null;
  private readonly peer: PeerHost;
  private readonly log: (msg: string) => void;

  constructor(peer: PeerHost, log: (msg: string) => void) {
    this.peer = peer;
    this.log = log;
    const read = readJsonChecked<Partial<UpdatesState>>(this.stateFile, {});
    if (read.ok && read.value && typeof read.value === "object") {
      this.state = {
        lastCommit: typeof read.value.lastCommit === "string" ? read.value.lastCommit : "",
        lastBatchTitle: typeof read.value.lastBatchTitle === "string" ? read.value.lastBatchTitle : "",
        lastAnnouncedAt: Number(read.value.lastAnnouncedAt) || 0,
        lastCheckAt: Number(read.value.lastCheckAt) || 0,
        lastError: typeof read.value.lastError === "string" ? read.value.lastError : "",
      };
    }
  }

  start(): void {
    this.firstTimer = setTimeout(() => void this.tick(false), FIRST_CHECK_MS);
    this.timer = setInterval(() => void this.checkNow(), INTERVAL_MS);
    this.inviteTimer = setInterval(() => void this.reconcile(), INVITE_MS);
    // 一开机就把「我这份检出是哪个仓库」写进 config：**不是发布者也要写**，否则 announce 里没仓库标识，
    // 发布者就永远认不出这台机器、也不会拉它进组。写完才谈拉人。
    setTimeout(() => void this.boot(), 5_000);
  }

  /** 开机：先把仓库标识补进 config，再（如果本机是发布者）把已经在线的人拉进组。 */
  private async boot(): Promise<void> {
    await this.syncRepo();
    await this.reconcile();
  }

  /**
   * 把「这个检出对应哪个仓库」写进 peer 的 config，让 announce 带出去。
   * 只在跟当前值不一样时写（写会触发 announce，别每 5 秒吵一次）。
   */
  private async syncRepo(): Promise<void> {
    try {
      const st = this.peer.view().status;
      if (!st) return;
      const info = await this.repoInfo();
      if (!info || st.config.updates.repo === info.repo) return;
      await this.peer.setConfig({ updates: { repo: info.repo, publisher: st.config.updates.publisher } });
    } catch (err) {
      this.setError(`登记仓库失败：${(err as Error).message}`);
    }
  }

  stop(): void {
    for (const t of [this.firstTimer, this.timer, this.inviteTimer]) if (t) clearTimeout(t);
    this.firstTimer = this.timer = this.inviteTimer = null;
  }

  /** 这个检出对应的仓库：没有 origin / 不是 git 检出就是 null。缓存 60 秒（remote 很少变）。 */
  private async repoInfo(): Promise<RepoInfo | null> {
    if (this.repoCache && Date.now() - this.repoCache.at < 60_000) return this.repoCache.info;
    let info: RepoInfo | null = null;
    try {
      const { stdout } = await run("git", ["-C", ROOT, "remote", "get-url", "origin"], { timeout: 5_000, windowsHide: true });
      const repo = repoSlugFromRemote(stdout);
      if (repo) {
        info = { repo, groupId: groupIdFor(repo), groupName: `${repo} 更新` };
      }
    } catch {
      /* 不是 git 检出 / 没有 origin：这台机器不参与更新组 */
    }
    this.repoCache = { at: Date.now(), info };
    return info;
  }

  private hotdeploy(): boolean {
    try {
      return fs.existsSync(path.join(ROOT, "scripts", "hotdeploy.mjs"));
    } catch {
      return false;
    }
  }

  private save(): void {
    try {
      writeJson(this.stateFile, this.state);
    } catch (err) {
      this.log(`更新组状态落盘失败：${(err as Error).message}`);
    }
  }

  private setError(message: string): void {
    this.state.lastError = message;
    this.log(`更新组：${message}`);
    this.save();
  }

  /** 设置页要的那一份：发布者开关以 peer config 为准，组信息以本机名册为准。 */
  async view(): Promise<UpdatesView> {
    const info = await this.repoInfo();
    const status = this.peer.view().status;
    const group = info ? await this.group(info.groupId).catch(() => null) : null;
    const me = status?.nodeId ?? "";
    return {
      ok: true,
      available: Boolean(info),
      repo: info?.repo ?? "",
      groupId: info?.groupId ?? "",
      groupName: info?.groupName ?? "",
      publisher: status?.config.updates.publisher === true && Boolean(status?.config.updates.repo),
      joined: Boolean(group && me && group.members.some((m) => m.nodeId === me) && !group.left),
      memberCount: group?.members.length ?? 0,
      onlineCount: (status?.online ?? []).filter((p) => p.updates?.repo === info?.repo).length,
      lastCommit: this.state.lastCommit,
      lastBatchTitle: this.state.lastBatchTitle,
      lastAnnouncedAt: this.state.lastAnnouncedAt,
      lastCheckAt: this.state.lastCheckAt,
      lastError: this.state.lastError,
      hotdeploy: this.hotdeploy(),
      peerRunning: Boolean(status),
    };
  }

  private async group(id: string): Promise<PeerGroup | null> {
    const list = await this.peer.groups();
    return (list.groups ?? []).find((g) => g.id === id) ?? null;
  }

  /** 打开 / 关闭「这台机器发布更新公告」；打开后立刻看一次（不用等 30 分钟）。 */
  async setPublisher(on: boolean): Promise<UpdatesView> {
    const info = await this.repoInfo();
    if (on && !info) throw new Error("这个检出没有 git remote origin，认不出是哪份仓库");
    await this.peer.setConfig({ updates: { repo: info?.repo ?? "", publisher: on } });
    if (on) {
      setTimeout(() => void this.checkNow(), 500);
      setTimeout(() => void this.reconcile(), 500);
    }
    return this.view();
  }

  /** 「立即检查」：手动触发一次，跳过「commit 没变」的短路。 */
  async checkNow(): Promise<UpdatesView> {
    await this.tick(true);
    return this.view();
  }

  /** 同仓库、还没退组、也还没在组里的人。 */
  private wanted(group: PeerGroup | null, info: RepoInfo, me: string): string[] {
    const status = this.peer.view().status;
    if (!status) return [];
    const have = new Set((group?.members ?? []).map((m) => m.nodeId));
    return status.online
      .filter((p) => p.nodeId !== me && p.updates?.repo === info.repo && !p.updates?.optOut?.includes(info.groupId) && !have.has(p.nodeId))
      .map((p) => p.nodeId);
  }

  /** 把同仓库的在线机器拉进组，并给刚进来的人补最近 3 条公告。 */
  private async reconcile(): Promise<void> {
    const status = this.peer.view().status;
    if (!status || status.config.updates.publisher !== true) return;
    const info = await this.repoInfo();
    if (!info) return;
    try {
      let group = await this.group(info.groupId);
      if (!group) return; // 还没播报过：第一次播报时建组，不在空组里拉人
      if (group.announceOnly !== true || group.publisher !== status.nodeId) return;
      const want = this.wanted(group, info, status.nodeId);
      if (!want.length) return;
      const res = await this.peer.group({ action: "invite", id: info.groupId, members: want });
      if (res.group) group = res.group;
      for (const nodeId of want) {
        await this.peer.replayAnnouncements(info.groupId, nodeId, 3).catch(() => null);
      }
      this.log(`更新组：拉了 ${want.length} 台机器进来`);
    } catch (err) {
      this.setError(`拉人失败：${(err as Error).message}`);
    }
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await run("git", ["-C", ROOT, ...args], {
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      windowsHide: true,
    });
    return stdout.trim();
  }

  /** 新批次：`lastBatchTitle` 之前的那几条（CHANGELOG 是新的在前）。 */
  private freshBatches(): WhatsnewBatch[] {
    let text = "";
    try {
      text = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
    } catch {
      return [];
    }
    const batches = whatsnewBatches(text);
    if (!batches.length) return [];
    const last = this.state.lastBatchTitle;
    if (!last) return batches.slice(0, 1);
    const idx = batches.findIndex((b) => b.title === last);
    // 上次播的那批已经不在文件里（被合并/删了）：只推最新一条，别把整份日志重播一遍。
    if (idx < 0) return batches.slice(0, 1);
    return batches.slice(0, idx);
  }

  /** 公告正文（给旧版本 / 通知预览看的退化文本）：卡片认识 `announce` 就画卡片。 */
  private composeText(info: RepoInfo, commit: string, batches: WhatsnewBatch[], subjects: string[]): string {
    const day = new Date().toISOString().slice(0, 10);
    const lines = [`${info.repo} 更新到 ${commit}（${day}）`];
    if (batches.length) {
      lines.push("");
      for (const b of batches) lines.push(`· ${b.title}`);
    } else if (subjects.length) {
      lines.push("", "提交：");
      for (const s of subjects) lines.push(`· ${s}`);
    }
    lines.push("", "怎么更新：设置 → 工具 → 热部署（可用时）；否则 git pull && npm install && npm start");
    return lines.join("\n").slice(0, 30_000);
  }

  private async tick(force: boolean): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      await this.syncRepo();
      const status = this.peer.view().status;
      if (!status || status.config.updates.publisher !== true) return;
      const info = await this.repoInfo();
      if (!info) return;

      // fetch 失败（离线 / 代理 / 没权限）不算播报失败：下次再看，页面上只留一句原因。
      try {
        await this.git(["fetch", "--quiet", "origin", "main"]);
      } catch (err) {
        const msg = (err as Error).message.split("\n").find((l) => l.trim()) ?? "fetch 失败";
        this.state.lastCheckAt = Date.now();
        this.setError(`git fetch 失败（${msg.slice(0, 160)}）`);
        return;
      }
      const commit = await this.git(["rev-parse", "--short=7", "origin/main"]);
      this.state.lastCheckAt = Date.now();
      if (!force && commit === this.state.lastCommit) {
        this.state.lastError = "";
        this.save();
        return;
      }

      const batches = this.freshBatches();
      const subjects = batches.length
        ? []
        : (await this.git(["log", `--format=%s`, `${this.state.lastCommit || "HEAD"}..origin/main`]).catch(() => ""))
            .split("\n")
            .filter(Boolean)
            .slice(0, MAX_COMMIT_SUBJECTS);
      if (!batches.length && !subjects.length) {
        this.state.lastCommit = commit;
        this.state.lastError = "";
        this.save();
        return;
      }

      // 先保证组在、人在，再发：对方收到快照后才知道这个组是只读的。
      let group = await this.group(info.groupId);
      if (!group) {
        const created = await this.peer.group({
          action: "create",
          id: info.groupId,
          name: info.groupName,
          members: this.wanted(null, info, status.nodeId),
          announceOnly: true,
          publisher: status.nodeId,
        });
        group = created.group ?? null;
      } else if (group.announceOnly && group.publisher !== status.nodeId) {
        // 换机器（D441）：新机器接管发布权，v+1 广播出去，组里会插一条「X 成为新的发布者」。
        const claimed = await this.peer.group({ action: "publisher", id: info.groupId });
        group = claimed.group ?? group;
      }
      const want = this.wanted(group, info, status.nodeId);
      if (want.length && group) {
        await this.peer.group({ action: "invite", id: info.groupId, members: want });
        for (const nodeId of want) await this.peer.replayAnnouncements(info.groupId, nodeId, 3).catch(() => null);
      }

      const text = this.composeText(info, commit, batches, subjects);
      const announce = { repo: info.repo, commit, batches, howTo: "auto" as const };
      await this.peer.sendText(info.groupId, text, undefined, undefined, { announce });
      this.state.lastCommit = commit;
      if (batches.length) this.state.lastBatchTitle = batches[0].title;
      this.state.lastAnnouncedAt = Date.now();
      this.state.lastError = "";
      this.save();
      this.log(`更新组：播报 ${info.repo} ${commit}（${batches.length} 批）`);
    } catch (err) {
      this.setError((err as Error).message);
    } finally {
      this.checking = false;
    }
  }
}
