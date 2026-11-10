# Jira 搜索

状态：设计已定（D207），实现拆在 #256–#259。
原型：`.scratch/jira-search-prototype/index.html`（不入库，只用于形态对比）。

## 1. 范围

v1 面板只有一条固定查询「分配给我 + 未解决」（D203）。本功能加第二个入口：按人（包括别人的工单）和条件查，结果行与列表一致，可展开详情、下载附件、交给 agent。

**做：** 结构化条件、JQL 由桥拼、人员选择器、关注者无权限降级、20 条分页、最近一次条件记忆。

**不做：** 原始 JQL、Jira 写操作、多站点、评论正文、总数统计、保存多组筛选、看板 / 自定义字段。

## 2. 形态（A：面板内两颗 tab）

```
┌ Jira ───────────────────────────────── × ┐
│  我的未完成   │   搜索                     │  tablist
├───────────────────────────────────────────┤
│ 搜索工单                     已显示 20 条 │
│ [标题关键字] [全文本] [项目] [状态类别]   │
│ [具体状态] [类型] [优先级] [排序]         │
│ 某个人 [combobox……………] □经办 □报告 □关注 │
│ □未分配  □含已解决      [搜索]  Enter 也能搜│
│ ── 关注者条件未生效：没有查看关注者的权限 ──│
│ ACME-412 登录页在 Safari 17 上白屏  [交给 agent]│
│ …                                         │
│                [加载更多]                 │
└───────────────────────────────────────────┘
```

- 两颗 tab 平权；两个 pane 各自是滚动容器，切回不丢滚动位置与展开状态。默认落在「我的未完成」。
- 搜索区沿用 v1 的视觉语言（`.jira-section`、`.jira-issue`、`.btn`），不引入新的设计系统。
- 结果行与列表行是同一套渲染：同样的 key 链接、meta 行、展开详情、「交给 agent」。

## 3. 条件模型

### 3.1 参数与 JQL 映射

| 界面 | 参数 | 取值 / 上限 | 拼进 JQL |
| --- | --- | --- | --- |
| 标题关键字 | `title` | ≤ 200 字符 | `summary ~ "…"` |
| 全文本 | `text` | ≤ 500 字符 | `text ~ "…"` |
| 项目 | `project` | `^[A-Z][A-Z0-9_]{0,9}$` | `project = "ACME"` |
| 状态类别 | `statusCategory` | `new` / `indeterminate` / `done` | `statusCategory = "To Do"` / `"In Progress"` / `"Done"` |
| 具体状态 | `status` | ≤ 64 字符，**必须带 project** | `status = "In Progress"` |
| 类型 | `type` | ≤ 64 字符 | `issuetype = "Bug"` |
| 优先级 | `priority` | ≤ 64 字符 | `priority = "Highest"` |
| 某人 | `person` / `personAccountId` | ≤ 200 / ≤ 128 | 见下 |
| 关系 | `relations` | `assignee,reporter,watcher` 的逗号子集 | 见下 |
| 未分配 | `unassigned` | `1` / 省略 | `assignee IS EMPTY` |
| 含已解决 | `includeResolved` | `1` / 省略 | 去掉默认的 `resolution = Unresolved` |
| 排序 | `sort` | `updated` / `created` / `priority` | `ORDER BY …` |
| 方向 | `order` | `asc` / `desc` | 默认 `desc` |
| 下一页 | `nextPageToken` | ≤ 2048 字符 | 原样透传 |

`personAccountId` 优先于 `person`；两者都只作为**等值字符串**使用（Jira 自己解析 accountId / 邮箱 / 名字），都过转义。`maxResults` 固定 20，页面传的值忽略。

### 3.2 拼装规则

固定顺序，简单条件不加括号，人员组整体加括号：

```
[resolution = Unresolved AND]
[summary ~ "…" AND]
[text ~ "…" AND]
[project = "…" AND]
[statusCategory = "…" AND]
[status = "…" AND]
[issuetype = "…" AND]
[priority = "…" AND]
[(assignee = "x" OR reporter = "x" OR watcher = "x") AND]
[assignee IS EMPTY AND]
ORDER BY <sort> <order>[, updated DESC]
```

- 默认（无条件）：`resolution = Unresolved ORDER BY updated DESC`。
- `person` 给定时 `relations` 至少一项；默认三项全选，组内 OR。
- `unassigned` 与人员条件互斥；勾了未分配就不提交人。
- `status` 必须有 `project`：状态名可跨项目重名，未选项目时页面也无法列出全量状态。
- `sort=priority` 时补 `updated DESC` 作次序；`sort=updated` 不重复。
- 关键字不拆词、不加通配符，整串交给 Jira 的 `~`。

### 3.3 转义与长度

- `escJql(s)`：`\` → `\\`，`"` → `\"`，`\r` / `\n` / `\t` 等控制字符 → 空格，再 `trim()`。
- 用户输入永远只出现在引号内的**值**位置；字段名、操作符、排序方向都来自白名单。
- 只含控制字符的值转义后为空，按未填处理（不会拼出 `field ~ ""`）。
- 超长直接 400，不截断（截断会让用户以为查的是全串）。

### 3.4 校验

| 情况 | 状态码 / code | field |
| --- | --- | --- |
| `status` 无 `project` | 400 `jira_query` | `status` |
| `person` 与 `unassigned` 同给 | 400 `jira_query` | `unassigned` |
| `person` 给了但 `relations` 为空 / 含未知值 | 400 `jira_query` | `relations` |
| 不按人查时，`relations` 的值不校验、不参与拼装 | — | — |
| 枚举不合法（`statusCategory` / `sort` / `order`） | 400 `jira_query` | 对应字段 |
| 超长 / 项目 key 形状不对 / token 过长 | 400 `jira_query` | 对应字段 |
| 上游对 JQL 回 400 | 400 `jira_query` | —（带可读上游消息） |

未知 query 参数一律忽略（向前兼容）；页面没有 `jql` 参数入口。

## 4. 接口

三条都只读；GET；隧道访客可用。成功响应带 `"ok": true`，失败沿用 `{ error, code }`（可再加 `field`）。

### 4.1 `GET /api/jira/search`

```
GET /api/jira/search?title=登录&project=ACME&statusCategory=indeterminate
    &personAccountId=5b10ac8d82e05b22cc7d4ef5&relations=assignee,reporter,watcher
    &sort=updated&order=desc
```

上游：`GET /rest/api/3/search/jql`，`jql=<拼装结果>`、`maxResults=20`、`fields=summary,issuetype,priority,status,assignee,updated`；`nextPageToken` 有就带。

```json
{
  "ok": true,
  "issues": [
    {
      "key": "ACME-412",
      "summary": "登录页在 Safari 17 上白屏",
      "type": "Bug",
      "priority": "Highest",
      "status": "In Progress",
      "assignee": "陈雷",
      "updated": "2025-11-09T06:02:00.000+0000"
    }
  ],
  "nextPageToken": "…",
  "isLast": false,
  "degraded": { "watchers": true }
}
```

- `assignee` 是显示名；未分配为 `""`。`JiraIssue` 增加这个字段，列表接口同一映射、同一字段集合（多一个只读字段，向后兼容）。
- 新版 `search/jql` 不返回 total，所以没有 `total`；`isLast` 缺失时按 `!nextPageToken` 推断。
- 结果**不缓存**。

### 4.2 `GET /api/jira/meta?project=ACME`

```json
{
  "ok": true,
  "statusCategories": ["new", "indeterminate", "done"],
  "types": [{ "id": "10001", "name": "Bug" }],
  "priorities": [{ "id": "1", "name": "Highest" }],
  "statuses": [{ "id": "3", "name": "In Progress" }],
  "partial": false
}
```

- `types` ← `/rest/api/3/issuetype`；`priorities` ← `/rest/api/3/priority`；`statuses` ← `/rest/api/3/project/{key}/statuses`（按状态名扁平去重，只在带 `project` 时取）。
- `statusCategories` 是桥内常量，`new` / `indeterminate` / `done`；中文标签由页面 `tr()` 给。
- 5 分钟内存缓存，键含当前配置与 project；失败的响应不缓存。statuses 取不到时 `statuses: []`、`partial: true`，不让整单失败。

### 4.3 `GET /api/jira/users?q=林`

上游 `/rest/api/3/user/search?query=…&maxResults=20`：

```json
{ "ok": true, "users": [{ "accountId": "…", "displayName": "林小满", "emailAddress": "…" }] }
```

- 该接口需要 `Browse users and groups` 权限。上游 403 → **200** `{ "ok": true, "users": [], "unavailable": true }`，页面据此退化成自由文本，不弹错误；401 照常回 `jira_auth`，别把凭据失效伪装成「搜不了人」。
- 其它错误照常 502。
- 不做缓存（人名搜索是即时交互）。

### 4.4 错误码

| code | HTTP | 含义 |
| --- | --- | --- |
| `jira_not_configured` | 400 | 还没连接 |
| `jira_query` | 400 | 参数或 JQL 不合法 |
| `jira_auth` | 401 | 凭据失效 |
| `jira_forbidden` | 403 | 没有权限（含「只勾了关注者且无权限」） |
| `jira_upstream` | 502 | 上游非 2xx / 不可读 |
| `jira_network` | 502 | 连不上 / 超时 |

## 5. 关注者降级

带 `watcher` 的查询可能被 Jira 以 400/403 拒绝（缺 `View Voters and Watchers`，且查的不是自己）。处理：

1. 仅当 `relations` 含 `watcher`，且还剩下至少一个 `assignee` / `reporter` 时，去掉 `watcher` 重试**一次**。
2. 重试成功 → 200，带 `degraded: { watchers: true }`；页面在结果上方说明「关注者条件未生效：当前账号没有查看关注者的权限，已按经办人 / 报告人查询」。
3. 只剩 `watcher` 一项时不重试——去掉就变成「无条件」，结果会悄悄变宽。直接 403 `jira_forbidden`，页面提示改选经办人或报告人。
4. 重试仍失败 → 按第二次的错误映射（400 → `jira_query`，403 → `jira_forbidden`，401 → `jira_auth`）。

代价：真正的 JQL 错误会多打一次上游；换来的是大多数人不至于因为一个勾选就一条结果都看不到。判断不靠匹配上游文案（会随语言变），只看状态码 + 重试是否成功。

## 6. 页面行为

### tab 与状态

- `role=tablist` / `role=tab` / `role=tabpanel`，`aria-selected`；左右方向键可切（可选，不阻塞验收）。
- 每个 pane 自己 `overflow: auto`；切换只改 `hidden`，不重建 DOM。
- 默认 list。首次切到 search：有保存的条件就回填并自动跑一次；没有就跑空条件（全部未解决）。**每个面板实例最多自动跑一次**，之后切 tab 不重跑。

### 表单

- 4 / 2 / 1 列响应式；具体状态在未选项目时置灰，placeholder「先选项目」；清空项目时连带清空状态。
- 类型 / 优先级选项全部来自 `/api/jira/meta`；不在前端硬编码。
- 「搜索」按钮 + Enter 提交；改条件不自动搜。
- 勾「未分配」→ 人员输入与三个关系勾置灰；取消恢复原选择。
- 勾「含已解决」→ 提交 `includeResolved=1`。

### 人员选择器

- 输入 ≥ 2 字，防抖 250ms 调 `/api/jira/users`；下拉最多 8 条，键盘上下 + Enter 可选。
- 选中后固定 `accountId` + `displayName`，显示为一颗可清除的 chip；再输入即重新搜。
- `unavailable` → 保持自由文本输入，输入框下给一行「用户搜索不可用，可手输邮箱或 accountId」，提交时带 `person`。
- 名字重名时以选中的 accountId 为准；自由文本由 Jira 解析，找不到人时上游 400 → `jira_query`，页面原样显示。

### 记忆

`localStorage["pi.jira.search.last"]`，点搜索时写入，只存条件与选中的人，不存 token：

```json
{
  "v": 1,
  "title": "登录",
  "text": "",
  "project": "ACME",
  "statusCategory": "",
  "status": "",
  "type": "Bug",
  "priority": "",
  "person": { "accountId": "…", "displayName": "林小满" },
  "personText": "",
  "relations": ["assignee", "reporter", "watcher"],
  "unassigned": false,
  "includeResolved": false,
  "sort": "updated",
  "order": "desc"
}
```

打开面板读回；坏 JSON / 未知枚举 / 类型不对的字段丢弃，不抛错。不保存结果。

### 结果与分页

- 首屏 20；`nextPageToken` + 「加载更多」追加，按 key 去重；`isLast` 后按钮消失，显示「已显示 N 条 · 已全部加载」。
- 没有 total：「已显示 N 条」就是全部能说的；不额外打估算接口。
- 加载更多在途时禁用按钮；追加后不重置滚动。
- 请求序号保护：只接受最后一次请求的响应，旧响应丢弃。

### 状态

- 加载中：搜索按钮 busy；结果区显示「正在查询…」。
- 空：`没有符合条件的工单` + 「清空条件」。
- 错误：保留条件，显示错误 + 「重试」；401/403 沿用 v1 的「凭据失效 / 去改 token」块。
- 降级：结果上方固定一行说明（见 §5），不挡住结果。

### 复用

详情、下载、交给 agent 全部复用 v1：`GET /api/jira/issues/:key`、`POST …/download`、`openHandoffMenu()`；详情仍按 key 记在面板实例的 Map 里，列表与搜索结果共享同一份。

### i18n 与可访问性

新增文案全部 `tr()`，`en.ts` / `ja.ts` 同键补齐；人员下拉、tab 的 aria 关系、输入框 label 一并做。

## 7. 缓存

| 数据 | 缓存 |
| --- | --- |
| 搜索结果 | 不缓存（条件多变，且必须对应当前凭据） |
| meta（类型/优先级/项目状态） | 5 分钟，桥内存，键 = 配置 + project |
| 用户搜索 | 不缓存 |
| 我的未完成 / 项目 chips | 沿用 D203 的 60 秒缓存，不动 |

## 8. 公网隧道

三条都是 GET，隧道访客照常可用
；没有写路径，不涉及 `tunnel_readonly`。

## 9. 测试与验收

### bridge（#256 / #257）

- `node bridge/tests/jira-search-unit.mjs`：每个条件、组合顺序、默认未解决、includeResolved、unassigned、关系 OR、排序、转义正反例、校验错误、token 透传；断言拼出的 JQL 逐字。
- `node bridge/tests/jira-e2e.mjs`：假 Jira 上断言收到的 JQL 与 fields、分页、watcher 重试 / 不再重试（只勾 watcher）、meta 缓存与 partial、users 403 → unavailable、隧道 GET、未配置、搜索结果不缓存。

### web（#258 / #259）

- `node web/tests/jira-unit.mjs`：条件 → query（空值不带）、坏 localStorage、项目清空连带清状态、未分配与人员互斥、分页合并去重与 `isLast` 文案函数。
- `npm --prefix web run typecheck`（含 i18n-check）、`npm run build:web`。

### 手点清单

1. 连接后切「搜索」→ 默认全部未解决，20 条。
2. 输入人名 → 选人 → 只勾关注者搜索；无权限时看到 403 提示，改勾经办人 / 报告人后可查。
3. 勾上关注者（还有经办人）→ 搜索成功但顶部出现降级说明。
4. 选项目 → 具体状态可选项出现；清项目 → 状态清空并置灰。
5. 勾未分配 → 人员区置灰；结果都是未分配。
6. 勾含已解决 → 条数变多。
7. 加载更多直到「已全部加载」。
8. 关面板重开 → 条件回填；首次进搜索只自动跑一次。
9. 隧道访问 → 搜索照常。
10. 窄屏 1 列，不横向溢出。
11. 结果行展开详情、下载、交给 agent 与列表一致。
12. 搜索结果行的 meta 显示经办人；未分配或上游不给名字时显示「未分配」；「我的未完成」列表不显示经办人。

## 10. 已知偏移 / 待实机确认

- **只看状态码判断关注者权限**：不解析上游文案（会随语言变）；代价是真正的 JQL 错误会多一次重试。
- **`text ~` 的覆盖范围**由 Jira 决定（描述 / 评论 / 其它文本字段），桥不解释；Cloud 没有「评论作者」检索字段，关注者 / 评论作者是两件事。
- **类型 / 优先级列表是全局的**：可能包含当前项目不用的类型；选中后查不到结果，不是错误。
- **没有 total**：`search/jql` 不返回；如果将来上游给了近似数，再加字段，不改现有形状。
- **状态类别用英文名拼 JQL**（`"To Do"` 等），与界面语言无关；上游若改类别名，只改 `STATUS_CATEGORIES` 一处。
- **`assignee` 加进 `JiraIssue`** 会让列表响应多一个字段；「我的未完成」列表暂不显示它，搜索结果行显示；空串（未分配或上游按隐私策略不给名字）统一显示「未分配」。
