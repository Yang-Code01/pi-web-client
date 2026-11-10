/**
 * MCP 商店的「默认服务名」与「这条装没装过」（#299 / #300）。
 *
 * 用例里的服务名都来自本机真实索引（`market/mcp-index.json`，2026-11-08），不是编的：
 * 这几个正是以前会撞成 `mcp` / `server`、或者装完仍显示「安装」的条目。
 *
 * Run: node --experimental-transform-types web/tests/mcpstore-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freeName, matchInstalled, sameName, serverNameFor } from "../src/mcpstore.ts";

test("短名够特别时保持原样", () => {
  assert.equal(serverNameFor("com.browser-use/browser-use"), "browser-use");
  assert.equal(serverNameFor("ai.com.mcp/skills-search"), "skills-search");
  assert.equal(serverNameFor("app.pascal/editor"), "editor");
  assert.equal(serverNameFor("dev.ohmyposh/validator"), "validator");
});

test("短名是泛称时带上 registry owner，不再一律叫 mcp", () => {
  assert.equal(serverNameFor("app.worldmonitor/mcp"), "worldmonitor");
  assert.equal(serverNameFor("io.changedetection/mcp"), "changedetection");
  assert.equal(serverNameFor("dev.openstatus/mcp"), "openstatus");
  assert.equal(serverNameFor("com.puter/mcp-server"), "puter");
  assert.equal(serverNameFor("io.github.BuilderIO/mcp"), "builderio");
});

test("短名尾部 -mcp / -mcp-server 仍然剥掉", () => {
  assert.equal(serverNameFor("com.apify/apify-mcp-server"), "apify");
  assert.equal(serverNameFor("io.github.x/foo-mcp"), "foo");
});

test("没有命名空间、也拿不到 owner 时退回 mcp（由 freeName 补后缀）", () => {
  assert.equal(serverNameFor("mcp"), "mcp");
  assert.equal(serverNameFor("mcp-server"), "mcp-server");
});

test("默认名撞车时加后缀，大小写不敏感", () => {
  const installed = [{ name: "worldmonitor" }, { name: "WorldMonitor-2" }];
  assert.equal(freeName("worldmonitor", []), "worldmonitor");
  assert.equal(freeName("worldmonitor", installed), "worldmonitor-3");
  assert.equal(freeName("fresh", installed), "fresh");
});

test("同名判断只看名字，空名字不算撞", () => {
  const installed = [{ name: "mcp" }];
  assert.equal(sameName("MCP", installed)?.name, "mcp");
  assert.equal(sameName("  ", installed), null);
  assert.equal(sameName("other", installed), null);
});

test("远程条目按 URL 认（末尾斜杠与大小写不影响）", () => {
  const installed = [{ name: "worldmonitor", transport: "http", url: "https://worldmonitor.app/mcp" }];
  assert.equal(matchInstalled({ kind: "remote", identifier: "https://worldmonitor.app/mcp/", url: "https://worldmonitor.app/mcp/" }, installed)?.name, "worldmonitor");
  assert.equal(matchInstalled({ kind: "remote", identifier: "https://mcp.puter.com/", url: "https://mcp.puter.com/" }, installed), null);
});

test("npm / pypi / docker 按参数里的包名认，不被前缀骗到", () => {
  const npm = [{ name: "pascal", command: "npx", args: ["-y", "@pascal-app/mcp@1.0.0"] }];
  assert.equal(matchInstalled({ kind: "npm", identifier: "@pascal-app/mcp" }, npm)?.name, "pascal");
  assert.equal(matchInstalled({ kind: "npm", identifier: "@pascal-app/mcp-extra" }, npm), null);

  const pypi = [{ name: "browser-use", command: "uvx", args: ["browser-use==0.13.14", "--cli-mcp"] }];
  assert.equal(matchInstalled({ kind: "pypi", identifier: "browser-use" }, pypi)?.name, "browser-use");
  assert.equal(matchInstalled({ kind: "pypi", identifier: "browser" }, pypi), null);

  const oci = [{ name: "bar", command: "docker", args: ["run", "-i", "--rm", "ghcr.io/foo/bar:1.2"] }];
  assert.equal(matchInstalled({ kind: "oci", identifier: "ghcr.io/foo/bar" }, oci)?.name, "bar");
});

test("老桥只发名字时退回按名字比，不至于全显示未安装", () => {
  const legacy = [{ name: "browser-use", transport: "stdio" }];
  assert.equal(matchInstalled({ kind: "pypi", identifier: "browser-use" }, legacy)?.name, "browser-use");
});
