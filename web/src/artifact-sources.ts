/**
 * D275：产物有两个来源 —— write 系工具的「写过」，和 `open_preview` 的「交付过」。
 *
 * 脚本 / 程序生成的文件（`python x.py` 产出的 xlsx、构建出来的 html…）不经过 write 钩子，
 * 「在预览里打开」是它们唯一的线索；网页会话的交付提示词（D190 / D226）本来就让模型走这条路。
 * 所以光收 write 系工具会让「已生成并在预览中打开」的产物在弹窗里查无此人（#451）。
 *
 * 两条纪律：
 * - **写入优先**：同一路径既写过又打开过时留写入那条 —— 只有它才有「写入前的原文」；
 * - 交付记录不进这一轮的产物芯片：芯片是「这轮写了什么」，打开一个旧文件不算。
 */

export const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "multi_edit", "create", "str_replace_editor", "apply_patch"]);
export const DELIVER_TOOLS = new Set(["open_preview"]);

export interface ArtifactSource {
  path: string;
  tool: string;
  /** 同一个路径被这个来源记了几次。 */
  writes: number;
  /** 交付工具记下的那一条为 true：桥据此换掉「没有写入前原文」的说法。 */
  delivered: boolean;
  /** 回复正文提及的路径（非工具调用）：桥据此校验文件存在且 mtime 晚于会话开始后才收录。 */
  mentioned?: boolean;
}

/** Tool arguments carry the path under one of these keys, depending on the tool. */
export function toolPath(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "file", "filename"]) {
    const v = a[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/**
 * 记一条产物。返回 null 表示这个工具 / 参数跟产物无关；`isWrite` 告诉调用方要不要画芯片。
 * 同一个路径再出现一次算一次（`writes` +1），并挪到 Map 末尾（`artifactSources` 反着取 = 最近的在最前）。
 */
export function noteArtifact(
  into: Map<string, ArtifactSource>,
  name: unknown,
  args: unknown,
): { path: string; isWrite: boolean } | null {
  const tool = String(name ?? "").toLowerCase();
  const isWrite = WRITE_TOOLS.has(tool);
  if (!isWrite && !DELIVER_TOOLS.has(tool)) return null;
  const path = toolPath(args);
  if (!path) return null;
  const prev = into.get(path);
  // 交付不是写入：已经记过写入就不再动它（工具名与次数都属于写入那条）。
  if (prev && !isWrite) return { path, isWrite };
  into.delete(path);
  // 先打开、后写入时次数从 1 起算 —— 这一列答的是「写过几次」，不是「出现过几次」。
  const writes = isWrite ? (prev && !prev.delivered && !prev.mentioned ? prev.writes : 0) + 1 : 1;
  into.set(path, { path, tool, writes, delivered: !isWrite });
  return { path, isWrite };
}

/**
 * 记一条 AI 回复正文里提到的文件路径（脚本/程序生成但未调 open_preview 时的兜底线索）。
 * 已有写入或交付记录的路径不动（优先级：写入 > 交付 > 提及）；重复提及只挪到末尾（最近的在最前）。
 */
export function noteMentioned(into: Map<string, ArtifactSource>, paths: Iterable<string>): void {
  for (const raw of paths) {
    const path = String(raw ?? "").trim();
    if (!path) continue;
    const prev = into.get(path);
    if (prev && !prev.mentioned) continue;
    into.delete(path);
    into.set(path, { path, tool: "mentioned", writes: 1, delivered: true, mentioned: true });
  }
}

/** 产物列表要的形状：最近写 / 打开 / 提及的在前。 */
export function artifactSources(
  map: Map<string, ArtifactSource>,
): { path: string; tool: string; writes: number; delivered?: boolean; mentioned?: boolean }[] {
  return [...map.values()].reverse().map((v) => ({
    path: v.path,
    tool: v.tool,
    writes: v.writes,
    ...(v.delivered ? { delivered: true } : {}),
    ...(v.mentioned ? { mentioned: true } : {}),
  }));
}
