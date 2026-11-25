#!/usr/bin/env node
/**
 * 控制通道的权限边界（第 3 条评审）：unix socket 必须待在当前用户独占的目录里，
 * 目录 0700、socket 0600。Windows 的命名管道走 ACL，这里不重复考。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { controlPath, serveControl } from "../dist/host/control.js";

if (process.platform === "win32") {
  console.log("control-unit: ok (win32 命名管道跳过)");
  process.exit(0);
}

// 用 0 号口：真实壳不会监听 0，避免测试把正在跑的壳的控制 socket 当成残留文件删掉。
const sock = controlPath(0);
const dir = path.dirname(sock);
assert.ok(sock.includes(`pi-web-${process.getuid()}`), "socket 要在按 uid 分开的目录里，不能躺在共享 tmpdir 根下");
assert.equal(path.dirname(sock), dir);

const server = await serveControl(sock, () => {});
try {
  const dirMode = fs.statSync(dir).mode & 0o777;
  const sockMode = fs.statSync(sock).mode & 0o777;
  assert.equal(dirMode, 0o700, "控制通道目录只给当前用户");
  assert.equal(sockMode, 0o600, "控制套接字只给当前用户读写");
  console.log("control-unit: ok");
} finally {
  await new Promise((resolve) => server.close(resolve));
  try {
    fs.unlinkSync(sock);
  } catch {
    /* 已经没了 */
  }
}
