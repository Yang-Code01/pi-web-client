/**
 * D235: 工作台的**前端单一操作注册表**。
 *
 * 桥端只认 `id` + 结构化 params（bridge/src/gitops.ts 的 OP_BUILDERS），这里描述界面怎么问参数、
 * 怎么画图解、什么时候必须弹红色确认。两边字段必须一一对应；新增动词先在这里登记再补桥端。
 *
 * 文案一律 `tr()` 包，中文即键；图解是纯内联 SVG（离线可用，不引外部资源）。
 */
import { tr } from "./i18n/index.ts";

/**
 * 分组 id 用中文原文（不写进 localStorage），标签在使用处 tr()。
 * 写成模块级数组而不是类型联合里的字面量：i18n-check 会把这里的中文算成键，
 * 类型别名里的裸中文会被判「没走 tr()」。
 */
export const OP_GROUPS = ["本地", "分支", "远程", "整合", "暂存", "红色动作"];
export type OpGroup = (typeof OP_GROUPS)[number];
export type FieldType = "text" | "textarea" | "ref" | "number" | "files" | "branch";

export interface OpField {
  key: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  /** 是否必填；`files` 类型用 state 的勾选项，不在这里收路径。 */
  required?: boolean;
}

export interface OpSwitch {
  key: string;
  label: string;
  hint?: string;
  /** 默认真（例如 push --force-with-lease 比 --force 安全，默认打开）。 */
  defaultOn?: boolean;
}

export interface GitOpDef {
  id: string;
  group: OpGroup;
  title: string;
  glyph: string;
  sub: string;
  /** 六个色系之一，给图解卡和列表配同一套色。 */
  kind: "file" | "branch" | "join" | "sync" | "destroy" | "store";
  /** 红色动作：必须弹确认卡，写清会丢什么并给可复制回退命令。 */
  red?: boolean;
  /** 会覆盖工作区的动作：脏区且确有文件被覆盖时弹「stash / 逐文件放弃 / 取消」。 */
  covers?: boolean;
  /** 每个操作都有的图解说明（前后两帧 + 一句人话）。 */
  before: string;
  after: string;
  explain: string;
  fields: OpField[];
  switches: OpSwitch[];
  /** 只给图解/失败卡看的命令预览；真正 argv 由桥端拼。 */
  sample: string;
  /** 普通动作的可撤回说法；红色动作用 rollback。 */
  risk: string;
  /** 红色动作必填：会丢什么、怎么回来。 */
  lose?: string[];
  rollback?: string;
}

/** 固定 7 类红色清单（第 7 轮共识） + 逐文件 restore；与桥端 OP_BUILDERS id 一致。 */
export const RED_OPS = new Set([
  "reset_hard", "clean_fd", "push_force", "branch_del", "stash_drop", "tag_del", "rebase", "restore",
]);

const F = {
  message: { key: "message", label: tr("提交说明"), type: "textarea" as const, placeholder: tr("一句话说明这次改了什么"), required: true },
  branch: { key: "branch", label: tr("分支"), type: "branch" as const, required: true },
  name: { key: "name", label: tr("名称"), type: "text" as const, required: true },
  from: { key: "from", label: tr("起点"), type: "ref" as const, placeholder: "HEAD" },
  at: { key: "at", label: tr("目标提交 / ref"), type: "ref" as const, placeholder: "HEAD" },
  hashes: { key: "hashes", label: tr("提交哈希"), type: "text" as const, placeholder: tr("多个用空格隔开"), required: true },
  remote: { key: "remote", label: tr("远程"), type: "text" as const, placeholder: "origin" },
  index: { key: "index", label: tr("第几条 stash"), type: "number" as const, placeholder: "0" },
};

/** 21 个工作流动词 + 冲突收口 2 个 + unstage（stage 的反向），共 24 个；每个都有图解与手册条目。 */
export const GIT_OPS: GitOpDef[] = [
  {
    id: "stage", group: "本地", title: tr("暂存改动"), glyph: "+", sub: tr("把勾中的文件放进下一次提交"), kind: "file",
    before: tr("工作区有改动"), after: tr("改动进入暂存区"), explain: tr("只暂存你勾选的文件，不碰其它改动。"),
    fields: [{ key: "paths", label: tr("逐文件勾选"), type: "files" }], switches: [], sample: "git add -- <勾中文件>",
    risk: tr("随时可以取消暂存，改动不会丢。"),
  },
  {
    id: "unstage", group: "本地", title: tr("取消暂存"), glyph: "−", sub: tr("把勾中的文件移出暂存区"), kind: "file",
    before: tr("改动在暂存区"), after: tr("改动回到工作区"), explain: tr("只取消勾选的文件，提交说明和内容都还在。"),
    fields: [{ key: "paths", label: tr("逐文件勾选"), type: "files" }], switches: [], sample: "git reset HEAD -- <勾中文件>",
    risk: tr("文件本身不变，只是不再进入下一次提交。"),
  },
  {
    id: "commit", group: "本地", title: tr("提交"), glyph: "●", sub: tr("把已暂存的改动记成一条历史"), kind: "file",
    before: tr("暂存区有一组改动"), after: tr("当前分支多一条提交"), explain: tr("提交只写进本地仓库，不会传到远程。"),
    fields: [F.message], switches: [{ key: "amend", label: tr("修正上一条提交"), hint: tr("只改最近一条、且还没推送的提交") }, { key: "noVerify", label: tr("跳过钩子") }],
    sample: "git commit -m <说明>", risk: tr("可撤回：git reset --soft HEAD~1"), rollback: "git reset --soft HEAD~1",
  },
  {
    id: "switch", group: "分支", title: tr("切换分支"), glyph: "⇄", sub: tr("换到另一条本地分支"), kind: "branch", covers: true,
    before: tr("当前在一条分支"), after: tr("HEAD 指向另一条分支"), explain: tr("会更新工作区文件；有未提交改动时先问你怎么处理。"),
    fields: [F.branch], switches: [{ key: "create", label: tr("新建并切过去"), hint: "git switch -c" }],
    sample: "git switch <分支>", risk: tr("切过去之前的分支和提交都还在。"),
  },
  {
    id: "branch_new", group: "分支", title: tr("新建分支"), glyph: "⎇", sub: tr("从某个提交或当前 HEAD 拉一条新分支"), kind: "branch",
    before: tr("只有一个起点"), after: tr("多一条指向同一起点的分支"), explain: tr("只加一个指针，不移动当前分支、不改文件。"),
    fields: [F.name, F.from], switches: [], sample: "git branch <名称> HEAD", risk: tr("可撤回：git branch -d <名称>"),
  },
  {
    id: "fetch", group: "远程", title: tr("拉取最新"), glyph: "↓", sub: tr("只更新远程跟踪 ref"), kind: "sync",
    before: tr("本地远程记录是旧的"), after: tr("远程记录更新，工作区不动"), explain: tr("最安全的一次联网：不合并、不改任何文件。"),
    fields: [F.remote], switches: [{ key: "all", label: tr("所有远程") }], sample: "git fetch --prune origin", risk: tr("不改工作区，随时可重来。"),
  },
  {
    id: "pull", group: "远程", title: tr("拉取并合并"), glyph: "⇣", sub: tr("fetch + 把远程改动合进当前分支"), kind: "sync", covers: true,
    before: tr("本地落后远程"), after: tr("远程改动合进当前分支"), explain: tr("可能冲突；冲突后只放行中止 / 继续 / 交给 agent。"),
    fields: [F.remote, F.branch], switches: [{ key: "rebase", label: tr("用 rebase 代替 merge") }, { key: "ffOnly", label: tr("只允许快进"), hint: tr("有分叉就失败，不自动合并") }],
    sample: "git pull origin", risk: tr("失败时给原始 stderr，可用 git merge --abort 中止。"),
  },
  {
    id: "push", group: "远程", title: tr("推送"), glyph: "↑", sub: tr("把本地提交传到远程"), kind: "sync",
    before: tr("本地有远程没有的提交"), after: tr("远程追上本地"), explain: tr("只推当前分支；需要账号时失败卡会给配置指引。"),
    fields: [F.remote, F.branch], switches: [{ key: "setUpstream", label: tr("记住 upstream"), hint: "-u" }],
    sample: "git push -u origin HEAD", risk: tr("推上去以后别人可能已经看到，撤回要先和协作者确认。"),
  },
  {
    id: "merge", group: "整合", title: tr("合并"), glyph: "⑂", sub: tr("把另一条分支并进当前分支"), kind: "join", covers: true,
    before: tr("两条分支各走各的"), after: tr("汇成一条带分叉的历史"), explain: tr("两边改了同一处会冲突，冲突文件会逐行列出来。"),
    fields: [F.branch], switches: [{ key: "noFF", label: tr("保留合并提交"), hint: "--no-ff" }, { key: "squash", label: tr("压成一次改动"), hint: "--squash" }],
    sample: "git merge <分支>", risk: tr("可撤回：git merge --abort（冲突时）或 git reset --hard ORIG_HEAD（合并后）"),
  },
  {
    id: "rebase", group: "整合", title: tr("变基"), glyph: "↺", sub: tr("把当前分支的提交重放到另一条分支上"), kind: "join", red: true, covers: true,
    before: tr("提交挂在旧起点上"), after: tr("提交被重写到新起点"), explain: tr("会重写提交哈希；已推送的分支上做这件事会让别人对不上。"),
    fields: [F.branch], switches: [{ key: "interactive", label: tr("交互式"), hint: tr("需要终端，网页里通常不用") }],
    sample: "git rebase <分支>", risk: tr("红色动作：哈希会变，必须确认。"),
    lose: [tr("当前分支已有的提交哈希"), tr("别人基于旧哈希的工作")], rollback: "git rebase --abort  # 或 git reset --hard ORIG_HEAD",
  },
  {
    id: "cherry_pick", group: "整合", title: tr("摘提交"), glyph: "❖", sub: tr("把指定提交复制到当前分支"), kind: "join", covers: true,
    before: tr("好提交在另一条分支"), after: tr("当前分支多一份同样的改动"), explain: tr("复制而不是搬动，原分支不受影响；可以一次填多个哈希。"),
    fields: [F.hashes], switches: [], sample: "git cherry-pick <哈希>", risk: tr("冲突时用 git cherry-pick --abort 中止。"),
  },
  {
    id: "revert", group: "整合", title: tr("回滚提交"), glyph: "↶", sub: tr("新增一条「反着改」的提交"), kind: "join", covers: true,
    before: tr("历史里有一条不想要的提交"), after: tr("多一条抵消它的提交"), explain: tr("不改写历史，适合已经推送过的提交。"),
    fields: [F.hashes], switches: [], sample: "git revert --no-edit <哈希>", risk: tr("可撤回：再 revert 这条回滚提交。"),
  },
  {
    id: "tag", group: "整合", title: tr("打标签"), glyph: "⌖", sub: tr("给某个提交起个固定名字"), kind: "store",
    before: tr("提交只有一个哈希"), after: tr("多一个指向它的标签"), explain: tr("标签不会随分支移动，常用来标版本。"),
    fields: [F.name, F.at], switches: [{ key: "annotate", label: tr("带说明的标签"), hint: "-a -m" }],
    sample: "git tag <名称> HEAD", risk: tr("可撤回：git tag -d <名称>（本地）"),
  },
  {
    id: "stash", group: "暂存", title: tr("暂存现场"), glyph: "▤", sub: tr("把未提交的改动收进抽屉"), kind: "store",
    before: tr("工作区有一堆改动"), after: tr("工作区干净，改动存进 stash"), explain: tr("适合切换分支前；可以勾是否连未跟踪文件一起收。"),
    fields: [F.message], switches: [{ key: "includeUntracked", label: tr("包含未跟踪文件"), hint: "-u" }],
    sample: "git stash push -m <说明>", risk: tr("可撤回：git stash pop"),
  },
  {
    id: "stash_pop", group: "暂存", title: tr("取回现场"), glyph: "▥", sub: tr("把最近一次 stash 放回工作区"), kind: "store", covers: true,
    before: tr("改动躺在 stash 里"), after: tr("改动回到工作区"), explain: tr("放回时可能和现在的改动冲突，会给你冲突文件清单。"),
    fields: [F.index], switches: [], sample: "git stash pop", risk: tr("冲突时 stash 不会自己删，用 git stash list 看。"),
  },
  {
    id: "reset_hard", group: "红色动作", title: tr("硬重置"), glyph: "↯", sub: tr("把 HEAD 和工作区一起拨回某个提交"), kind: "destroy", red: true, covers: true,
    before: tr("工作区有未提交的改动"), after: tr("工作区被目标提交覆盖"), explain: tr("这是最危险的一条：没提交过的改动会直接消失。"),
    fields: [F.at], switches: [], sample: "git reset --hard <目标>", risk: tr("红色动作：必须确认，给可复制回退命令。"),
    lose: [tr("所有未提交的改动"), tr("所有已暂存但没提交的改动"), tr("当前分支顶端之后的提交引用")],
    rollback: "git reset --hard ORIG_HEAD",
  },
  {
    id: "clean_fd", group: "红色动作", title: tr("清理未跟踪文件"), glyph: "⌫", sub: tr("删掉没被 git 跟踪的文件和目录"), kind: "destroy", red: true,
    before: tr("目录里有新文件"), after: tr("这些文件被删除"), explain: tr("只删未跟踪的；不在 stash、不在任何提交里的文件找不回来。"),
    fields: [], switches: [], sample: "git clean -fd", risk: tr("红色动作：必须确认。"),
    lose: [tr("所有未跟踪的新文件与新目录"), tr("刚生成但还没提交的资源")], rollback: tr("没有通用回退命令，删前请自己备份"),
  },
  {
    id: "push_force", group: "红色动作", title: tr("强制推送"), glyph: "⇈", sub: tr("用本地历史覆盖远程分支"), kind: "destroy", red: true,
    before: tr("远程还有别人看得到的提交"), after: tr("远程被本地历史覆盖"), explain: tr("默认 --force-with-lease：远程被人更新过就拒绝，比裸 --force 安全。"),
    fields: [F.remote, F.branch], switches: [{ key: "lease", label: tr("带保护（--force-with-lease）"), defaultOn: true, hint: tr("关掉就是裸 --force") }],
    sample: "git push --force-with-lease origin HEAD", risk: tr("红色动作：必须确认。"),
    lose: [tr("远程分支上你本地没有的提交"), tr("协作者基于那些提交的工作")], rollback: "git push --force-with-lease origin <旧哈希:分支>",
  },
  {
    id: "branch_del", group: "红色动作", title: tr("删除分支"), glyph: "✕", sub: tr("删掉一条本地分支指针"), kind: "destroy", red: true,
    before: tr("有一条不再用的分支"), after: tr("分支指针消失"), explain: tr("默认只删已合并的；强删会丢掉没合并的提交引用。"),
    fields: [F.name], switches: [{ key: "force", label: tr("强删（-D）"), hint: tr("未合并也删") }],
    sample: "git branch -d <名称>", risk: tr("红色动作：必须确认。"),
    lose: [tr("这条分支独有的提交引用"), tr("分支名本身")], rollback: "git branch <名称> <旧哈希>",
  },
  {
    id: "stash_drop", group: "红色动作", title: tr("丢弃暂存"), glyph: "✕", sub: tr("删掉一条 stash"), kind: "destroy", red: true,
    before: tr("stash 抽屉里有一条记录"), after: tr("这条记录被删除"), explain: tr("删掉后那些改动不再能从 stash 取回。"),
    fields: [F.index], switches: [], sample: "git stash drop stash@{0}", risk: tr("红色动作：必须确认。"),
    lose: [tr("这条 stash 里的全部改动")], rollback: tr("没有通用回退命令，删前先 git stash list 核对"),
  },
  {
    id: "tag_del", group: "红色动作", title: tr("删除标签"), glyph: "✕", sub: tr("删掉一个本地标签"), kind: "destroy", red: true,
    before: tr("有一个本地标签"), after: tr("标签消失"), explain: tr("只删本地标签；远程标签要另行处理。"),
    fields: [F.name], switches: [], sample: "git tag -d <名称>", risk: tr("红色动作：必须确认。"),
    lose: [tr("这个标签名与它指向的便捷入口")], rollback: "git tag <名称> <旧哈希>",
  },
  {
    id: "restore", group: "红色动作", title: tr("放弃文件改动"), glyph: "↺", sub: tr("逐文件把改动丢回最近一次提交"), kind: "destroy", red: true,
    before: tr("勾中的文件有未提交改动"), after: tr("这些文件回到 HEAD 的样子"), explain: tr("只丢勾中的文件；勾选清单本身就是确认。"),
    fields: [{ key: "paths", label: tr("逐文件勾选（只丢这些）"), type: "files" }], switches: [],
    sample: "git restore -- <勾中文件>", risk: tr("红色动作：必须确认。"),
    lose: [tr("勾中文件里所有未提交的改动")], rollback: tr("没有通用回退命令；已提交的部分不受影响"),
  },
  {
    id: "abort", group: "整合", title: tr("中止冲突操作"), glyph: "■", sub: tr("把进行中的 merge/rebase 收回去"), kind: "destroy",
    before: tr("仓库停在冲突状态"), after: tr("回到操作开始之前"), explain: tr("冲突没把握时最安全的出口。"),
    fields: [], switches: [], sample: "git merge --abort", risk: tr("不会丢操作之前已提交的东西。"),
  },
  {
    id: "continue", group: "整合", title: tr("继续冲突操作"), glyph: "▶", sub: tr("所有冲突文件标记已解决后才允许"), kind: "join",
    before: tr("冲突文件逐个勾完"), after: tr("merge/rebase 继续往下走"), explain: tr("还有未勾的文件时按钮一直禁用，并显示还差几个。"),
    fields: [], switches: [], sample: "git rebase --continue", risk: tr("继续前请确认每个冲突文件都真的处理好了。"),
  },
];

export const OPS_BY_ID: Record<string, GitOpDef> = Object.fromEntries(GIT_OPS.map((op) => [op.id, op]));

/** 手册筛选器：全部 / 红色 / 六个分组。 */
export const MANUAL_FILTERS = [tr("全部"), tr("只看红色"), ...OP_GROUPS.map((g) => tr(g))];

/** 把状态 + 参数打包成一次给 agent 的咨询提示词；只交给输入框，不自动发送。 */
// i18n-ignore-start 给 agent 的提示词，不是界面文案：跟 D206 一样保持中文，不随界面语言变
export function buildHandoffPrompt(input: {
  repo: string;
  branch: string;
  selected?: string;
  ahead?: number;
  behind?: number;
  dirty?: number;
  refs?: string[];
  requirement?: string;
  failure?: { argv: string[]; exitCode: number; stderr: string; code?: string };
}): string {
  const lines = [
    "请帮我判断下一步 git 操作，先别直接执行。",
    "",
    `仓库：${input.repo}`,
    `当前分支：${input.branch}`,
    ...(input.selected ? [`选中的分支：${input.selected}`] : []),
    ...(input.ahead !== undefined || input.behind !== undefined
      ? [`领先 / 落后：↑${input.ahead ?? 0} ↓${input.behind ?? 0}`] : []),
    ...(input.dirty !== undefined ? [`未提交改动：${input.dirty} 个文件`] : []),
    ...(input.refs?.length ? [`可用分支：${input.refs.join(", ")}`] : []),
    ...(input.failure ? [
      "", "刚才这条命令失败了：",
      `$ ${input.failure.argv.join(" ")}`,
      `exit ${input.failure.exitCode}${input.failure.code ? ` · ${input.failure.code}` : ""}`,
      input.failure.stderr,
    ] : []),
    ...(input.requirement ? ["", `我的要求：${input.requirement}`] : []),
    "",
    "请按风险从低到高给我两三步做法，写清每步会动哪些文件、能不能撤回，以及冲突/鉴权失败时怎么办。",
  ];
  return lines.join("\n");
}
// i18n-ignore-end

/** 两帧图解：每个动词都画「操作前 → 操作后」，纯 SVG 字符串，离线可用。 */
export function opFrames(op: GitOpDef): [string, string] {
  const dot = (x: number, y: number, cls: string, label = ""): string =>
    `<circle class="${cls}" cx="${x}" cy="${y}" r="9"/>` + (label ? `<text class="lbl" x="${x}" y="${y + 3.5}">${label}</text>` : "");
  const line = (x1: number, y1: number, x2: number, y2: number, cls = "e"): string =>
    `<line class="${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  const base = (kind: GitOpDef["kind"], after: boolean): string => {
    // 下面全部用字符串拼接：模板串里只要出现 `${tr("中文")}`，i18n-check 会把整段模板
    // 当「没走 tr() 的中文」报出来（它看的是模板节点的原文），拼接就没有这个歧义。
    if (kind === "file" || kind === "store") {
      const fill = after ? "accent" : "";
      const capLeft = tr("工作区");
      const capRight = kind === "file" ? tr("暂存区") : "stash";
      return '<rect class="box ' + fill + '" x="18" y="18" width="46" height="30" rx="5"/>' +
        '<rect class="box ' + fill + '" x="74" y="18" width="46" height="30" rx="5"/>' +
        (after ? line(64, 33, 74, 33, "e new") : "") +
        '<text class="cap" x="20" y="62">' + capLeft + '</text>' +
        '<text class="cap" x="82" y="62">' + capRight + '</text>';
    }
    if (kind === "destroy") {
      const cap = after ? tr("丢弃") : tr("还在");
      return dot(28, 33, after ? "gone" : "n", "1") + dot(62, 33, after ? "gone" : "n", "2") +
        dot(96, 33, "n", "3") + '<text class="cap" x="20" y="62">' + cap + '</text>';
    }
    // branch / join / sync 共用的三点图
    const a = dot(24, 22, "n", "A");
    const b = dot(70, 22, "n", "B");
    const c = dot(108, 22, "n", "C");
    const fork = '<path class="e curve" d="M 70 31 Q 70 54 46 54"/><path class="e curve" d="M 70 31 Q 70 54 96 54"/>' +
      dot(46, 54, after ? "n new" : "n") + dot(96, 54, after ? "n new" : "n");
    const cap = after ? tr("操作后") : tr("操作前");
    return a + line(33, 22, 61, 22) + b + line(79, 22, 99, 22) + c + (after ? fork : "") +
      '<text class="cap" x="20" y="72">' + cap + '</text>';
  };
  // 样式全挂在 .go-ill 下：SVG 里的 <style> 是**整篇文档**生效，而下面的类名只有一两个字母
  // （.n / .e / .box / .cap），不加作用域迟早撞到页面上的同名类。
  const style = '<style>.go-ill .n{fill:var(--accent)}.go-ill .n.new{fill:var(--ok)}.go-ill .gone{opacity:.25;fill:var(--danger)}.go-ill .e{stroke:var(--line-strong);stroke-width:2}.go-ill .e.new,.go-ill .curve{stroke:var(--accent);stroke-width:2;fill:none}.go-ill .box{fill:none;stroke:var(--line-strong);stroke-width:2}.go-ill .box.accent{stroke:var(--accent);fill:var(--accent-bg)}.go-ill .lbl{fill:var(--panel);font:700 9px var(--mono);text-anchor:middle}.go-ill .cap{fill:var(--faint);font:10px var(--sans)}</style>';
  // xmlns 不能省：`branchsheet.ts` 的 svgNode() 用 DOMParser 以 image/svg+xml 解析这段字符串，
  // XML 解析不会替 `<svg>` 补默认命名空间；少了它整棵树落在**无命名空间**里，`<style>` 的
  // 文字就被当正文画进卡片（满屏 `.n{fill:var(--accent)}`），圆、线也都不渲染。
  const wrap = (inner: string): string =>
    '<svg class="go-ill" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 80" role="img" aria-label="' + tr("操作图解") + '">' + style + inner + '</svg>';
  return [wrap(base(op.kind, false)), wrap(base(op.kind, true))];
}
