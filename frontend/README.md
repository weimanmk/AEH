# AEH 演示前端（第一阶段）

自适应认知孪生教育 Harness（AEH）的**本地演示前端**：Vite + React + TypeScript 单页应用，
包含首页与 4 个视图。**不连接后端、不调用真实接口、不使用真实学生数据**；
所有内容来自 [`src/data/synthetic.ts`](src/data/synthetic.ts) 的合成 fixture，状态只存在于浏览器内存。

> 本目录只写前端代码；设计语言以 [`DESIGN.md`](DESIGN.md)（Notion 风格：暖色极简、
> 柔和表面、简洁首页）为准，v1.1 规范见仓库根目录 `spec/`（只读参考）。

## 环境要求

- Node.js ≥ 18（本仓库验证环境：Node `v24.22.1`、npm `10.9.4`）

## 安装

```bash
cd frontend
npm install
```

依赖版本已在 `package.json` 中**精确锁定**（无 `^`/`~`），当前为：

| 包 | 版本 | 用途 |
|---|---|---|
| react / react-dom | 18.3.1 | UI 运行时 |
| react-router-dom | 6.30.6 | 客户端路由 |
| vite | 5.4.21 | 构建/本地服务 |
| @vitejs/plugin-react | 4.7.0 | React 快速刷新与 JSX |
| typescript | 5.9.3 | 类型检查 |
| @types/react / @types/react-dom | 18.3.31 / 18.3.7 | 类型定义 |

> 说明：在受限沙箱中默认 npm 缓存目录可能不可写。本次验证使用了
> `npm install --cache .npm-cache`，缓存落在 `frontend/.npm-cache/`（已加入
> `.gitignore`）。在普通开发机上直接 `npm install` 即可。

## 常用命令

```bash
npm run dev        # 本地开发服务（默认 http://localhost:5173）
npm run typecheck  # 只做 TypeScript 类型检查
npm run build      # tsc --noEmit && vite build，产物在 dist/
npm run preview    # 预览生产构建（默认 http://localhost:4173）
```

构建与预览验证记录见 [`BUILD.md`](BUILD.md)。

## 路由

| 路径 | 视图 | 说明 |
|---|---|---|
| `/` | 首页 | 产品一句话、三个角色入口、合成数据声明 |
| `/student` | 学生答题 | 3 道分数合成题，答完即时给“观测到的对错” |
| `/teacher` | 教师孪生 / 诊断 | 合成学生的知识状态、假设列表、诊断追溯链 |
| `/report` | 报告 | 教师/家长聚合报告（仅聚合事件，无原始学生数据） |
| `/metrics` | 指标仪表盘 | 留存、诊断覆盖、模拟/真实分离的评估说明 |

## 目录结构

```text
frontend/
├── DESIGN.md                 # 既有设计语言（只读参考，未修改）
├── README.md                 # 本文件
├── BUILD.md                  # 构建日志与验证结果
├── index.html
├── package.json              # 依赖精确锁定 + 脚本
├── tsconfig.json
├── vite.config.ts            # appType: 'spa'，preview 端口 4173
└── src/
    ├── main.tsx              # 挂载 + BrowserRouter
    ├── App.tsx               # 5 条路由（首页 + 4 视图 + 404）
    ├── components/
    │   ├── Layout.tsx        # 顶部导航 + 页脚 + 合成数据声明
    │   └── ui.tsx            # Card / Badge / Tag / Stat / Meter / Notice 等
    ├── data/
    │   └── synthetic.ts      # 唯一数据源（合成 fixture）
    ├── lib/
    │   └── fractions.ts      # 分数解析、判等、百分比格式化
    ├── styles/
    │   ├── tokens.css        # 来自 DESIGN.md 的 CSS 变量（颜色/字体/圆角/间距/阴影）
    │   └── app.css           # 布局与组件样式、响应式
    └── views/
        ├── HomeView.tsx
        ├── StudentView.tsx
        ├── TeacherView.tsx
        ├── ReportView.tsx
        └── MetricsView.tsx
```

## 合成数据与规范对应

`src/data/synthetic.ts` 的结构对齐 v1.1 规范中的示例字段，知识点沿用仓库既有
合成命名（`kc.fraction.*`）：

- 知识状态（§5.1/§5.2）：`mastery_posterior`、`retrieve_probability`、
  `transfer_estimate`，不压缩为单一“掌握率”。
- 短期认知假设（§6.1）：`knowledge_assumptions`、`strategy_policy`、`bug_rules`、
  `predicted_observable_behaviors`、`posterior_weight`、`status`，并显式保留 unknown 权重。
- 主动诊断（§7.1）：`Observe → Localize → Expand → Simulate → ChooseProbe → Update`。
- 记忆留存（§8.3）：`R(t, S) = (1 + (19/81)·(t/S))^(-1/2)` 示意式。
- 聚合报告（§13.3）：`authorized_aggregate_events_only`、`raw_student_data_included=false`、
  无事件 ID；教师/家长范围收窄。
- 评测分离（§19）：L3 模拟收益与 L4 真实迁移分节，无真实观测时写“未提供”，
  不用模拟数据替代。

## 设计实现说明

- 通过 `src/styles/tokens.css` 落地 `DESIGN.md` 的颜色、圆角、间距、阴影令牌；
  组件使用 8px 圆角按钮与 12px 圆角卡片。
- 字体：`Notion Sans → Inter → 系统字体`。由于本机通常没有 Notion Sans/Inter，
  **标题栈保留衬线回退**（任务允许），正文栈回退到系统中文字体
  （`PingFang SC` / `Microsoft YaHei`）。
- 响应式断点：1024px / 767px / 480px，网格与表格自动降列。

## 边界与合规

- 只用合成数据；不编造真实学生数据，也不声称接入了真实系统。
- 不修改 `~/.dsh/`、`~/workspace/deepseek-harness`、npx 安装的 dsh、
  `references/` 与 `spec/`；本阶段只写 `frontend/`。
- 不把 AEH 插件加载进正在执行本任务的 harness 会话。
- 本阶段**不推送、不发邮件**。
