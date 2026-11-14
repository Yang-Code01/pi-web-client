# 局域网共享市场协议 v1（`pi-lan-market/1`）

> 状态：**首版已实现并验收（2026-11-14，schema `pi-lan-market/1`）。** 决策依据 `docs/DECISIONS.md` D248（R1~R7 共 25 项决策 + 实施补记）。
> 本文是可进版本库、可给所有节点参照的协议规范与实现约定；逐文件施工清单见 `.scratch/lan-market/PLAN.md`（被 `.gitignore:7` 忽略）。
> 标「可改」的字段是可逆默认值，改动不动 25 项决策的前提。

## 1. 范围与传输

- 每个部署了本程序的节点都是**发布者**兼**镜像**，复用组播 `239.255.42.99:7866` / HTTP `7865`（`peer/src/config.ts:10-12,69-71`），零中心服务。
- `PROTO = 1` 保持不升（`peer/src/config.ts:6`）。旧节点没有 `/market/*`，返 404 时记为 `unsupported` 并跳过，**不把它从在线表剔除**。
- 节点列表来自 `bridge/src/peer.ts:106-125` 每 5 秒拉的本机 `GET /status`；打开市场 tab 时才逐个在线节点拉一次 `GET /market/manifest` 再合并，无后台同步。
- 公网隧道（`bridge/src/index.ts:1682-1683` 的 `stepUntil = 0`）下市场只读，写操作在 bridge 侧拒掉。

## 2. 三个端点

| 端点 | 暴露面 | 说明 |
| --- | --- | --- |
| `GET /market/manifest` | LAN 开放，无身份校验 | 返回 `published` / `tombstones` / `blobs` 三层快照 |
| `GET /market/blob?publisher=<nodeId>&id=<local id>&sha256=<hex>` | LAN 开放，不要求好友 | 取本节点实际持有的 zip 字节；路径沿用 R4 的 `id=&sha256=`，`publisher` 是 R5 复合主键补的查询参数 |
| `POST /market/publish` | **仅回环** | bridge 用原始字节调：发布 / 删除 / 登记镜像 |

- 路由插在 `peer/src/http.ts:137-144` 的单 `createServer` 连续 `if` 分发里；兜底仍是 `peer/src/http.ts:453-456` 的 404。
- 单包上限沿用 `peer/src/http.ts:402` 的 64 MB；超限 `413 { "error": "太大了（上限 64 MB）" }`。
- `POST /market/publish` 非回环 403（口径同 `peer/src/http.ts:77-86`）。
- `GET /market/blob` 只按 `sha256` 命中磁盘上的 `blobs/<sha256>`；`publisher` / `id` 仅用于日志与一致性核对，不相符返回 404。
- peer 侧不解析 zip（无 zip 依赖）：解包、`safeName` / `safeRelative`、sha256 计算全部在 bridge 用 `fflate ^0.8.3`（`bridge/package.json:18`）做。

## 3. `POST /market/publish` 帧格式

```
uint32BE  manifestLen      // manifest JSON 的 UTF-8 字节数（大端）
bytes     manifestJson     // 与 zip 内 manifest.json 完全同一份内容
bytes     zipBytes         // delivery:"archive" 时为 zip 原始字节；其余 / delete 时长度 0
```

- `manifest.action`：`publish` | `delete` | `mirror`。
  - `publish`：本机原创发布；同 `(publisher, id)` 更高 `version` 即改版。
  - `delete`：写墓碑，删本机对应 blob；**不动已安装**。
  - `mirror`：安装成功后登记「见过的 published 快照 + 该版本 zip 字节」为本节点可得字节。
- peer 只校验帧长、`manifestLen` 合理、`sha256` 为 64 位 hex、`size` 与实际 `zipBytes` 长度一致；`publisher` 必须等于本机 `nodeId`（`peer/src/config.ts:98-111`）。
- 手工 zip 与「已安装」一键发布共用同一份 `manifest.json`，发布者字段以 bridge 从本机 `/status` 读到的为准，手工 zip 里写死的值不采信。

## 4. `GET /market/manifest` 响应

```json
{
  "schema": "pi-lan-market/1",
  "proto": 1,
  "nodeId": "3f2b…",
  "nickname": "小杨",
  "hostname": "DESKTOP-ABC",
  "generatedAt": 1763053200000,
  "published": [
    {
      "schema": "pi-lan-market/1",
      "action": "publish",
      "publisher": "3f2b…",
      "id": "jira-helper",
      "type": "skill",
      "name": "Jira 助手",
      "description": "从工单号生成测试用例草稿",
      "version": "1.2.0",
      "category": "公司/售后/Jira",
      "nickname": "小杨",
      "hostname": "DESKTOP-ABC",
      "at": 1763053200000,
      "delivery": "archive",
      "size": 184320,
      "sha256": "…64 位 hex…",
      "dependencies": "Node >= 22，无额外依赖",
      "notes": "首次使用需填 Jira 站点地址"
    }
  ],
  "tombstones": [
    {
      "schema": "pi-lan-market/1",
      "action": "delete",
      "publisher": "3f2b…",
      "id": "old-helper",
      "version": "1.1.0",
      "at": 1763053200001
    }
  ],
  "blobs": [
    { "publisher": "3f2b…", "id": "jira-helper", "version": "1.2.0", "sha256": "…", "size": 184320 }
  ]
}
```

- `published` 是**记录集合**，不是裁决结果：镜像把见过的全部公告原样转发（R7），合并端自己排序；重复转发不改变结果。
- `tombstones` 同样是见过的全部墓碑集合。
- `blobs` 只列本节点磁盘上真实存在的 `(publisher, id, version, sha256, size)`，不含绝对路径、不含配置内容（R6）。
- 首版不分页（可改）；单节点 manifest > 1 MB 时 bridge 截断并在 tab 提示。`bridge/src/peer.ts:130-155` 的 `request()` 有 `AbortSignal.timeout(4000)`，拉不动的节点按 `unsupported` 跳过。

## 5. 合并与裁决

- 主键 `(publisher, id)`；每条 published / tombstone 带 `version`（同 key 单调递增）与 `at`（发布者本机毫秒时间戳）。
- 排序键 **`(version, at)`**：`version` 高者优先；`version` 相同取 `at` 大者。
- 墓碑参与同一排序：其 `version` 记被删时的版本，`at` 大于它要压掉的公告 → 压掉所有更早公告。
- 删后同 id 重发：新公告 `version + 1` 且 `at` 更大，排在墓碑之前，条目复活（R7）。
- 列表只展示每个 key 的最新版（R4）；安装时对目标版本从 `blobs` 挑在线节点拉，确认页分列「原发布者」与「当前镜像主机」。
- 下载后按清单 `sha256` + `size` 强校验，不符拒装（R4）。
- 时钟回拨 / 手改系统时间会让排序反常 —— R6 已接受，确认页写明「局域网可信，非密码学保证」。

## 6. 包格式 `manifest.json`

`manifest.json` 放在 zip 根；字段见 §4 的 `published` 单条（删掉 `schema` 之外的冗余嵌套）。补充约定：

- `type`：`skill` | `extension` | `mcp`。
- `delivery` 与 `type` 组合决定安装分派（R6）：

| type | delivery | zip 内容 | 安装动作 |
| --- | --- | --- | --- |
| `skill` | `archive` | `payload/**` 实体文件 | 解到技能目录 + 写 `.market-meta.json` |
| `extension` | `archive` + `extensionKind:"loose"` | `payload/**` 文件 / 目录 | 放到 `.pi/extensions/<id>/` + 登记 settings |
| `extension` | `source-ref` + `source:"npm:…"` + `requiresNetwork:true` | 空 | `piCli({op:"pkg.install", source, local})` |
| `mcp` | `config-fragment` + `config:{mcpServers:{…}}` + `requiredVars:["JIRA_TOKEN"]` | 空 | 确认页填 `${VAR}` → `piCli({op:"mcp.add", …})` |

- `source-ref` / `config-fragment` 没有 zip 字节：`size: 0`，`sha256` 填「去掉 `sha256` 字段后的规范 manifest JSON」的 sha256，用于发现公告被改；它们不进 `blobs`，列表打「需联网」/「需填变量」标。
- zip 配额复用 `bridge/src/skillstore.ts:588-590`：单文件 ≤ 16 MB、总解压 ≤ 64 MB、文件数 ≤ 400；拒绝绝对路径、`..`、盘符、NUL、符号链接；不含 `node_modules` / 站点包 / 大二进制。
- MCP 只分享配置片段，不内置运行时代码；secret 由各人自己填（R3）。

## 7. 落盘、缓存与安装

```
~/.pi-peer/market/                      # stateDir() 见 peer/src/config.ts:31-38,98-111
  index.json                           # { published: [...], tombstones: [...], blobs: [...] }
  blobs/<sha256>                       # zip 原始字节
  meta/<sha256>.json                   # { publisher, id, version, size, at, original:boolean,
                                       #   installedAt, lastUsedAt }
```

- 2 GB 软上限（可改）：超限优先淘汰 `original:false` 且 `installedAt` 为空、`lastUsedAt` 最久远的镜像字节；本机原创发布与墓碑记录不淘汰。
- 安装落点与现有来源标记隔离（R5）：统一写 `.market-meta.json` `{ publisher, id, version, sha256, installedAt, scope }`，**不写** `.pi-store.json`、不写 `marker.local`、不挂到 `pkg.list` 的 `local` 来源；卸载走市场自己删目录 + 撤登记。避开 `bridge/src/skillstore.ts:640-653`、`bridge/src/market.ts:241-271`、`bridge/src/picli.ts:57-87` 三处已知坑。
- `scope` 沿用「全局 / 当前项目」下拉（`web/src/app.ts:13032-13038`）：全局 = `agentDir`，项目 = `<cwd>/.pi`。
- 墓碑只隐藏条目并删镜像缓存，**不动已安装**；新版只提示、不静默升级。

## 8. 信任模型与残留风险

- **不加签名**（R6）：公告 / 墓碑明文合并，sha256 只负责字节不被传输偷换；「仅原发布者可改删」是协作约定，不是密码学保证。
- 已接受的风险：同网段可冒名发布 / 伪造墓碑藏条目；原发布者离线期间镜像仍可装且墓碑等其上线才收敛；pi 包离线装不了；时钟回拨使裁决反常；blobs 全量公开暴露「这台装过哪些包」；2 GB 淘汰最久未用的镜像字节。
- 安装确认页必须明示：原发布者、当前镜像主机、完整文件清单、依赖 / 启动说明、MCP `${VAR}` 输入框，以及上述风险。

## 9. 兼容性与演进

- 旧节点：无 `/market/*` → 404 → `unsupported`，在线表照常显示；不升 `PROTO`。
- 协议演进：`schema` 取 `pi-lan-market/1`，未来不兼容升级改 schema 号并让 bridge 按号分流；本版不预留未知字段忽略策略以外的兼容承诺。
- 可改默认值：端点路径、1 MB manifest 截断、8 并发拉取、2 GB 上限、分类示例「公司 / 项目 / 其他」、`.market-meta.json` 文件名、tab 文案（走 `tr()` 并补 `web/src/i18n/en.ts` / `web/src/i18n/ja.ts`）。
