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
  kind: "text" | "receipt" | "file";
  text?: string;
  ack?: { id: string; status: "delivered" | "failed"; error?: string };
  file?: { name: string; size: number; mime: string; sha256?: string };
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

interface Contact {
  nodeId: string;
  nickname: string;
  hostname: string;
  port: number;
  friend: boolean;
  favorite: boolean;
  incoming: boolean;
  outgoing: boolean;
  at: number;
  online: boolean;
  addr: string;
  livePort: number;
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
const contactsList = document.querySelector("#contacts") as HTMLUListElement;
const contactsEmpty = document.querySelector("#contacts-empty") as HTMLElement;
const requestsBox = document.querySelector("#requests-box") as HTMLElement;
const requestsList = document.querySelector("#requests") as HTMLUListElement;
const contactsError = document.querySelector("#contacts-error") as HTMLElement;
const attach = document.querySelector("#attach") as HTMLButtonElement;
const transfersEl = document.querySelector("#transfers") as HTMLUListElement;
const picker = document.querySelector("#picker") as HTMLElement;
const crumbs = document.querySelector("#crumbs") as HTMLElement;
const placesEl = document.querySelector("#places") as HTMLUListElement;
const rootsEl = document.querySelector("#roots") as HTMLUListElement;
const filesEl = document.querySelector("#files") as HTMLUListElement;
const pickerSel = document.querySelector("#picker-sel") as HTMLElement;
const pickerUp = document.querySelector("#picker-up") as HTMLButtonElement;
const pickerSend = document.querySelector("#picker-send") as HTMLButtonElement;
const pickerClose = document.querySelector("#picker-close") as HTMLButtonElement;

let meStatus: PeerStatus | null = null;
let threads: Thread[] = [];
let contacts: Contact[] = [];
let active: string | null = null;
let sending = false;
let pickerDir = "";
let pickerParent: string | null = null;
let picked: BrowseEntry | null = null;

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
    const known = contactOf(peer.nodeId);
    if (known?.friend) {
      // 已经是好友就不给「加好友」——但没有任何提示的话，看不出为什么别人有、他没有。
      li.append(el("small", "tag", known.favorite ? "★ 好友" : "好友"));
    } else {
      const pending = Boolean(known?.incoming || known?.outgoing);
      const add = el("button", "talk ghost", pending ? (known?.incoming ? "接受请求" : "等对方接受") : "加好友");
      add.type = "button";
      add.disabled = pending && !known?.incoming;
      add.addEventListener("click", () => void friendAction(peer.nodeId, known?.incoming ? "accept" : "request"));
      li.append(add);
    }
    list.append(li);
  }
  empty.hidden = peers.length > 0;
}

// ---------------------------------------------------------------- 通讯录

function contactOf(nodeId: string): Contact | undefined {
  return contacts.find((contact) => contact.nodeId === nodeId);
}

/** 收藏只在用户点的时候变（决定 12），所以这里全部是显式动作。 */
async function friendAction(nodeId: string, action: "request" | "accept" | "favorite" | "remove", on?: boolean): Promise<void> {
  contactsError.hidden = true;
  try {
    const res = await fetch("/api/peer/friend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ peer: nodeId, action, on }),
    });
    const body = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    await loadContacts();
    await load();
  } catch (err) {
    contactsError.textContent = (err as Error).message;
    contactsError.hidden = false;
  }
}

function contactRow(contact: Contact): HTMLLIElement {
  const li = el("li", `contact${contact.favorite ? " is-fav" : ""}`);
  const dotSpan = el("span", `presence ${contact.online ? "is-up" : "is-off"}`, contact.online ? "●" : "○");
  dotSpan.title = contact.online ? "在线" : "不在线";
  const main = el("div", "contact-main");
  const name = el("strong", "", contact.nickname + (contact.favorite ? " ★" : ""));
  const sub = el("small", "", `${contact.hostname || "?"}${contact.addr ? ` · ${contact.addr}:${contact.livePort || contact.port}` : ""}`);
  main.append(name, sub);
  li.append(dotSpan, main);

  const actions = el("div", "contact-actions");
  if (contact.friend) {
    const talk = el("button", "talk", "发消息");
    talk.type = "button";
    talk.addEventListener("click", () => {
      switchTo("chat");
      void openThread(contact.nodeId);
    });
    const fav = el("button", "talk ghost", contact.favorite ? "取消收藏" : "收藏");
    fav.type = "button";
    fav.addEventListener("click", () => void friendAction(contact.nodeId, "favorite", !contact.favorite));
    actions.append(talk, fav);
  } else if (contact.outgoing) {
    actions.append(el("small", "muted", "已发请求，等对方接受"));
  }
  const del = el("button", "talk ghost danger", "删除");
  del.type = "button";
  del.title = "只从我的通讯录里移除，对方那边不变";
  del.addEventListener("click", () => void friendAction(contact.nodeId, "remove"));
  actions.append(del);
  li.append(actions);
  return li;
}

function renderContacts(): void {
  const pending = contacts.filter((contact) => contact.incoming && !contact.friend);
  requestsBox.hidden = pending.length === 0;
  requestsList.innerHTML = "";
  for (const contact of pending) {
    const li = el("li", "request");
    const who = el("div", "contact-main");
    who.append(el("strong", "", contact.nickname), el("small", "", `${contact.hostname || "?"} 想加你好友`));
    const ok = el("button", "talk", "接受");
    ok.type = "button";
    ok.addEventListener("click", () => void friendAction(contact.nodeId, "accept"));
    const no = el("button", "talk ghost", "不理");
    no.type = "button";
    no.title = "只从待处理里拿掉，不告诉对方";
    no.addEventListener("click", () => void friendAction(contact.nodeId, "remove"));
    li.append(who, ok, no);
    requestsList.append(li);
  }

  const list_ = contacts.filter((contact) => contact.friend || contact.outgoing);
  contactsList.innerHTML = "";
  for (const contact of list_) contactsList.append(contactRow(contact));
  contactsEmpty.hidden = list_.length > 0 || pending.length > 0;
}

async function loadContacts(): Promise<void> {
  try {
    const res = await fetch("/api/peer/contacts", { headers: { accept: "application/json" } });
    if (res.status === 401) return;
    const body = (await res.json()) as { contacts?: Contact[]; error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    contacts = body.contacts ?? [];
    renderContacts();
    renderOnline();
  } catch (err) {
    contactsError.textContent = `通讯录读取失败：${(err as Error).message}`;
    contactsError.hidden = false;
  }
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

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * 文件在对话里是一张卡片（决定 106）：图片直接缩略图，其它给名字、大小、下载。
 * 只认 `id`，不拼任意路径——收件目录里有什么，由 peer 的索引说了算。
 */
function fileCard(entry: Entry, mine: boolean): HTMLElement {
  const file = entry.file!;
  const card = el("div", "file-card");
  const isImage = /^image\//.test(file.mime);
  // 自己发出去的那张只留卡片、不拉缩略图：文件在你自己的盘上，收件目录里没有副本，
  // 硬拉 `/api/peer/file` 只会得到 404（用户看到的就是一个空图片框）。
  if (isImage && !mine) {
    const img = el("img", "thumb");
    img.src = `/api/peer/file?id=${encodeURIComponent(entry.id)}`;
    img.alt = file.name;
    img.loading = "lazy";
    img.addEventListener("error", () => {
      img.replaceWith(el("p", "muted", "图片没取到（可能已经被清理）"));
    });
    card.append(img);
  }
  const row = el("div", "file-row");
  row.append(
    el("span", "file-icon", isImage ? "🖼" : "📄"),
    el("span", "file-name", file.name),
    el("small", "file-size", sizeOf(file.size)),
  );
  card.append(row);
  if (!mine) {
    const link = el("a", "file-get", "另存 / 打开");
    link.href = `/api/peer/file?id=${encodeURIComponent(entry.id)}`;
    link.target = "_blank";
    link.rel = "noopener";
    row.append(link);
  }
  return card;
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
    if (entry.kind === "receipt") continue;
    const mine = entry.from.nodeId === self;
    const li = el("li", `msg ${mine ? "mine" : "theirs"}`);
    const meta = el("small", "meta", clock(entry.at));
    let bubble: HTMLElement;
    if (entry.kind === "file" && entry.file) {
      bubble = fileCard(entry, mine);
    } else {
      bubble = el("div", "bubble", entry.text ?? "");
    }
    if (mine) {
      const ack = acks.get(entry.id);
      if (entry.kind === "text") {
        meta.textContent = `${clock(entry.at)} · ${ack === "failed" ? "没送到" : ack === "delivered" ? "已送达" : "发送中…"}`;
        if (ack === "failed") bubble.classList.add("is-bad");
      } else {
        meta.textContent = `${clock(entry.at)} · 已发出`;
      }
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

// ---------------------------------------------------------------- 文件 / 选择器

interface BrowseEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
  mime?: string;
}

interface Browse {
  path: string;
  parent: string | null;
  roots: { name: string; path: string }[];
  places: { name: string; path: string }[];
  entries: BrowseEntry[];
}

function pickerNotice(text: string): void {
  pickerSel.textContent = text;
}

async function browse(dir: string): Promise<void> {
  try {
    const res = await fetch(`/api/peer/fs?path=${encodeURIComponent(dir)}`, { headers: { accept: "application/json" } });
    const body = (await res.json()) as Browse & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    pickerDir = body.path;
    pickerParent = body.parent;
    picked = null;
    pickerSend.disabled = true;
    pickerNotice("还没选文件");

    crumbs.innerHTML = "";
    const segments = body.path.split(/[\/]/).filter(Boolean);
    let acc = body.path.startsWith("/") ? "/" : "";
    for (const segment of segments) {
      acc = acc.endsWith("/") || acc.endsWith("\\") ? `${acc}${segment}` : `${acc}\${segment}`;
      const target = acc;
      const crumb = el("button", "crumb", segment);
      crumb.type = "button";
      crumb.addEventListener("click", () => void browse(target));
      crumbs.append(crumb);
    }

    placesEl.innerHTML = "";
    for (const place of body.places) {
      const item = el("li");
      const button = el("button", "ghost place", place.name);
      button.addEventListener("click", () => void browse(place.path));
      item.append(button);
      placesEl.append(item);
    }
    rootsEl.innerHTML = "";
    for (const root of body.roots) {
      const item = el("li");
      const button = el("button", "ghost place", root.name);
      button.addEventListener("click", () => void browse(root.path));
      item.append(button);
      rootsEl.append(item);
    }

    filesEl.innerHTML = "";
    if (!body.entries.length) filesEl.append(el("li", "empty", "这个文件夹是空的"));
    for (const entry of body.entries) {
      const item = el("li", `file-item${entry.dir ? " is-dir" : ""}`);
      item.dataset.path = entry.path;
      const name = el("span", "file-name", entry.name);
      const info = el("small", "file-info", entry.dir ? "文件夹" : sizeOf(entry.size));
      item.append(el("span", "file-icon", entry.dir ? "📁" : "📄"), name, info);
      item.addEventListener("click", () => {
        if (entry.dir) {
          void browse(entry.path);
          return;
        }
        for (const other of filesEl.querySelectorAll(".file-item")) other.classList.remove("is-picked");
        item.classList.add("is-picked");
        picked = entry;
        pickerSend.disabled = false;
        pickerNotice(`${entry.name} · ${sizeOf(entry.size)}`);
      });
      item.addEventListener("dblclick", () => {
        if (entry.dir) void browse(entry.path);
      });
      filesEl.append(item);
    }
  } catch (err) {
    pickerNotice(`读不了这个文件夹：${(err as Error).message}`);
  }
}

function openPicker(): void {
  picker.hidden = false;
  void browse(pickerDir || "");
}

function closePicker(): void {
  picker.hidden = true;
}

function showSendError(text: string): void {
  sendError.textContent = text;
  sendError.hidden = false;
}

async function sendPath(path: string, name?: string): Promise<void> {
  if (!active) return;
  try {
    const res = await fetch("/api/peer/sendfile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ peer: active, path, name }),
    });
    const body = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    textInput.focus();
  } catch (err) {
    showSendError(`发文件失败：${(err as Error).message}`);
  }
}

/** 拖进来 / 粘贴的图没有磁盘路径，只能把字节递过去（上限 64 MB）。 */
async function uploadBlob(name: string, blob: Blob): Promise<void> {
  if (!active) return;
  if (blob.size > 64 * 1024 * 1024) return showSendError(`「${name}」太大（上限 64 MB），用「📎」从磁盘选`);
  try {
    const res = await fetch(`/api/peer/upload?peer=${encodeURIComponent(active)}&name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": blob.type || "application/octet-stream" },
      body: blob,
    });
    const body = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  } catch (err) {
    showSendError(`发文件失败：${(err as Error).message}`);
  }
}

interface Transfer {
  id: string;
  peerId: string;
  direction: "out" | "in";
  name: string;
  size: number;
  bytes: number;
  status: "sending" | "receiving" | "done" | "failed";
  error?: string;
}

async function loadTransfers(): Promise<void> {
  if (!active) {
    transfersEl.hidden = true;
    return;
  }
  try {
    const res = await fetch("/api/peer/transfers", { headers: { accept: "application/json" } });
    if (!res.ok) return;
    const body = (await res.json()) as { transfers: Transfer[] };
    const live = (body.transfers ?? []).filter((t) => t.peerId === active && t.status !== "done");
    transfersEl.innerHTML = "";
    transfersEl.hidden = live.length === 0;
    for (const transfer of live) {
      const item = el("li", `transfer${transfer.status === "failed" ? " is-bad" : ""}`);
      const percent = transfer.size ? Math.min(100, Math.round((transfer.bytes / transfer.size) * 100)) : 0;
      item.append(
        el("span", "transfer-name", `${transfer.direction === "out" ? "发出" : "接收"} ${transfer.name}`),
        el("span", "transfer-bar"),
        el("small", "transfer-info", transfer.status === "failed" ? (transfer.error ?? "失败") : `${percent}% · ${sizeOf(transfer.bytes)} / ${sizeOf(transfer.size)}`),
      );
      (item.querySelector(".transfer-bar") as HTMLElement).style.setProperty("--p", `${percent}%`);
      transfersEl.append(item);
    }
    if (live.length) await loadMessages();
  } catch {
    /* 下一轮再试 */
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
void loadContacts();
// 在线表与线程列表 5 秒一轮；正在看的对话 2 秒一轮 —— 都是回环请求，不值得为局域网这张页面开 WS。
setInterval(() => void load().then(() => loadThreads()), 5000);
setInterval(() => void loadContacts(), 5000);
setInterval(() => void loadMessages(), 2000);

// 在主页面里作为弹框的 iframe 打开时，「‹ 回 pi」会把整个 iframe 换成主页面，
// 所以嵌入式隐藏它 —— 关闭按钮已在弹框标题栏里。
if (window.self !== window.top) document.body.classList.add("embedded");

attach.addEventListener("click", () => openPicker());
pickerClose.addEventListener("click", () => closePicker());
pickerUp.addEventListener("click", () => {
  if (pickerParent) void browse(pickerParent);
});
pickerSend.addEventListener("click", () => {
  if (!picked) return;
  void sendPath(picked.path, picked.name);
  closePicker();
});
picker.addEventListener("click", (event) => {
  if (event.target === picker) closePicker();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !picker.hidden) closePicker();
});

// 拖文件进对话：浏览器不给磁盘路径（安全），所以走字节上传。
for (const type of ["dragover", "drop"] as const) {
  threadBox.addEventListener(type, (event) => {
    event.preventDefault();
    if (type !== "drop") return;
    const files = Array.from(event.dataTransfer?.files ?? []);
    for (const file of files) void uploadBlob(file.name, file);
  });
}

// 粘贴截图：Ctrl+V 在输入框里贴的是 image/png 的 Blob，不是路径。
textInput.addEventListener("paste", (event) => {
  const items = Array.from(event.clipboardData?.items ?? []);
  const shots = items.filter((item) => item.kind === "file" && item.type.startsWith("image/"));
  if (!shots.length) return;
  event.preventDefault();
  shots.forEach((item, index) => {
    const blob = item.getAsFile();
    if (!blob) return;
    const ext = blob.type.split("/")[1] || "png";
    const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false }).replace(/:/g, "");
    void uploadBlob(`截图 ${stamp}${index ? `-${index}` : ""}.${ext}`, blob);
  });
});

setInterval(() => void loadTransfers(), 1000);
