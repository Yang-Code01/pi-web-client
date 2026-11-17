/**
 * v2 的数据形状（对齐 QQNT 的消息记录模型，见 docs/PEER-V2.md）。
 *
 * 与 v1 的区别只有三条，但每条都决定了上层能不能长出新功能：
 * - 一条消息有 `seq`：同一会话里单调递增，已读回执、未读计数、翻页都靠它定位（QQ 的 `msgSeq`）；
 * - 一条消息有 `sendStatus`：`sending → success → read`，失败落 `failed`。
 *   v1 的「已送达」是发送方自己写的一行回执，对端根本不知道（QQ 的 `onSendStatusChange` 不是这么走的）；
 * - 正文是 `elements[]`，不再是单个 `text`：文件、@、系统提示都是元素（QQ 的 `elements` / `kElemType*`）。
 *
 * 旧行照样能读：没有 `op` 字段的 JSONL 行按 v1 的 `Entry` 折成一条 `Msg`。
 */

export interface PeerIdentity {
  nodeId: string;
  nickname?: string;
  hostname?: string;
  port?: number;
}

export type ChatType = "c2c" | "group";

/** `n:<nodeId>`（单聊）或 `g:<groupId>`（群聊）。会话的 key，也是历史文件名。 */
export type ConvId = string;

export type Elem =
  | { type: "text"; text: string }
  | { type: "file"; name: string; size: number; mime: string; sha256?: string; transferId?: string }
  | { type: "gray"; tip: string; tone?: "system" | "danger" }
  | { type: "at"; nodeId: string; nickname: string };

/** 谁写的这条：自己、收到的、其它设备同步来的、自己转发的（QQ 的 `kSendType*`）。 */
export type SendType = "self" | "recv" | "otherDevice" | "selfForward";

/** `sending` 还没收到对端答复、`success` 对端已收下、`read` 对端读了、`failed` 重试耗尽。 */
export type SendStatus = "sending" | "success" | "failed" | "read";

export interface Quote {
  id: string;
  fromNode: string;
  nickname?: string;
  abstract: string;
}

/** 群元数据：和 QQ 的群资料一样只有名字/群主/成员，没有公告板。 */
export interface GroupInfo {
  groupId: string;
  name: string;
  owner: string;
  members: PeerIdentity[];
  createdAt: number;
}

export interface Msg {
  /** v2 标记：老行没有它。 */
  v?: 2;
  id: string;
  seq: number;
  conv: ConvId;
  from: PeerIdentity;
  at: number;
  saveAt: number;
  sendType: SendType;
  sendStatus: SendStatus;
  elements: Elem[];
  quote?: Quote;
  recall?: { at: number; by: string };
  via?: "pi";
}

export function convOfNode(nodeId: string): ConvId {
  return `n:${nodeId}`;
}

export function convOfGroup(groupId: string): ConvId {
  return `g:${groupId}`;
}

export function isGroupConv(conv: ConvId): boolean {
  return conv.startsWith("g:");
}

/** 会话 → 投递目标（单聊是那个人，群聊是那个群）。 */
export function convTarget(conv: ConvId): { kind: "node" | "group"; id: string } {
  const at = conv.indexOf(":");
  const tag = conv.slice(0, at);
  const id = conv.slice(at + 1);
  return { kind: tag === "g" ? "group" : "node", id };
}

export function convOfTarget(to: { kind: "node" | "group"; id: string }): ConvId {
  return to.kind === "group" ? convOfGroup(to.id) : convOfNode(to.id);
}

function safeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * 历史文件名。单聊沿用 v1 的 `<nodeId>.jsonl`（老历史直接续上），
 * 群聊用 `g_<groupId>.jsonl`，不会和 nodeId 撞名（uuid 里没有 `g_` 前缀这种形状）。
 */
export function safeConvName(conv: ConvId): string {
  const at = conv.indexOf(":");
  const tag = conv.slice(0, at);
  const id = conv.slice(at + 1);
  return tag === "g" ? `g_${safeName(id)}` : safeName(id);
}

export function convFromFileName(name: string): ConvId | null {
  if (!name.endsWith(".jsonl")) return null;
  const stem = name.slice(0, -".jsonl".length);
  if (!stem) return null;
  return stem.startsWith("g_") ? convOfGroup(stem.slice(2)) : convOfNode(stem);
}

/** 一条消息里给人看的文字（文本元素拼起来，其它元素给占位）。 */
export function textOf(msg: Msg): string {
  const parts: string[] = [];
  for (const elem of msg.elements) {
    if (elem.type === "text") parts.push(elem.text);
    else if (elem.type === "at") parts.push(`@${elem.nickname}`);
    else if (elem.type === "file") parts.push(`[文件] ${elem.name}`);
    else if (elem.type === "gray") parts.push(elem.tip);
  }
  return parts.join(" ");
}

/** 会话列表里那一行摘要：撤回优先，其次文件卡片，最后截断的文字。 */
export function abstractOf(msg: Msg | null, max = 90): string {
  if (!msg) return "";
  if (msg.recall) return "消息已撤回";
  const file = msg.elements.find((elem) => elem.type === "file");
  const text = textOf(msg).trim();
  if (file && file.type === "file" && !text.startsWith("[文件]")) return `[文件] ${file.name}`;
  const one = text.replace(/\s+/g, " ");
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

export function isMine(msg: Msg, me: string): boolean {
  return msg.from.nodeId === me && (msg.sendType === "self" || msg.sendType === "selfForward");
}

/** 撤回窗口：QQ 是 2 分钟，这里照抄（超时拒绝，对端也按同一条规则复核）。 */
export const RECALL_MS = 2 * 60 * 1000;

/** 输入中提示的有效期：超过就当作没在打字（对方可能直接关页面了）。 */
export const TYPING_MS = 5000;
