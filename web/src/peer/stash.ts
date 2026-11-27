/**
 * 暂存附件的落盘：输入框上方托盘里还没发出去的截图 / 文件，关掉内网通再打开要还在。
 *
 * 文字草稿存在服务端的 threads.json（`/api/peer/thread` 的 `draft`），但附件是剪贴板来的
 * Blob，塞进 JSON 不合适，所以放浏览器自己的 IndexedDB：一条记录一个会话，值是
 * `{ name, size, blob?, path? }` 数组。打不开（隐私模式、配额满）就安静地退回「只在内存里」，
 * 不影响发消息本身。
 */

export interface StashItem {
  name: string;
  size: number;
  blob?: Blob;
  path?: string;
}

const DB = "pi-peer";
const STORE = "staged";

let opening: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

/** 读出所有会话的暂存附件。出错就当没有。 */
export async function loadStash(): Promise<Map<string, StashItem[]>> {
  const out = new Map<string, StashItem[]>();
  const d = await db();
  if (!d) return out;
  return new Promise((resolve) => {
    try {
      const tx = d.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve(out);
        const items = Array.isArray(cur.value) ? (cur.value as StashItem[]) : [];
        if (items.length) out.set(String(cur.key), items);
        cur.continue();
      };
      req.onerror = () => resolve(out);
    } catch {
      resolve(out);
    }
  });
}

/** 覆盖写某个会话的暂存附件；空数组就删掉这条。 */
export async function saveStash(peer: string, items: StashItem[]): Promise<void> {
  const d = await db();
  if (!d) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = d.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      if (items.length) store.put(items, peer);
      else store.delete(peer);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
