# 命令与故障处置

全部命令都带 `-C "$ROOT"`（`ROOT` 从 `git rev-parse --path-format=absolute --git-common-dir | xargs dirname` 来，见 SKILL.md 第一节）。

## 读锚点与新提交

```bash
git -C "$ROOT" fetch origin main
ANCHOR=$(git -C "$ROOT" show origin/main:CHANGELOG.md | grep -m1 -oE '写到 [0-9a-f]{7,40}' | awk '{print $2}')
NEW=$(git -C "$ROOT" rev-parse --short origin/main)
git -C "$ROOT" log --first-parent --date=short --format='%h %ad %s' "$ANCHOR..origin/main"
```

`--first-parent` 是必须的：分支上的中间提交不进日志，只看合进 main 的那一串。

## 新决定（D 号）

```bash
git -C "$ROOT" diff "$ANCHOR"..origin/main -- docs/DECISIONS.md | grep -E '^\+## D[0-9]+'
```

标题是 `## D<编号> …`（两个井号），不是 `###`。

只有**新加的**决定值得写进「设计决定」组；改措辞、改代价的不算新东西。

## worktree

```bash
STAMP=$(date +%Y%m%d-%H%M)
WT="F:/pi-web-client-wt/changelog-$STAMP"
git -C "$ROOT" worktree add "$WT" -b "docs/changelog-$STAMP"
```

worktree 一律放 `F:/pi-web-client-wt/`（仓库规矩），不要放到仓库内部。

## 提交

```bash
git -C "$WT" add CHANGELOG.md
git -C "$WT" commit -m "docs(changelog): <YYYY-MM-DD> 批次，<N> 条"
```

## 推送：先直连，再代理

本机 GitHub **有时直连不通**。顺序试，不要一上来就挂代理：

```bash
BR="docs/changelog-$STAMP"
git -C "$WT" push -u origin "$BR"          # ① 直连
```

失败（`Failed to connect to github.com:443` / 超时）才走 ②，先验代理活着：

```bash
PROXY="${BILLION_CONTEXT_PROXY:-http://127.0.0.1:18791}"   # 变量没导出时用这个字面端口（本机实测）
HTTPS_PROXY="$PROXY" gh api rate_limit >/dev/null && echo "代理通"   # 判网络用 gh，不用 curl（见 docs/agents/issue-tracker.md）
TOKEN=$(gh auth token --user Yang-Code01)
git -C "$WT" -c http.https://github.com/.proxy="$PROXY" \
  -c credential.helper= \
  push https://x-access-token:$TOKEN@github.com/Yang-Code01/pi-web-client.git "$BR:$BR"
```

`credential.helper=` 不能省：不省的话本机的凭据管理器会抢答，用错账号。

## 开 PR

```bash
HTTPS_PROXY="$PROXY" GH_TOKEN=$(gh auth token --user Yang-Code01) \
  gh pr create --repo Yang-Code01/pi-web-client --base main --head "$BR" \
  --title "更新日志：<YYYY-MM-DD> 批次（<N> 条）" \
  --body "$(cat <<'EOF'
## 做了什么
从 <旧锚点> 到 <新锚点> 的 <K> 个合并，写成 <N> 条（新增 a / 修复 b / 设计决定 c）。

## 依据
- 提交：`git log --first-parent <旧锚点>..<新锚点>`
- 新决定：`docs/DECISIONS.md` 的 D<…>（若有）

## 自查
- 只动了 `CHANGELOG.md`；批次比基线多 1 批；锚点改成 `<新锚点> · <日期>`
- 每条都带 #PR 或 D 号，没有内部重构条目

## 没做
没碰源码与 README；不合并，等作者看过条目措辞再合。
EOF
)"
```

## 出错怎么办

| 症状 | 原因与处置 |
|---|---|
| `gh pr create` 报 403、`does not have the correct permissions` | `gh` 的 active 账号不是 `Yang-Code01`。逐条带 `GH_TOKEN=$(gh auth token --user Yang-Code01)`；**不要** `gh auth switch` 了不切回来 |
| push 403 / `Permission denied` | 同上，或忘带 `-c credential.helper=` |
| `Failed to connect to github.com:443` | 直连不通，走上面的 ② |
| `gh api rate_limit` 挂了 / `gh` 超时 | 代理没起或端口变了（旧的 18790 已不在监听）；先问用户，不要改全局 `http.proxy` |
| `fatal: '<branch>' is already used by worktree` | 名字撞了，换 `STAMP`；顺手 `git -C "$ROOT" worktree list` 看看有没有该清的僵尸 |
| 锚点为空 | 有人删了 `CHANGELOG.md` 开头的注释，停下问用户 |
| `git log $ANCHOR..origin/main` 说 unknown revision | 锚点是别人本地还没 push 的 SHA，或 fetch 没跑成；重跑 `fetch origin main`，仍失败就换成 `origin/main` 上能找到的最近锚点并告知用户 |

## 收尾（用户说合并之后才做）

```bash
node "$ROOT/tools/worktree-remove.mjs" "$WT"   # 先拆外链再删，见 AGENTS.md
git -C "$ROOT" branch -d "$BR"
```

合并前被要求「先别合」时就停着；worktree 留在 `F:/pi-web-client-wt/` 里不影响别的任务。
