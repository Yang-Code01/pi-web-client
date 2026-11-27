/**
 * 内网通「共享卡」的桥端逻辑（D439）。
 *
 * 协议侧只送一帧清单 + 8KB 预览（`peer/src/share.ts`），本体（文件 / skill zip / 会话 md）
 * 逐份走文件通道——和记录包送截图是同一套路。于是这里要干三件事：
 *
 * 1. 把「要共享什么」翻译成清单：算 sha256、量大小、截预览，绝不把本体塞进消息帧。
 * 2. 发送：先 `/share` 落卡片，再逐份 `sendFile`。
 * 3. 接收：按卡片里的 sha256 在历史里找回对应的 file 条目，再按四类各自的落点安放
 *    （文件另存 / 内容进记录 / skill 解压到技能目录 / 会话写成 md），最后回一帧回执。
 *
 * 预览为什么不再「按需向发送方要全文」：卡片只带 8KB，全文在发送方也没有可寻址的存放点。
 * 内容类超过 8KB 就是截断（卡片上标出来）；要完整内容就共享成文件。会话的全文随导出的
 * md 走文件通道，所以点开就是全文。
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync, unzipSync } from "fflate";
import { importNote } from "./notes.ts";
import { ensureDir, readJsonChecked, statePath, writeJson } from "./paths.ts";
import { displayUserText, loadEntries, readMeta } from "./sessionfile.ts";

export const SHARE_TYPES = ["file", "snippet", "skill", "session"] as const;
export type ShareType = (typeof SHARE_TYPES)[number];
export type ShareRole = "file" | "skill" | "session";

export interface ShareFile {
  name: string;
  size: number;
  sha256: string;
  role: ShareRole;
}

export interface SharePayload {
  type: ShareType;
  title: string;
  summary?: string;
  body?: string;
  bodyBytes?: number;
  files: ShareFile[];
  sourceAt?: number;
}

/** 与 peer 侧 `MAX_SHARE_BODY` 对齐：卡片里的正文只有这么多，本体走文件通道。 */
export const SHARE_PREVIEW_BYTES = 8 * 1024;
const MAX_TITLE = 200;
const MAX_SUMMARY = 600;
const MAX_FILES = 50;
/** 一次调用最多共享几份文件（再多请分次，卡片仍然能装下）。 */
const MAX_INPUT_FILES = 10;
/** peer 文件通道的上限（`peer/src/http.ts` 的 64MB），这里提前拦，免得传到一半才 413。 */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SKILL_FILES = 2000;
const SKILL_NAME = /^[A-Za-z0-9._-]{1,80}$/;

export interface ShareRequest {
  type?: string;
  /** 1:1 用 nodeId，群用群 id。 */
  peer?: string;
  title?: string;
  summary?: string;
  /** snippet 的正文 / 其它类型的附言。 */
  text?: string;
  /** file：本机绝对路径（相对路径按 cwd 解析）。 */
  paths?: unknown;
  /** skill：技能目录名。 */
  skillName?: string;
  scope?: "global" | "project";
  /** session：会话 jsonl 的绝对路径。 */
  sessionFile?: string;
  cwd?: string;
  via?: string;
}

export interface PreparedShare {
  share: SharePayload;
  /** 卡片落盘后逐份发出去的文件（skill zip / 会话 md 是临时产物）。 */
  attachments: Array<{ path: string; name: string }>;
}

function clipBytes(text: string, max: number): { body: string; bytes: number; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return { body: text, bytes: buf.length, truncated: false };
  let end = max;
  // 退到字符边界：不把多字节字符切成两半，否则对方看到的是「�」。
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return { body: buf.subarray(0, end).toString("utf8"), bytes: buf.length, truncated: true };
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function clipTitle(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1)}…` : t;
}

function oneLine(s: string, max = 160): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return oneLine(line.replace(/^#+\s*/, ""), 60);
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function mustFile(p: string): { path: string; name: string; size: number } {
  const abs = path.resolve(p);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`找不到文件：${abs}`);
  }
  if (!st.isFile()) throw new Error(`不是文件：${abs}`);
  if (st.size > MAX_FILE_BYTES) throw new Error(`${path.basename(abs)} 有 ${humanSize(st.size)}，超过 ${humanSize(MAX_FILE_BYTES)} 的上限`);
  return { path: abs, name: path.basename(abs), size: st.size };
}

/** 技能目录：全局 `~/.pi/agent/skills/<name>`，项目 `<cwd>/.pi/skills/<name>`。 */
export function skillDir(name: string, scope: "global" | "project", cwd: string): string {
  if (!SKILL_NAME.test(name)) throw new Error(`技能名不合法：${name}`);
  return scope === "project" ? path.join(cwd, ".pi", "skills", name) : path.join(os.homedir(), ".pi", "agent", "skills", name);
}

function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, base, out);
    else if (entry.isFile()) out.push(path.relative(base, abs).split(path.sep).join("/"));
    if (out.length > MAX_SKILL_FILES) throw new Error(`技能里的文件太多（超过 ${MAX_SKILL_FILES} 个）`);
  }
  return out;
}

function frontmatterDescription(md: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const hit = fm ? /\bdescription:\s*(.+)/.exec(fm[1]) : null;
  return hit ? oneLine(hit[1].replace(/^["']|["']$/g, ""), 200) : "";
}

/**
 * 会话 → Markdown：用户提问、助手结论、工具调用各占一行摘要（工具输出不进来，避免把整段
 * 终端输出塞给对方）。`maxBytes` 只裁助手正文，头部最多丢最早的几条。
 */
export function sessionMarkdown(file: string, maxBytes = 512 * 1024): { text: string; title: string; truncated: boolean } {
  const abs = path.resolve(file);
  if (!abs.endsWith(".jsonl")) throw new Error("会话文件应当是 .jsonl");
  if (!fs.existsSync(abs)) throw new Error(`找不到会话文件：${abs}`);
  const meta = readMeta(abs);
  const loaded = loadEntries(abs, 8 * 1024 * 1024);
  const title = clipTitle(meta?.name || path.basename(abs, ".jsonl"));
  const lines: string[] = [`# ${title}`, ""];
  const when = new Date().toLocaleString("zh-CN", { hour12: false });
  lines.push(`> pi 会话导出 · ${when}${meta?.cwd ? ` · 工作目录 \`${meta.cwd}\`` : ""}`);
  lines.push("");
  let used = 0;
  let cut = loaded.truncated;
  for (const entry of loaded.entries) {
    if (entry.type !== "message") continue;
    const role = String(entry.message?.role ?? "");
    const parts: any[] = Array.isArray(entry.message?.content) ? entry.message.content : [];
    const text = parts.filter((c) => c?.type === "text").map((c) => String(c.text ?? "")).join("\n");
    const tools = parts.filter((c) => c?.type === "toolCall").map((c) => String(c.name ?? ""));
    const images = parts.filter((c) => c?.type === "image").length;
    if (role === "user") {
      const said = displayUserText(text).trim();
      if (!said) continue;
      lines.push("## 用户", "", said, "");
    } else if (role === "assistant") {
      const body = text.trim();
      if (body) {
        if (used + body.length > maxBytes) {
          cut = true;
          break;
        }
        used += body.length;
        lines.push("## 助手", "", body, "");
      }
      if (tools.length) lines.push(`*调用工具：${tools.join("、")}*`, "");
      if (images) lines.push(`*（含 ${images} 张图片，未导出）*`, "");
    } else if (role === "toolResult" || role === "tool") {
      // 工具输出不导出：一整段构建日志对「看这次聊了什么」没有帮助。
      continue;
    } else if (text.trim()) {
      lines.push(`## ${role || "其它"}`, "", text.trim(), "");
    }
  }
  if (cut) lines.push("", "> 会话较长，导出时从尾部保留，前面的部分已省略。");
  return { text: lines.join("\n"), title, truncated: cut };
}

function outDir(): string {
  const dir = statePath("peer", "out");
  ensureDir(dir);
  // 临时产物（skill zip / 会话 md）只服务一次发送；留 24 小时便于重发，再老的清掉。
  try {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (fs.statSync(abs).mtimeMs < cutoff) fs.rmSync(abs, { force: true });
    }
  } catch {
    // 清理失败不影响这一次发送。
  }
  return dir;
}

/** 把「共享什么」翻译成卡片清单（不发送）。 */
export function prepareShare(req: ShareRequest): PreparedShare {
  const type = String(req.type ?? "") as ShareType;
  if (!SHARE_TYPES.includes(type)) throw new Error(`未知的共享类型：${req.type ?? "(空)"}（file / snippet / skill / session）`);
  const cwd = path.resolve(String(req.cwd ?? process.cwd()));
  const extra = typeof req.text === "string" ? req.text : "";
  const sourceAt = Date.now();

  if (type === "snippet") {
    if (!extra.trim()) throw new Error("共享内容不能为空");
    const clipped = clipBytes(extra, SHARE_PREVIEW_BYTES);
    return {
      share: {
        type,
        title: clipTitle(String(req.title ?? "") || firstLine(extra)),
        summary: String(req.summary ?? "").slice(0, MAX_SUMMARY) || oneLine(`${clipped.bytes} 字符${clipped.truncated ? "（已截断）" : ""}`, 200),
        body: clipped.body,
        bodyBytes: clipped.bytes,
        files: [],
        sourceAt,
      },
      attachments: [],
    };
  }

  if (type === "file") {
    const raw = Array.isArray(req.paths) ? req.paths : typeof req.paths === "string" ? [req.paths] : [];
    if (!raw.length) throw new Error("共享文件需要 paths");
    if (raw.length > MAX_INPUT_FILES) throw new Error(`一次最多 ${MAX_INPUT_FILES} 份文件`);
    const picked = raw.map((p) => mustFile(path.resolve(cwd, String(p))));
    const files: ShareFile[] = picked.map((f) => ({ name: f.name, size: f.size, sha256: sha256(fs.readFileSync(f.path)), role: "file" }));
    const total = picked.reduce((n, f) => n + f.size, 0);
    const note = clipBytes(extra, SHARE_PREVIEW_BYTES);
    return {
      share: {
        type,
        title: clipTitle(String(req.title ?? "") || (picked.length === 1 ? picked[0].name : `${picked.length} 个文件`)),
        summary: String(req.summary ?? "").slice(0, MAX_SUMMARY) || `${picked.length} 个文件 · ${humanSize(total)}`,
        ...(note.body ? { body: note.body, bodyBytes: note.bytes } : {}),
        files,
        sourceAt,
      },
      attachments: picked.map((f) => ({ path: f.path, name: f.name })),
    };
  }

  if (type === "skill") {
    const name = String(req.skillName ?? "").trim();
    const scope = req.scope === "project" ? "project" : "global";
    const dir = skillDir(name, scope, cwd);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`没有这个技能目录：${dir}`);
    const relative = walk(dir);
    if (!relative.includes("SKILL.md")) throw new Error(`${dir} 里没有 SKILL.md，不像一个技能`);
    if (relative.length > MAX_FILES) throw new Error(`技能有 ${relative.length} 个文件，超过卡片上限 ${MAX_FILES}`);
    const entries: Record<string, Uint8Array> = {};
    let total = 0;
    for (const rel of relative) {
      const buf = fs.readFileSync(path.join(dir, rel));
      total += buf.length;
      if (total > MAX_FILE_BYTES) throw new Error(`技能打包后超过 ${humanSize(MAX_FILE_BYTES)}`);
      entries[rel] = new Uint8Array(buf);
    }
    const zip = Buffer.from(zipSync(entries, { level: 6 }));
    const zipName = `${name}.zip`;
    const tmp = path.join(outDir(), `${randomUUID()}.zip`);
    fs.writeFileSync(tmp, zip);
    const skillMd = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
    const preview = clipBytes(skillMd, SHARE_PREVIEW_BYTES);
    const desc = frontmatterDescription(skillMd);
    return {
      share: {
        type,
        title: clipTitle(String(req.title ?? "") || name),
        summary: String(req.summary ?? "").slice(0, MAX_SUMMARY) || oneLine(desc || `${relative.length} 个文件 · ${humanSize(zip.length)}`, 200),
        body: preview.body,
        bodyBytes: preview.bytes,
        // 清单里只放真正会传的那一份：技能包内的每个文件都列出来会让卡片永远显示「还差 N 份」。
        files: [{ name: zipName, size: zip.length, sha256: sha256(zip), role: "skill" as const }],
        sourceAt,
      },
      attachments: [{ path: tmp, name: zipName }],
    };
  }

  // session
  const file = String(req.sessionFile ?? "").trim();
  if (!file) throw new Error("共享会话需要 sessionFile");
  const rendered = sessionMarkdown(path.resolve(cwd, file));
  const md = Buffer.from(rendered.text, "utf8");
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = rendered.title.replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 60) || "session";
  const mdName = `${safe}-${stamp}.md`;
  const tmp = path.join(outDir(), `${randomUUID()}.md`);
  fs.writeFileSync(tmp, md);
  const preview = clipBytes(rendered.text, SHARE_PREVIEW_BYTES);
  return {
    share: {
      type,
      title: clipTitle(String(req.title ?? "") || rendered.title),
      summary: String(req.summary ?? "").slice(0, MAX_SUMMARY) || `${humanSize(md.length)} · Markdown${rendered.truncated ? "（原会话很长，已折叠前段）" : ""}`,
      body: preview.body,
      bodyBytes: md.length,
      files: [{ name: mdName, size: md.length, sha256: sha256(md), role: "session" }],
      sourceAt,
    },
    attachments: [{ path: tmp, name: mdName }],
  };
}

/** 桥这侧要的 PeerHost 能力（只写用到的那几个，免得 peer-share 反向依赖 peer.ts）。 */
export interface ShareHost {
  history(peer: string, limit?: number): Promise<{ entries: unknown[] }>;
  fileStream(id: string): Promise<Response>;
  filePath(id: string): Promise<string | null>;
  sendShare(peer: string, share: SharePayload, via?: "pi"): Promise<{ ok: boolean; id: string; at: number; seq: number }>;
  shareAck(peer: string, ref: string, thread: string): Promise<{ ok: boolean }>;
  sendFile(peer: string, file: string, name?: string): Promise<{ ok: boolean; id: string }>;
}

/** 发送：卡片先落（对方立刻看到摘要），本体再逐份走文件通道。 */
export async function sendShare(host: ShareHost, req: ShareRequest): Promise<{ ok: boolean; id: string; files: string[] }> {
  const peer = String(req.peer ?? "").trim();
  if (!peer) throw new Error("缺 peer（好友 nodeId 或群 id）");
  const prepared = prepareShare(req);
  const via = req.via === "pi" ? ("pi" as const) : undefined;
  const card = await host.sendShare(peer, prepared.share, via);
  const files: string[] = [];
  for (const attachment of prepared.attachments) {
    try {
      const sent = await host.sendFile(peer, attachment.path, attachment.name);
      // 桥的 request() 只在 HTTP 状态不是 2xx 时抛；返回体里 ok:false / 缺 id 也是没传成。
      if (!sent?.ok || !sent.id) throw new Error("对方没有收下（返回里没有 id）");
      files.push(sent.id);
    } catch (err) {
      // 卡片已经发出去了：本体没跟上时说清楚是哪一份，别让用户以为整个共享失败了。
      throw new Error(`卡片已发出，但「${attachment.name}」没传过去：${(err as Error).message}（对方可以点重试，或你再发一次）`);
    }
  }
  return { ok: true, id: card.id, files };
}

interface EntryLike {
  id: string;
  at: number;
  kind?: string;
  from?: { nodeId?: string; nickname?: string; hostname?: string };
  share?: SharePayload & { accepted?: unknown; files?: Array<ShareFile & { entryId?: string | null }> };
  file?: { sha256?: string; name?: string };
}

export interface AcceptedShare {
  at: number;
  type: ShareType;
  paths: string[];
  noteId?: string;
  /** 落地目录（文件 / 会话）；用来判断「这次点的是不是同一个地方」。 */
  target?: string;
}

export function shareAcceptedFile(): string {
  return statePath("peer", "shares-accepted.json");
}

export function readShareAccepted(): Record<string, AcceptedShare> {
  const res = readJsonChecked<Record<string, AcceptedShare>>(shareAcceptedFile(), {});
  if (!res.ok || !res.value || typeof res.value !== "object") return {};
  return res.value;
}

function markShareAccepted(key: string, value: AcceptedShare): void {
  const all = readShareAccepted();
  all[key] = value;
  writeJson(shareAcceptedFile(), all);
}

/**
 * 卡片里的 sha256 → 历史里哪条 file。和记录包的截图对齐同一套规则：同一个人发的、在卡片
 * 之后到达的、sha 对得上的；先到的卡片先认领，两张卡不抢同一份文件。
 */
export function resolveShareFiles(entries: unknown[], cardId: string): Array<string | null> {
  const list = (Array.isArray(entries) ? entries : []) as EntryLike[];
  const used = new Set<string>();
  for (const entry of list) {
    if (entry.kind !== "share" || !entry.share) continue;
    const wanted = entry.share.files ?? [];
    const slots = wanted.map((want) => {
      const hit = list.find(
        (file, index) =>
          file.kind === "file" &&
          index > list.indexOf(entry) &&
          file.from?.nodeId === entry.from?.nodeId &&
          file.file?.sha256 === want.sha256 &&
          !used.has(file.id),
      );
      if (hit) used.add(hit.id);
      return hit?.id ?? null;
    });
    if (entry.id === cardId) return slots;
  }
  return [];
}

/** 给页面用的卡片：补上「文件在历史里的哪条」与「我接受过没有」（存盘 JSONL 不动）。 */
export function decorateShares(entries: unknown[]): unknown[] {
  const list = (Array.isArray(entries) ? entries : []) as EntryLike[];
  const accepted = readShareAccepted();
  for (const entry of list) {
    if (entry.kind !== "share" || !entry.share) continue;
    const slots = resolveShareFiles(list, entry.id);
    const files = Array.isArray(entry.share.files) ? entry.share.files : [];
    entry.share.files = files.map((file, i) => ({ ...file, entryId: slots[i] ?? null }));
    entry.share.accepted = accepted[`${entry.from?.nodeId ?? ""}:${entry.id}`] ?? null;
  }
  return list;
}

export interface AcceptRequest {
  peer?: string;
  id?: string;
  thread?: string;
  /** 文件另存为的目录 / 会话导出目录。 */
  target?: string;
  /** skill 落到哪儿。 */
  scope?: "global" | "project";
  cwd?: string;
}

/**
 * 接收一张卡片。四类各有各的落点，共同点是「字节从历史里的 file 条目取」：
 * - file：已在本机收件箱，给了 target 就再复制一份过去（不动收件箱）。
 * - snippet：导入本机记录（kind = shared），带来源。
 * - skill：把 zip 解到技能目录，校验路径不越界、不覆盖已有同名技能。
 * - session：md 写进 target / cwd。
 */
export async function acceptShare(
  host: ShareHost,
  req: AcceptRequest,
): Promise<{ ok: boolean; type: ShareType; paths: string[]; noteId?: string; already?: boolean }> {
  const peer = String(req.peer ?? "").trim();
  const id = String(req.id ?? "").trim();
  if (!peer || !id) throw new Error("缺 peer 或 id");
  const thread = String(req.thread ?? "").trim() || peer;
  const data = (await host.history(thread, 500)) as { entries?: unknown[] };
  const entries = (data.entries ?? []) as EntryLike[];
  const card = entries.find((e) => e.id === id && e.kind === "share");
  if (!card?.share) throw new Error("这张共享卡不在了（可能被撤回或历史被清理）");
  const share = card.share;
  const cwd = path.resolve(String(req.cwd ?? process.cwd()));
  const slots = resolveShareFiles(entries, id);
  const wanted = share.files ?? [];
  const missing = slots.filter((slot) => !slot).length;
  const origin = {
    peerEntryId: id,
    nodeId: String(card.from?.nodeId ?? peer),
    nickname: String(card.from?.nickname ?? ""),
    hostname: String(card.from?.hostname ?? ""),
    at: Number(card.at) || Date.now(),
  };

  const key = `${origin.nodeId}:${id}`;
  const done = readShareAccepted()[key];
  /**
   * 这张卡「落在哪」——幂等键的一部分。文件只有另存为才有落点（不另存就一直在收件箱里），
   * 会话落在 target 或 cwd，技能落在技能目录。换了地方就算新的一次。
   */
  const landing = (): string => {
    if (share.type === "file") return req.target ? path.resolve(cwd, String(req.target)) : "";
    if (share.type === "session") return path.resolve(cwd, String(req.target ?? ""));
    if (share.type === "skill") return path.join(skillDir(path.basename(wanted.find((f) => f.name.toLowerCase().endsWith(".zip"))?.name ?? "", ".zip"), req.scope === "project" ? "project" : "global", cwd), "");
    return "";
  };
  const spot = landing();
  // 同一张卡、同一个落点，第二次点不该再做一遍（重试 / 连点会重复导入记录、重复落盘）。
  if (done && done.type === share.type && (done.target ?? "") === spot) {
    return { ok: true, type: done.type, paths: done.paths, ...(done.noteId ? { noteId: done.noteId } : {}), already: true };
  }

  if (share.type === "snippet") {
    const note = importNote({ title: share.title, body: share.body ?? "", kind: "shared", origin });
    markShareAccepted(key, { at: Date.now(), type: "snippet", paths: [], noteId: note.id });
    return { ok: true, type: "snippet", paths: [], noteId: note.id };
  }

  if (missing) throw new Error(`还缺 ${missing} 份文件，等对方补发后再接收`);

  const fetchFile = async (index: number): Promise<{ name: string; data: Buffer }> => {
    const want = wanted[index];
    const slot = slots[index] as string;
    const upstream = await host.fileStream(slot);
    if (!upstream.ok || !upstream.body) throw new Error(`「${want.name}」取不到`);
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length !== Number(want.size)) throw new Error(`「${want.name}」大小对不上（清单 ${want.size}，实收 ${buf.length}）`);
    if (sha256(buf) !== String(want.sha256).toLowerCase()) throw new Error(`「${want.name}」校验失败`);
    return { name: want.name, data: buf };
  };

  const paths: string[] = [];

  if (share.type === "file") {
    const target = req.target ? path.resolve(cwd, String(req.target)) : "";
    if (target) ensureDir(target);
    for (let i = 0; i < wanted.length; i += 1) {
      const slot = slots[i] as string;
      if (target) {
        const got = await fetchFile(i);
        const dest = path.join(target, path.basename(got.name));
        fs.writeFileSync(dest, got.data);
        paths.push(dest);
      } else {
        // 没指定目录：文件已经躺在收件箱里，把它的位置报回去就好。
        const local = await host.filePath(slot);
        if (local) paths.push(local);
      }
    }
  } else if (share.type === "session") {
    const dir = req.target ? path.resolve(cwd, String(req.target)) : cwd;
    ensureDir(dir);
    for (let i = 0; i < wanted.length; i += 1) {
      const got = await fetchFile(i);
      const dest = path.join(dir, path.basename(got.name));
      fs.writeFileSync(dest, got.data);
      paths.push(dest);
    }
  } else {
    // skill：卡片里第一份「SKILL.md 之外的清单」只是给人看的；真正要解的是那份 .zip。
    const zipIndex = wanted.findIndex((f) => f.name.toLowerCase().endsWith(".zip"));
    if (zipIndex < 0) throw new Error("这张技能卡没有 zip，没法安装");
    const name = path.basename(wanted[zipIndex].name, ".zip");
    const scope = req.scope === "project" ? "project" : "global";
    const dir = skillDir(name, scope, cwd);
    if (fs.existsSync(dir)) throw new Error(`已经装了同名技能：${dir}（先删掉或换个名字）`);
    const got = await fetchFile(zipIndex);
    const parent = path.dirname(dir);
    ensureDir(parent);
    const tmp = path.join(parent, `.${path.basename(dir)}.tmp-${Date.now().toString(36)}`);
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const files = unzipSync(new Uint8Array(got.data));
      for (const [rel, buf] of Object.entries(files)) {
        const dest = path.join(tmp, rel);
        const rel2 = path.relative(tmp, dest);
        if (rel2.startsWith("..") || path.isAbsolute(rel2)) throw new Error(`技能包里有越界路径：${rel}`);
        ensureDir(path.dirname(dest));
        fs.writeFileSync(dest, Buffer.from(buf));
      }
      if (!fs.existsSync(path.join(tmp, "SKILL.md"))) throw new Error("技能包里没有 SKILL.md");
      fs.renameSync(tmp, dir);
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
    paths.push(dir);
  }

  // 记下落点，第二次点同一张卡时好判断「是不是同一个地方」：
  // 文件只有另存为才有落点（不收就一直在收件箱里），会话与技能总有。
  markShareAccepted(key, { at: Date.now(), type: share.type, paths, ...(spot ? { target: spot } : {}) });
  return { ok: true, type: share.type, paths };
}

/** 接受完回一帧回执（按 itemId 幂等；失败不影响本地已经落地的东西）。 */
export async function ackShare(host: ShareHost, peer: string, id: string, thread?: string): Promise<{ ok: boolean; warning?: string }> {
  try {
    await host.shareAck(peer, id, thread && thread !== peer ? thread : thread || peer);
    return { ok: true };
  } catch (err) {
    return { ok: false, warning: `已接收，但回执没发出去：${(err as Error).message}` };
  }
}

