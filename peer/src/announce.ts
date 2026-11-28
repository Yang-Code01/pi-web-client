/**
 * 更新公告（D441）：更新组里由发布者推的一条消息，形状固定、字段可校验。
 *
 * 它仍然是一条 `kind:"text"`：`Entry.text` 是给旧版本看的退化正文，这个 payload 只让
 * 认识它的页面把气泡画成卡片。所以新增字段不需要动协议版本，也不影响通知 / 未读 / 搜索。
 */
export interface AnnounceBatch {
  /** CHANGELOG 里的 `## ` 标题（原样，含日期 / PR 号）。 */
  title: string;
  /** 这一批的正文（`### 新增` / `### 修复` / `- 条目`），页面按 Markdown 画。 */
  body: string;
}

export interface AnnouncePayload {
  /** `owner/name`：同一份仓库才进同一个更新组。 */
  repo: string;
  /** 播报时 `origin/main` 的短提交。 */
  commit: string;
  /** 新 → 旧。 */
  batches: AnnounceBatch[];
  /** 更新方式的文案由接收端按自己这台机器能不能热部署决定（D441）。 */
  howTo: "auto";
}

export const MAX_ANNOUNCE_BATCHES = 6;
export const MAX_ANNOUNCE_BATCH_BYTES = 4096;
export const MAX_ANNOUNCE_BYTES = 16 * 1024;

/** 仓库标识：至少 owner/name，允许 GitLab 那种 group/subgroup/name（评审 #2）。 */
export const REPO_RE = /^[\w.-]+(?:\/[\w.-]+)+$/;

export function isRepo(raw: unknown): boolean {
  return typeof raw === "string" && raw.length <= 160 && REPO_RE.test(raw);
}

/** 按 UTF-8 字节截断（中文一个字 3 字节，不能按字符数算）。 */
export function truncBytes(s: string, max: number): string {
  if (Buffer.byteLength(s, "utf8") <= max) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, "utf8");
    if (used + n > max) break;
    out += ch;
    used += n;
  }
  return out;
}

/**
 * 对端 / 桥送来的 announce：只收形状对的，超限的批次截断（不整条丢 —— 丢掉就变成
 * 一条「有文本没卡片」的消息，用户看不出哪里不对）。
 */
export function normalizeAnnounce(raw: unknown): AnnouncePayload | null {
  const r = raw as Partial<AnnouncePayload> | null | undefined;
  const repo = typeof r?.repo === "string" ? r.repo.trim() : "";
  if (!repo || !isRepo(repo)) return null;
  const commit = typeof r?.commit === "string" ? r.commit.trim() : "";
  if (!/^[0-9a-f]{4,40}$/i.test(commit)) return null;
  const batches: AnnounceBatch[] = [];
  for (const b of Array.isArray(r?.batches) ? r.batches : []) {
    if (batches.length >= MAX_ANNOUNCE_BATCHES) break;
    const title = typeof b?.title === "string" ? truncBytes(b.title.trim(), 160).trim() : "";
    const body = typeof b?.body === "string" ? truncBytes(b.body, MAX_ANNOUNCE_BATCH_BYTES) : "";
    if (!title) continue;
    batches.push({ title, body });
  }
  if (!batches.length) return null;
  const bytes = (list: AnnounceBatch[]): number =>
    Buffer.byteLength(JSON.stringify({ repo, commit, batches: list, howTo: "auto" }), "utf8");
  // 6 批 × 4 KB 的 body 一定超过 16 KB：丢最旧的批次（新 → 旧，保住最新那批），
  // 只剩一批还超就截断它的正文 —— 卡片少几条也比整条变成纯文本好（评审 #1）。
  while (batches.length > 1 && bytes(batches) > MAX_ANNOUNCE_BYTES) batches.pop();
  if (bytes(batches) > MAX_ANNOUNCE_BYTES) {
    const only = batches[0];
    if (only) {
      // 一次算准剩余额度，不再按 512 字节一轮 JSON.stringify（评审 #16）。
      const room = MAX_ANNOUNCE_BYTES - bytes([{ ...only, body: "" }]);
      only.body = truncBytes(only.body, Math.max(0, room));
    }
  }
  return { repo, commit, batches, howTo: "auto" };
}
