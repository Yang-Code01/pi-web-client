#!/usr/bin/env python
"""知识库资源转码：把 BuildHub 站点的图片 / 视频缩成客户端背得动的 webp。

由 `tools/sync-knowledge.mjs` 调用，输入一份 JSON：

    {"jobs": [{"src": "E:/.../public/assets/a.png", "dst": "E:/.../knowledge/assets/a-1a2b3c4d.webp",
               "kind": "image", "maxWidth": 1400, "quality": 82}, ...]}

- `kind: "image"` → 宽超过 `maxWidth` 才缩，转 webp（带 alpha 的保留 alpha）；
- `kind: "video"` → ffmpeg 抽一帧当封面再转 webp（机器上没有 ffmpeg 就报错，让 Node 那边看得见）。

输出一行 JSON：`{"done": n, "failed": [[src, 原因], ...], "inBytes": n, "outBytes": n}`。
单个资源失败只记账、不掐断整批：187 MB 的素材墙里总有一两张读不开的。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image

FFMPEG = shutil.which("ffmpeg") or ""
DEFAULT_WIDTH = 1200
DEFAULT_QUALITY = 74


def _int(value, fallback):
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _ensure_dir(dst):
    """建出目标目录；路径不可写就在这里失败，好让上层记到单个资源头上。"""
    try:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
    except OSError as exc:
        raise RuntimeError(f"建目录失败：{exc}") from exc


def convert_image(job):
    src, dst = job["src"], job["dst"]
    max_width = _int(job.get("maxWidth"), DEFAULT_WIDTH)
    quality = _int(job.get("quality"), DEFAULT_QUALITY)
    _ensure_dir(dst)
    try:
        with Image.open(src) as im:
            im.load()
            # 动图只取第一帧：知识库是静态阅读页，动图在 webp 里会变成几十 MB。
            if getattr(im, "is_animated", False):
                im.seek(0)
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGBA" if "A" in im.getbands() or im.mode == "P" else "RGB")
            # thumbnail 只缩不放，重采样默认就是 LANCZOS，也不用绑 Pillow 版本里的常量名。
            if im.width > max_width:
                im.thumbnail((max_width, max_width))
            im.save(dst, quality=quality, method=6)
    except (OSError, ValueError) as exc:  # 打不开 / 存不下都只算这一张失败
        raise RuntimeError(str(exc).splitlines()[0]) from exc
    try:
        return os.path.getsize(dst)
    except OSError as exc:
        raise RuntimeError(str(exc)) from exc


def convert_video(job):
    src, dst = job["src"], job["dst"]
    if not FFMPEG:
        raise RuntimeError("没有 ffmpeg")
    max_width = _int(job.get("maxWidth"), DEFAULT_WIDTH)
    quality = _int(job.get("quality"), 80)
    _ensure_dir(dst)
    with tempfile.TemporaryDirectory() as tmp:
        frame = os.path.join(tmp, "frame.png")
        try:
            subprocess.run(
                [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-ss", "0.6", "-i", src,
                 "-frames:v", "1", frame],
                check=True,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise RuntimeError(f"ffmpeg 抽帧失败：{exc}") from exc
        return convert_image({"src": frame, "dst": dst, "maxWidth": max_width, "quality": quality})


def main():
    try:
        with open(sys.argv[1], encoding="utf-8") as fh:
            manifest = json.load(fh)
    except (OSError, ValueError) as exc:
        print(json.dumps({"done": 0, "failed": [["manifest", str(exc)]], "inBytes": 0, "outBytes": 0}))
        return
    failed = []
    in_bytes = out_bytes = 0
    done = 0
    for job in manifest.get("jobs", []):
        try:
            in_bytes += os.path.getsize(job["src"])
            out_bytes += convert_video(job) if job["kind"] == "video" else convert_image(job)
            done += 1
        except Exception as exc:  # noqa: BLE001 — 单个资源失败不该掐断整批
            failed.append([job.get("src", ""), str(exc).splitlines()[0][:200]])
    print(json.dumps({"done": done, "failed": failed, "inBytes": in_bytes, "outBytes": out_bytes}, ensure_ascii=False))


if __name__ == "__main__":
    main()
