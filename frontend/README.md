# AEH 教师工作台（本地）

自适应认知孪生教育 Harness（AEH）的本地教师工具：Vite + React + TypeScript 单页应用，
**直接运行 `dsh-plugin/src` 的真实 TypeScript 核心**，数据只保存在当前浏览器的
`localStorage`（键 `aeh.frontend.v1`）。

- 无后端、无数据库、无模型会话；运行期零网络。
- 学生只用本地代号 + 年级，不收集真实姓名、账号、照片。
- 掌握度写入只接受 `observed_*` 观察；`simulated_*` 永不写真实掌握度。
- 预置合成 fixture 只作可删除的示例，全部带“合成数据示例”标注。
- 设计语言以 [`DESIGN.md`](DESIGN.md) 为准（暖色极简、柔和表面）；规范见仓库根目录 `spec/`（只读）。

## 能做什么

| 路由 | 视图 | 能力 |
|---|---|---|
| `/` | 首页 | 学生/KC/题目/今日到期复习实时计数；数据导出/导入/恢复示例/清空 |
| `/student` | 学生 | 学生增删改；observed 进度；到期复习与真实 FSRS 重算；诊断 probe；课程门禁；假设面板 |
| `/teacher` | 教师 | 图谱增删（成环拒绝）；题库增删改；干预包准备（仅准备、不交付）；教学策略依据 |
| `/report` | 报告 | 仅聚合报告：人数、年级分布、各 KC 计数；模拟/真实分开；导出 JSON |
| `/metrics` | 指标 | 覆盖率、到期/逾期、FSRS 回忆率、14 天日均负担；本地同意账本与隐私说明 |

核心调用包括 `curriculum-gate.ts`、`curriculum-graph.ts`、`memory.ts`、`diagnosis.ts`、
`exercise.ts`、`hypothesis.ts`、`twin.ts`、`teaching-strategy.ts` 和 `report.ts`。
前端唯一桥接是 `src/lib/core.ts`，不重写算法；接入细节见 [`BUILD.md`](BUILD.md) §9。

## 环境与命令

- Node.js ≥ 18 可用于开发/构建；`npm run check` 依赖 Node 24 的 TypeScript 类型剥离
  （验证环境 Node `v24.22.1`、npm `10.9.4`）。

```bash
cd frontend
npm install

npm run dev        # 开发服务（http://localhost:5173）
npm run typecheck  # 严格 TypeScript 检查
npm run build      # tsc --noEmit && vite build
npm run preview    # 预览生产构建（http://localhost:4173）
npm run check      # 四项核心行为断言（Node 24 直接跑 TS）
npm run smoke:ssr  # 5 路由 SSR 冒烟（无浏览器环境的补充证据）
```

依赖精确锁定，无新增运行时依赖。构建与验证记录见 [`BUILD.md`](BUILD.md)；
逐项规范对照、真实可用范围与剩余边界见 [`SPEC-CHECK.md`](SPEC-CHECK.md)。

## 目录结构

```text
frontend/
├── BUILD.md                 # 真实构建/验证日志
├── SPEC-CHECK.md            # 规范对照与边界
├── DESIGN.md                # 既有设计语言（只读参考）
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts           # @aeh alias、node:crypto 垫片、SPA
├── scripts/
│   ├── check-core-behaviors.mjs
│   ├── ssr-smoke.mjs
│   └── ts-resolve-hooks.mjs
└── src/
    ├── main.tsx             # 挂载 + Step 0 核心冒烟
    ├── App.tsx              # 5 条路由 + 404
    ├── components/          # Layout / UI 组件
    ├── data/synthetic.ts    # 预置合成 fixture（仅示例）
    ├── lib/
    │   ├── core.ts          # 真实核心唯一桥接
    │   ├── model.ts         # store 类型、localStorage 键、observed 校验
    │   ├── store.ts         # 本地 store + 增删改 + 导入校验
    │   ├── behavior.ts      # store → 核心输入的适配层
    │   ├── metrics.ts       # 实时指标
    │   ├── reporting.ts     # report.ts 聚合边界
    │   ├── preset.ts        # 合成示例 → store
    │   ├── shims/sha256.ts  # node:crypto 的浏览器垫片
    │   └── format.ts / download.ts
    ├── store/useStore.ts    # useSyncExternalStore
    ├── styles/              # tokens.css / app.css
    ├── types/               # 两个插件的类型投影
    └── views/               # Home / Student / Teacher / Report / Metrics
```

## 数据与隐私边界

- 存储：`localStorage['aeh.frontend.v1']`，`version: 1`。清除站点数据会一起清除本工具数据；
  重要数据请先在首页导出 JSON。
- 导入：先做完整校验（版本、字段、引用、重复、图谱合法性）；失败时报错且**不覆盖**原数据。
- 同意：新增学生默认记录“本地聚合报告同意”，可随时撤销；撤销或缺失同意的学生在指标与
  聚合报告中 fail-closed 排除，并显示原因。删除学生才会真正删除其本地数据。
- 报告只含本地代号与聚合计数，不含题目原文、答案、步骤、原始作答或事件 ID。
- 合成示例可删除、恢复或一键清空；它不是真实学生，也不得作为教学效果证据。

## 明确不在范围

- 模型会话/聊天：不在前端；仍只由 dsh 插件侧承载。
- L4 真实迁移/因果效果：没有前测—干预—后测或对照设计，界面明确“未提供”。
- 完整课程本体、RAG、多遗忘模型选型、真实参数拟合、后端/数据库/认证/云同步：未实现。
- 干预包只有“已准备”，没有 `deliver()`、交付凭证或审批工作流。
- 无头浏览器 DOM 交互测试：环境没有可用浏览器；SSR 冒烟与 HTTP 200 不等于真实点击测试。

## 只读边界

- `dsh-plugin/`、`spec/`、`references/`、`aeh/`、`docs/` 只读；前端不修改插件来解决前端问题。
- 未读写 `~/.dsh/`；未修改 deepseek-harness clone 或 npx dsh；未把 AEH 插件加载进当前 harness。
- 不推送、不发邮件、不执行 git 操作。
