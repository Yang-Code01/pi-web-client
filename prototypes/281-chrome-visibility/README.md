# 原型 · 按钮可见性（#281）

一次性产物，**不要合进 main**。分支 `proto/281-chrome-visibility` 只做存档：三张样张是 main 上那次评审的原始材料，选中的是 **B「实时预览」**（理由写在 #281 的 Implementation Decisions）。

- `index.html` —— 目录页，三张卡片
- `sheet.html?variant=A|B|C` —— 真外壳 + 真「外观与语言」sheet，底部胶囊换版（← → 也行）
- `proto.css` / `proto.js` —— 三套画法；`proto.js` 里那份 `state.chrome` 就是 spec 里的三态模型

## 跑起来

直接双击 `index.html`。唯一缺的资源是 `app.css`（真页面的样式快照，200KB，没进仓库）：

```bash
cd web && npm run build
cp web/dist/assets/main-*.css prototypes/281-chrome-visibility/app.css
```

没有 `app.css` 也打得开，只是外壳没有样式 —— 判断「开关长什么样」够用了。

## 别当产品代码看

没有 i18n、没有 WS、没有指针拖拽、状态只在内存里；为了评审方便还加了一行 `chrome = {…}` 状态读数，那行**不进产品**。真实现按 #281 的 spec 重写。
