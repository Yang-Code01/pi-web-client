/**
 * 图片管线：剪贴板/拖拽抖文件 → 挑出图片 → 压成 `{data,mimeType}`。
 *
 * 主输入框（`app.ts` 的 `addImages`）和随手问（`scratch.ts`）共用这一份，压缩参数只写一处：
 * 同一张截图在两处应当一样清楚（#402）。这里不碰 DOM 之外的东西，也不做 i18n——提示文案
 * 留在各自的层里，函数只把「哪几个文件没成」还回去。
 */

/** 待发给 pi 的一张图：base64 正文 + mime。 */
export type PendingImage = { data: string; mimeType: string };

/**
 * 从剪贴板里抖出文件（截图、从资源管理器复制的文件）。截图粘贴在 Chrome/Safari/Firefox 上都以
 * file item 出现，但 Safari 有时只给 files 不给 items，所以两条路都试。
 */
export function pastedFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  if (!out.length) out.push(...Array.from(data.files ?? []));
  return out;
}

/** Images keep going to the model as pixels; every other file is referenced by path. */
export function splitImages(files: File[]): { images: File[]; others: File[] } {
  const images: File[] = [];
  const others: File[] = [];
  for (const f of files) (f.type.startsWith("image/") ? images : others).push(f);
  return { images, others };
}

/** Picked files with these extensions get attached like a pasted image instead of inserted as a path. */
export const ATTACH_IMAGE = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;

/** SVG has no pixels: render it through an <img> (scripts never run there) onto a canvas. */
export async function rasterizeSvg(file: File): Promise<ImageBitmap | null> {
  const url = URL.createObjectURL(file.type ? file : new Blob([file], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (!w || !h) {
      w = 1024;
      h = 1024;
    }
    const scale = Math.max(1, 1024 / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff"; // jpeg has no alpha; transparent svg strokes would vanish on black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await createImageBitmap(canvas);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 长边 2048、JPEG 0.86；解不出位图时退回原字节（不压，但至少能发）。 */
export async function downscale(file: File, bitmap: ImageBitmap | null): Promise<PendingImage> {
  const max = 2048;
  if (!bitmap) {
    const buf = new Uint8Array(await file.arrayBuffer());
    // 分块拼：`String.fromCharCode(...buf)` 在几百 KB 的图上会先把调用栈撑爆（#402 顺手修）。
    let binary = "";
    for (let at = 0; at < buf.length; at += 0x8000) binary += String.fromCharCode(...buf.subarray(at, at + 0x8000));
    return { data: btoa(binary), mimeType: file.type || "image/png" };
  }
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.86);
  return { data: dataUrl.split(",")[1], mimeType: "image/jpeg" };
}

/** 一个图片文件 → 待发图；SVG 渲染不出来时返回 null（提示由调用方给）。 */
export async function readImageFile(file: File): Promise<PendingImage | null> {
  const isSvg = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
  const bitmap = isSvg ? await rasterizeSvg(file) : await createImageBitmap(file).catch(() => null);
  if (isSvg && !bitmap) return null;
  return await downscale(file, bitmap);
}

/** 一批图片文件 → 待发图 + 没能渲染的文件名（顺序保持不变）。 */
export async function imagesFromFiles(files: readonly File[]): Promise<{ images: PendingImage[]; failed: string[] }> {
  const images: PendingImage[] = [];
  const failed: string[] = [];
  for (const file of files) {
    const image = await readImageFile(file);
    if (!image) {
      failed.push(file.name);
      continue;
    }
    images.push(image);
  }
  return { images, failed };
}
