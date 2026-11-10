---
name: whatsnew-write
description: 给 pi-web-client 补一批「本项目更新日志」：从 CHANGELOG.md 的锚点读到 origin/main，把新合进来的提交写成一批人话条目，开 worktree、提交、开 PR，等用户合并。只由 /whatsnew-write 命令呼出。
disable-model-invocation: true
---

# 补一批本项目更新日志

`CHANGELOG.md`（仓库根）是给人看的：网页客户端上能感知到的变化 + 会影响日常使用的设计取舍。它不是 `git log` 的搬运工，一句 commit 标题也进不来。

**本技能只做一件事：把锚点之后新合进 main 的提交，写成一批新条目，走 worktree → 提交 → PR。** 不写代码、不 build、不动 main、不合并。

## 不做的事（越界就停）

- 不在主检出里改文件、不 `git add` 到 main（硬规则）。
- 不顺手改 `README.md`、`docs/DECISIONS.md`、源码 —— 日志批次是独立的一批 diff，PR 里只该有 `CHANGELOG.md`。
- 不合并自己的 PR，也不删 worktree（用户说了合并才收尾）。
- 没有新东西（锚点已等于 `origin/main`）时：**什么都不做**，回报「已经是最新的」。

## 一、定位主检出

命令可能从主检出、也可能从某个 worktree 被呼出。`--git-common-dir` 在两个地方都指向主检出的 `.git`：

```bash
ROOT=$(git rev-parse --path-format=absolute --git-common-dir | xargs dirname)
echo "$ROOT"   # 例：F:/pi-web-client
```

后面所有 git 命令都带 `-C "$ROOT"`，不要 `cd` 进主检出再操作（主检出里可能有人未提交的活）。

## 二、读锚点，算新提交

```bash
git -C "$ROOT" fetch origin main
ANCHOR=$(git -C "$ROOT" show origin/main:CHANGELOG.md | grep -m1 -oE '写到 [0-9a-f]{7,40}' | awk '{print $2}')
NEW=$(git -C "$ROOT" rev-parse --short origin/main)
git -C "$ROOT" log --first-parent --date=short --format='%h %ad %s' "$ANCHOR..origin/main"
```

- `ANCHOR` 为空 → `CHANGELOG.md` 的锚点注释被谁删了。停下来问用户，别自己挑一个 SHA 猜。
- 提交列表为空 → 报告「`$ANCHOR` 之后没有新提交」，结束。
- 锚点天生读的是 `origin/main` 上的那一份，所以别人刚补过也不会重写。

## 三、收集素材

一次抓齐，别边写边翻：

```bash
git -C "$ROOT" log --first-parent --date=short --format='%h %ad %s' "$ANCHOR..origin/main"   # 提交
git -C "$ROOT" diff "$ANCHOR"..origin/main -- docs/DECISIONS.md | grep -E '^\+## D[0-9]+'   # 新决定
git -C "$ROOT" log --first-parent --format='%s' "$ANCHOR..origin/main" | grep -oE '#[0-9]+' | sort -u  # PR 号
```

PR 号来自合并标题 `Merge pull request #N` 或 squash 标题结尾 `(#N)`。标题看不出做了什么（比如只有 `fix: 修一下`）时，再 `gh pr view N --repo Yang-Code01/pi-web-client --json title,body` 补上下文；**不要**为了凑措辞去读 diff（一批几十个 PR，读不起）。

## 四、写成条目

严格按 `references/writing-rules.md`（读者是用户不是开发者、三组怎么分、什么不写、字数与锚点规则、好/坏例子）。写完逐条自问：**这句话用户读完知道他多了什么、或者什么毛病没了？** 答不上来就删。

## 五、开 worktree（在它自己的分支上改）

```bash
STAMP=$(date +%Y%m%d-%H%M)
WT="F:/pi-web-client-wt/changelog-$STAMP"
git -C "$ROOT" worktree add "$WT" -b "docs/changelog-$STAMP"
```

- 分支名重复（`fatal: '…' is already used by worktree`）→ 换个 `STAMP`，不要复用别人的 worktree。
- 主检出脏不影响 `worktree add`；**不要**为了腾地方 stash 或 checkout。

## 六、改 `$WT/CHANGELOG.md`

只动这一个文件，两处：

1. **新批次**插在 `# pi-web-client 更新日志` 的说明段之下、上一批的 `## 日期 · 主题` 之上。标题格式 `## YYYY-MM-DD · <这批的主题>`，日期用今天（一批跨好几天时，用最后合并那天，并在正文里点明范围）。
2. **锚点注释**改成新值（`git -C "$ROOT" rev-parse --short origin/main` 的结果）：

```markdown
<!-- 写到 1a2b3c4 · 2026-11-09 -->
<!-- 下一批从这里往后读：git log --first-parent 1a2b3c4..HEAD；只读已合进 main 的（-m），没合的不写。 -->
```

自查（不跑构建，日志是纯 Markdown）：

```bash
git -C "$WT" status --short          # 只该有 M CHANGELOG.md
git -C "$WT" diff --stat             # 加的行数 ≫ 删的行数
grep -c '^## ' "$WT/CHANGELOG.md"    # 比 origin/main:CHANGELOG.md 多 1
git -C "$ROOT" show origin/main:CHANGELOG.md | grep -c '^## '
```

## 七、提交、推送、开 PR

```bash
git -C "$WT" add CHANGELOG.md
git -C "$WT" commit -m "docs(changelog): <日期> 批次，<N> 条"
```

推送按仓库账号规矩（细节与故障处置见 `references/commands.md`）：先直连试一次，失败再套代理（`${BILLION_CONTEXT_PROXY:-http://127.0.0.1:18791}`，变量没导出时用这个字面端口）；push 用 `Yang-Code01` 的 token，`gh` 逐条带 `GH_TOKEN`。PR 用仓库风格的四段：**做了什么 / 依据 / 自查 / 没做**，标题写清是「更新日志：<日期> 批次（N 条）」。

## 八、交给人

回报三行以内：PR 链接、新增 N 条（哪几组）、锚点 `旧 → 新`。然后**停**。用户说合并才合并，合并之后才：

```bash
node "$ROOT/tools/worktree-remove.mjs" "$WT" && git -C "$ROOT" branch -d "docs/changelog-$STAMP"
```
