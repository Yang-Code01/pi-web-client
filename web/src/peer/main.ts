/** `peer.html` 的脚本：只跟 bridge 说话（cookie + `/api/peer*`），从不直接连 7865。 */

interface OnlinePeer {
  nodeId: string;
  nickname: string;
  hostname: string;
  addr: string;
  port: number;
  lastSeen: number;
}

interface PeerStatus {
  nodeId: string;
  nickname: string;
  hostname: string;
  port: number;
  online: OnlinePeer[];
  config: { hidden: boolean; pauseFiles: boolean; dnd: boolean; inbox: string; manual: string[] };
}

interface PeerView {
  enabled: boolean;
  running: boolean;
  reason: string;
  status: PeerStatus | null;
}

interface Entry {
  id: string;
  at: number;
  from: { nodeId: string; nickname?: string; hostname?: string; port?: number };
  to: { kind: "node" | "group"; id: string };
  kind: "text" | "receipt";
  text?: string;
  ack?: { id: string; status: "delivered" | "failed"; error?: string };
}

interface Thread {
  nodeId: string;
  nickname: string;
  hostname: string;
  port: number;
  last: Entry | null;
  count: number;
  online: boolean;
}

const MAX_TEXT_BYTES = 32 * 1024;

const dot = document.querySelector("#dot") as HTMLElement;
const me = document.querySelector("#me") as HTMLElement;
const list = document.querySelector("#peers") as HTMLUListElement;
const empty = document.querySelector("#online-empty") as HTMLElement;
const form = document.querySelector("#add") as HTMLFormElement;
const addrInput = document.querySelector("#addr") as HTMLInputElement;
const refresh = document.querySelector("#refresh") as HTMLButtonElement;
const addError = document.querySelector("#add-error") as HTMLElement;
const threadList = document.querySelector("#threads") as HTMLUListElement;
const threadsEmpty = document.querySelector("#threads-empty") as HTMLElement;
const threadEmpty = document.querySelector("#thread-empty") as HTMLElement;
const threadBox = document.querySelector("#thread-box") as HTMLElement;
const threadHead = document.querySelector("#thread-head") as HTMLElement;
const messagesEl = document.querySelector("#messages") as HTMLUListElement;
const compose = document.querySelector("#compose") as HTMLFormElement;
const textInput = document.querySelector("#text") as HTMLTextAreaElement;
const sendError = document.querySelector("#send-error") as HTMLElement;

let meStatus: PeerStatus | null = null;
let threads: Thread[] = [];
let active: string | null = null;
let sending = false;

const byteLen = (text: string): number => new TextEncoder().encode(text).length;

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "刚刚";
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  return new Date(ts).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function switchTo(view: string): void {
  for (const other of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    other.classList.toggle("is-on", other.dataset.view === view);
  }
  for (const section of document.querySelectorAll<HTMLElement>(".view")) {
    section.hidden = section.id !== `view-${view}`;
  }
}

// ---------------------------------------------------------------- 在线 / 顶栏

function renderStatus(view: PeerView | null, note = ""): void {
  if (!view) {
    dot.className = "dot";
    me.textContent = note || "拿不到状态";
    return;
  }
  const up = view.enabled && view.running;
  dot.className = `dot ${up ? "is-up" : "is-down"}`;
  dot.title = up ? "peer 在跑" : view.reason || "peer 没在跑";
  meStatus = view.status;
  if (!view.status) {
    me.textContent = view.enabled ? view.reason || "peer 正在启动" : "peer 未启用（PI_PEER=0 或还没构建）";
    renderOnline();
    return;
  }
  const cfg = view.status.config;
  const flags = [cfg.hidden ? "隐身" : "", cfg.pauseFiles ? "暂停收文件" : "", cfg.dnd ? "免打扰" : ""].filter(Boolean).join(" · ");
  me.textContent = `${view.status.nickname} · ${view.status.nodeId.slice(0, 8)} · :${view.status.port}${flags ? ` · ${flags}` : ""}`;
  renderOnline();
}

function renderOnline(): void {
  const peers = meStatus?.online ?? [];
  list.innerHTML = "";
  for (const peer of peers) {
    const li = el("li", "peer");
    const left = el("span", "", peer.nickname);
    const right = el("small", "", `${peer.hostname || "?"} · ${peer.addr}:${peer.port} · ${ago(peer.lastSeen)}`);
    const talk = el("button", "talk", "发消息");
    talk.type = "button";
    talk.addEventListener("click", () => {
      switchTo("chat");
      void openThread(peer.nodeId);
    });
    li.append(left, right, talk);
    list.append(li);
  }
  empty.hidden = peers.length > 0;
}

// ---------------------------------------------------------------- 对话

function threadMeta(nodeId: string): Thread | undefined {
  return threads.find((thread) => thread.nodeId === nodeId);
}

function renderThreads(): void {
  threadList.innerHTML = "";
  threadsEmpty.hidden = threads.length > 0;
  for (const thread of threads) {
    const li = el("li", `thread${thread.nodeId === active ? " is-on" : ""}`);
    const top = el("div", "thread-top");
    top.append(el("strong", "", thread.nickname));
    if (thread.online) top.append(el("span", "live", "在线"));
    const last = thread.last?.kind === "text" ? thread.last.text ?? "" : thread.last?.ack?.status === "failed" ? "（没送到）" : "（已送达）";
    li.append(top, el("small", "", `${ago(thread.last?.at ?? Date.now())} · ${last.slice(0, 40)}`));
    li.addEventListener("click", () => void openThread(thread.nodeId));
    threadList.append(li);
  }
}

function renderMessages(entries: Entry[]): void {
  const self = meStatus?.nodeId ?? "";
  const acks = new Map<string, "delivered" | "failed">();
  for (const entry of entries) {
    if (entry.kind === "receipt" && entry.ack) acks.set(entry.ack.id, entry.ack.status);
  }
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  messagesEl.innerHTML = "";
  for (const entry of entries) {
    if (entry.kind !== "text") continue;
    const mine = entry.from.nodeId === self;
    const li = el("li", `msg ${mine ? "mine" : "theirs"}`);
    const bubble = el("div", "bubble", entry.text ?? "");
    const meta = el("small", "meta", clock(entry.at));
    if (mine) {
      const ack = acks.get(entry.id);
      meta.textContent = `${clock(entry.at)} · ${ack === "failed" ? "没送到" : ack === "delivered" ? "已送达" : "发送中…"}`;
      if (ack === "failed") bubble.classList.add("is-bad");
    }
    li.append(bubble, meta);
    messagesEl.append(li);
  }
  if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function loadMessages(): Promise<void> {
  if (!active) return;
  try {
    const res = await fetch(`/api/peer/messages?peer=${encodeURIComponent(active)}`, { headers: { accept: "application/json" } });
    if (!res.ok) return;
    const body = (await res.json()) as { entries: Entry[] };
    renderMessages(body.entries ?? []);
  } catch {
    /* 下一轮再试 */
  }
}

async function openThread(nodeId: string): Promise<void> {
  active = nodeId;
  const meta = threadMeta(nodeId);
  threadHead.textContent = meta ? `${meta.nickname}${meta.online ? " · 在线" : " · 离线"}` : nodeId.slice(0, 8);
  threadBox.hidden = false;
  threadEmpty.hidden = true;
  sendError.hidden = true;
  renderThreads();
  await loadMessages();
  textInput.focus();
}

async function loadThreads(): Promise<void> {
  try {
    const res = await fetch("/api/peer/threads", { headers: { accept: "application/json" } });
    if (!res.ok) return;
    const body = (await res.json()) as { threads: Thread[] };
    threads = body.threads ?? [];
    renderThreads();
    if (!active && threads.length) await openThread(threads[0].nodeId);
    else if (active) {
      const meta = threadMeta(active);
      if (meta) threadHead.textContent = `${meta.nickname}${meta.online ? " · 在线" : " · 离线"}`;
    }
  } catch {
    /* 下一轮再试 */
  }
}

async function send(): Promise<void> {
  if (!active || sending) return;
  const text = textInput.value.replace(/\s+$/, "");
  if (!text.trim()) return;
  const bytes = byteLen(text);
  if (bytes > MAX_TEXT_BYTES) {
    sendError.textContent = `太长（${Math.round(bytes / 1024)} KB，上限 32 KB）：这一版还不能转成文件，先删一点。`;
    sendError.hidden = false;
    return;
  }
  sending = true;
  sendError.hidden = true;
  try {
    const res = await fetch("/api/peer/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ peer: active, text }),
    });
    const body = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    textInput.value = "";
    await loadMessages();
    await loadThreads();
  } catch (err) {
    sendError.textContent = (err as Error).message;
    sendError.hidden = false;
  } finally {
    sending = false;
  }
}

// ---------------------------------------------------------------- 装载 / 事件

async function load(): Promise<void> {
  try {
    const res = await fetch("/api/peer", { headers: { accept: "application/json" } });
    if (res.status === 401) return renderStatus(null, "还没登录：先在主页面用口令登录");
    if (!res.ok) return renderStatus(null, `状态读取失败（HTTP ${res.status}）`);
    renderStatus((await res.json()) as PeerView);
  } catch (err) {
    renderStatus(null, `连不上 bridge：${(err as Error).message}`);
  }
}

for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  tab.addEventListener("click", () => {
    switchTo(tab.dataset.view ?? "online");
    if (tab.dataset.view === "chat") {
      void loadThreads().then(() => {
        if (active) void loadMessages();
      });
    }
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  addError.hidden = true;
  const addr = addrInput.value.trim();
  if (!addr) return;
  try {
    const res = await fetch("/api/peer/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addr }),
    });
    const body = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    addrInput.value = "";
    await load();
  } catch (err) {
    addError.textContent = (err as Error).message;
    addError.hidden = false;
  }
});

refresh.addEventListener("click", async () => {
  addError.hidden = true;
  try {
    await fetch("/api/peer/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await load();
  } catch (err) {
    addError.textContent = `广播失败：${(err as Error).message}`;
    addError.hidden = false;
  }
});

compose.addEventListener("submit", (event) => {
  event.preventDefault();
  void send();
});

textInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void send();
  }
});

void load().then(() => loadThreads());
// 在线表与线程列表 5 秒一轮；正在看的对话 2 秒一轮 —— 都是回环请求，不值得为局域网这张页面开 WS。
setInterval(() => void load().then(() => loadThreads()), 5000);
setInterval(() => void loadMessages(), 2000);

// 在主页面里作为弹框的 iframe 打开时，「‹ 回 pi」会把整个 iframe 换成主页面，
// 所以嵌入式隐藏它 —— 关闭按钮已在弹框标题栏里。
if (window.self !== window.top) document.body.classList.add("embedded");
