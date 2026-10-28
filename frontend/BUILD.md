# 构建与验证记录（BUILD.md）

本文件记录 AEH 前端的**真实**构建日志与验证结果：
第一阶段（脚手架 + 5 视图，§1–§6）、第二阶段（v1.1 规范自查补齐后的重建，§7–§8），
以及第三阶段（真实 TypeScript 核心接入、本地 store 与验证，§9）。

- 第一阶段环境：容器内 `/home/hatch/workspace/AEH/frontend`，时间 `2026-10-27 15:41 UTC`。
- 第二阶段环境：同一目录，时间 `2026-10-27 15:54 UTC`。

- Node.js：`v24.22.1`
- npm：`10.9.4`
- 结论：**`npm run build` 通过**；`vite preview` 下首页与 4 个路由均返回 HTTP 200。

---

## 1. 依赖安装

依赖使用 `--save-exact` 精确写入 `package.json`（无 `^`/`~` 范围）。
受限沙箱中默认 npm 缓存目录 `/home/hatch/.npm` 为 root 所有、不可写，因此改用
`--cache .npm-cache`，缓存只落在 `frontend/.npm-cache/`（已 `.gitignore`）。

```text
$ npm install --save-exact --cache .npm-cache react@18 react-dom@18 react-router-dom@6
added 8 packages in 7s

$ npm install --save-exact --save-dev --cache .npm-cache \
    vite@5 @vitejs/plugin-react@4 typescript@5.9 @types/react@18 @types/react-dom@18
added 63 packages in 29s
```

锁定结果（`package.json`）：

```json
"dependencies": {
  "react": "18.3.1",
  "react-dom": "18.3.1",
  "react-router-dom": "6.30.6"
},
"devDependencies": {
  "@types/react": "18.3.31",
  "@types/react-dom": "18.3.7",
  "@vitejs/plugin-react": "4.7.0",
  "typescript": "5.9.3",
  "vite": "5.4.21"
}
```

---

## 2. 构建（`npm run build`）

命令：`npm run build`（即 `tsc --noEmit && vite build`）。

完整输出：

```text
> aeh-frontend-demo@0.1.0 build
> tsc --noEmit && vite build

vite v5.4.21 building for production...
transforming...
✓ 44 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                   0.51 kB │ gzip:  0.44 kB
dist/assets/index-DKrtf8Sg.css   15.82 kB │ gzip:  3.71 kB
dist/assets/index-BlAU5Ayl.js   214.35 kB │ gzip: 71.55 kB
✓ built in 1.89s
```

TypeScript 类型检查（`tsc --noEmit`）无错误、无警告；Vite 构建成功。

构建产物：

```text
dist/
├── index.html                    598 bytes
└── assets/
    ├── index-BlAU5Ayl.js        222921 bytes
    └── index-DKrtf8Sg.css        15816 bytes
```

---

## 3. 预览与路由验证（`vite preview` + `curl`）

启动：

```text
$ npm run preview -- --host 127.0.0.1

> aeh-frontend-demo@0.1.0 preview
> vite preview --host 127.0.0.1

  ➜  Local:   http://127.0.0.1:4173/
```

对首页与四个路由逐一 `curl`：

```text
$ for p in / /student /teacher /report /metrics; do
    curl -s -o /dev/null -w "$p HTTP %{http_code} %{content_type} %{size_download} bytes\n" \
      "http://127.0.0.1:4173$p"
  done
/ HTTP 200 text/html 598 bytes
/student HTTP 200 text/html 598 bytes
/teacher HTTP 200 text/html 598 bytes
/report HTTP 200 text/html 598 bytes
/metrics HTTP 200 text/html 598 bytes
```

静态资源同样可达：

```text
/assets/index-BlAU5Ayl.js   -> HTTP 200
/assets/index-DKrtf8Sg.css  -> HTTP 200
```

### 3.1 路由注册证据（避免只依赖 SPA 回退）

Vite 以 `appType: 'spa'` 提供 history fallback，因此**任意**路径都会回退到
`index.html` 并返回 200（包括不存在的 `/does-not-exist`）。为确认四个路由确实
注册在应用内，另外检查了构建产物：

```text
构建 JS 中的路由字符串：
"/student" : 1
"/teacher" : 1
"/report"  : 1
"/metrics" : 1

各视图独有文案在构建 JS 中出现次数：
按角色浏览演示              : 1   （首页）
分数合成练习                : 1   （学生答题）
主动诊断追溯链              : 1   （教师孪生/诊断）
聚合报告                    : 1   （报告）
模拟收益与真实迁移严格分离  : 1   （指标仪表盘）
```

**诚实说明**：本环境没有可用的无头浏览器，因此未做「在真实 DOM 中渲染每个路由」的
断言。上表证明的是：五条路由在 `App.tsx` 中注册、四个视图代码都被打包，
且 preview 服务对每个路由返回 200。未命中路由会由应用内 `*` 渲染 404 视图
（这是 SPA 的正常行为，不是测试通过）。

---

## 4. 合成数据不变量校验

用 Node 24 的类型剥离直接加载 `src/data/synthetic.ts` 并校验：

```text
$ node --input-type=module -e "…import('./src/data/synthetic.ts')…"

retention kc.fraction.equiv  0.9473 == 0.9473
retention kc.fraction.add    0.8923 == 0.8923
retention kc.fraction.compare 0.9192 == 0.9192
retention kc.place.value     0.9631 == 0.963
teacher  topics=4 totals={"attempts":61,"independentCorrect":41,"hintedCorrect":11,"hintsRequested":22,"reviewsDue":25,"reviewsCompleted":20,"minutes":137}
guardian topics=2 totals={"attempts":40,"independentCorrect":25,"hintedCorrect":8,"hintsRequested":17,"reviewsDue":18,"reviewsCompleted":13,"minutes":100.5}
hypothesis weights sum = 1.000
studentItems = 3 item.fraction.add.001, item.fraction.equiv.001, item.fraction.add.003
roleEntrances = student, teacher, insight
DATA_INVARIANTS_OK
```

校验项：留存示意式与记录值一致（误差 < 0.001）；报告 totals 等于各 topic 之和；
每题 `independent_correct + hinted_correct ≤ attempts`；`reviews_completed ≤ reviews_due`；
假设权重 + unknown = 1.000。

---

## 5. 设计令牌落地证据

构建后的 CSS 中可检索到 `DESIGN.md` 的令牌（抽查）：

```text
#5645d4        : 1   （colors.primary）
#0a1530        : 1   （colors.brand-navy）
--radius-lg: 12px : 1 （rounded.lg，卡片）
--font-serif   : 1
Noto Serif SC  : 1   （标题字体回退）
PingFang SC    : 1   （正文系统中文字体回退）
```

标题栈以 `Notion Sans → Inter → 衬线回退` 落地：本机未安装 Notion Sans/Inter，
因此标题实际回退到衬线字体（任务允许）；正文回退到系统中文字体。响应式断点为
1024 / 767 / 480px。

---

## 6. 边界与合规确认

- 仅写入 `frontend/`；未修改 `~/.dsh/`、`~/workspace/deepseek-harness`、npx 安装的 dsh、
  `references/`、`spec/`。`frontend/DESIGN.md` 保持原样未改动。
- 未连接后端、未调用真实接口；无网络请求代码。
- 仅使用 `src/data/synthetic.ts` 中的合成 fixture；未编造或声称真实学生数据。
- 未把 AEH 插件加载进正在执行本任务的 harness 会话。
- **未推送、未发邮件**（本阶段不做）；该工作区不是 git 仓库（无 `.git`），
  未执行任何 git 操作。
- 已知限制：无自动化单元测试与无头浏览器渲染断言；`vite preview` 的 200 不能单独
  证明路由存在（见 §3.1 的补充证据）。

---

## 7. 第二阶段：v1.1 规范自查补齐后的重建与验证（2026-10-27 15:54 UTC）

对照结果与逐项处理见 [`SPEC-CHECK.md`](SPEC-CHECK.md)：共 80 个检查点，已补 66 项，
演示范围外 14 项（含理由）。本阶段只改 `frontend/src` 与文档，未改 `DESIGN.md` 与样式文件。

### 7.1 构建（`npm run build`）

```text
> aeh-frontend-demo@0.1.0 build
> tsc --noEmit && vite build

vite v5.4.21 building for production...
✓ 44 modules transformed.
dist/index.html                   0.51 kB │ gzip:  0.44 kB
dist/assets/index-DKrtf8Sg.css   15.82 kB │ gzip:  3.71 kB
dist/assets/index-DXbQA4At.js   282.57 kB │ gzip: 96.90 kB
✓ built in 2.93s
```

TypeScript 类型检查（`tsc --noEmit`）无错误、无警告。

- CSS 体积与第一阶段完全一致（`index-DKrtf8Sg.css` 15.82 kB）：新增内容全部复用既有
  组件与 CSS 类，**未新增/修改样式，未改 `DESIGN.md` 设计语言**。
- JS 由 214.35 kB 增至 282.57 kB，来自新增的合成 fixture 与视图分节。

### 7.2 预览与路由验证（`vite preview` + `curl`）

```text
$ npm run preview -- --host 127.0.0.1
  ➜  Local:   http://127.0.0.1:4173/

/                HTTP 200 text/html 598 bytes
/student         HTTP 200 text/html 598 bytes
/teacher         HTTP 200 text/html 598 bytes
/report          HTTP 200 text/html 598 bytes
/metrics         HTTP 200 text/html 598 bytes
/does-not-exist  HTTP 200 text/html 598 bytes   （SPA fallback，由应用内 * 渲染 404）
dist/assets/index-DXbQA4At.js   -> HTTP 200
dist/assets/index-DKrtf8Sg.css  -> HTTP 200
```

诚实说明：与第一阶段相同，本环境没有可用的无头浏览器，未做「在真实 DOM 中逐路由渲染」
的断言；`vite preview` 对任意路径都回退到 `index.html`，因此 200 只证明服务可达。
为补充路由存在的证据，检查了构建产物中的路由字符串与各视图独有文案（下表）。

```text
构建 JS 中的路由字符串：
"/student" : 3   "/teacher" : 4   "/report" : 3   "/metrics" : 3

新增内容独有文案在构建 JS 中出现次数（均为 1，证明已打包）：
课程门禁状态 / fail-closed / 下次复习间隔 / 四维认知 / 假设生命周期 /
教学策略路由器 / 习题演化 / 工作流状态机 / 模拟实验室 / 隐私最小化 /
跨学科适配层 / 关键运行指标 / 可解释审计记录
```

### 7.3 合成数据不变量校验（第二阶段新增项）

用 Node 24 类型剥离加载 `src/data/synthetic.ts`，校验原有与新增不变量：

```text
ok   retention kc.fraction.equiv / add / compare / place.value   （示意式与记录值误差 < 0.001）
ok   all hypotheses + unknown = 1.000                            （0.44+0.31+0.14+0.06+0.05）
ok   teacher totals == sum(topics)；guardian totals == sum(topics)
ok   gate add.001/learn、equiv.001/learn、add.003/learn          （allow == 六条件全通过）
ok   gate add.001/preview、multiply.candidate/learn              （allow=false 且 failClosed=true）
ok   review priority（4 条）                                     （与 a..f 权重公式一致）
ok   nextIntervalDays(S, r=0.9) ≈ S（8.2 / 5.5 / 11.5 / 21 天）  （间隔反解自洽）
ok   candidate utility（cand.A/C/B/D）                           （与 λ/μ/ν/ρ 公式一致）
ok   workflow graph valid                                        （边与当前路径节点均存在）
ok   time budget sums                                            （5 项分配 = 总时长 20 分钟）
ok   structured tags for every student item                       （3/3）
ok   simulation isolation flags                                  （source_type=simulated, is_real_student_evidence=false）
ok   7 metric dimensions
DATA_INVARIANTS_OK
```

### 7.4 第二阶段边界与合规确认

- 仅写入 `frontend/`（`src/`、`SPEC-CHECK.md`、`BUILD.md`）；未修改 `~/.dsh/`、
  `~/workspace/deepseek-harness`、npx 安装的 dsh、`references/`、`spec/`。
- `frontend/DESIGN.md` 与 `frontend/src/styles/*` 未改动；构建后 CSS 哈希/体积不变。
- 未连接后端、未新增任何网络请求代码；新增内容全部为 `synthetic.ts` 中的合成 fixture
  与浏览器内存状态。
- 未把 AEH 插件加载进正在执行本任务的 harness 会话。
- **未推送、未发邮件**；未执行任何 git 操作（工作区不是 git 仓库）。
- 诚实报告：无“无法补齐”项；所有未实现能力都在 `SPEC-CHECK.md` 中明确标注为
  “演示范围外”并给出理由，未编造后端/真实数据能力。

## 8. 第三阶段：第 2 轮复核后的重建与验证（2026-10-28 09:5x CST，本地验证）

- **背景**：第 2 轮补了 `SPEC-CHECK.md` §4 后端能力交叉引用、§5 修订记录，
  并同步修正 `src/data/synthetic.ts` 两处文案（`evolutionPipeline` 的 `rank`
  文案、“时间外 Brier”改为“Brier（合成示意，非时间外）”，状态 `watch`）。
  本节记录复核后的重建与验证，方法与局限如实写明。
- **构建**：`npm run build` 通过（`tsc --noEmit` + `vite build`），44 个模块；
  `dist/assets/index-CbXtJEC7.js` 282.60 kB（gzip 96.95 kB）、
  `dist/assets/index-DKrtf8Sg.css` 15.82 kB（gzip 3.71 kB），与复核前产物一致。
- **预览与路由验证**：`vite preview` + `curl`，`/`、`/student`、`/teacher`、
  `/report`、`/metrics` 全部 HTTP 200；构建产物中含新标签
  “Brier（合成示意，非时间外）”，旧标签“时间外 Brier”为 0 处。
- **局限（诚实记录）**：仍无 headless-browser DOM 渲染断言；HTTP 200 只证明
  路由可达，不证明浏览器内渲染无错。本节数字为本地实测，不得引用为 CI 结果。
- **未推送、未发邮件**；运行用的 dsh、源码 clone 均未改动。

## 9. 第三阶段：真实核心接入、存储与验证（2026-10-28，本地实测）

本节记录前端从“合成 fixture 演示”切换为“本地 store + 真实 TypeScript 核心”后的构建与验证。
数字均为本机实测，不是 CI 结果。

### 9.1 真实核心接入方式

- **唯一桥接**：`src/lib/core.ts` 只做 re-export，不重写算法。
- **Vite alias**（`vite.config.ts`）：
  - `@aeh` → `../dsh-plugin/src`（只读引用，不复制、不修改插件源码）；
  - `node:crypto` → `src/lib/shims/sha256.ts`。
- **导入的插件模块**：`domain.ts`、`core/curriculum-gate.ts`、`core/curriculum-graph.ts`、
  `core/memory.ts`、`core/diagnosis.ts`、`core/exercise.ts`、`core/hypothesis.ts`、
  `core/twin.ts`、`core/teaching-strategy.ts`、`report.ts`。
- **刻意不导入**：`core/services.ts`（`node:fs` / `node:path` 文件存储）、`core/privacy.ts`
  （前端按 brief 使用本地同意账本）、`core/fsrs-calibration.ts` / `core/exercise-evolution.ts`
  （前端不需要）。
- **类型投影**：插件 `twin.ts` / `curriculum-graph.ts` 在插件自己的 tsconfig 下没有开
  `noUnusedLocals`，各有一个内部未使用 helper；为保持前端严格检查且不改插件，使用
  `src/types/aeh-twin.d.ts`、`src/types/aeh-curriculum-graph.d.ts` 做类型投影。
  Vite 运行时仍加载真实插件源码。
- **适配层**：`src/lib/behavior.ts` 把 store 的 observed 记录投影成核心输入；
  所有门禁、FSRS、诊断、假设、策略、干预校验都调用真实核心。
- **模型会话/服务端**：无。没有后端、数据库、模型会话或网络调用。

### 9.2 SHA-256 垫片说明

- 触发点：`core/curriculum-graph.ts` 的 `contentHash` 使用 `node:crypto` 的 `createHash('sha256')`。
- 垫片：`src/lib/shims/sha256.ts`，纯 TypeScript 同步实现；仅通过 Vite alias 供浏览器侧使用。
- 一致性：已用 Node 的 `crypto.createHash('sha256')` 对空串、`abc`、中文、1000 字符输入
  逐字节比对，输出一致。该垫片不是通用加密库，只实现本前端需要的内容摘要。
- 未引入任何 polyfill 包。

### 9.3 存储键与数据边界

- localStorage 键：**`aeh.frontend.v1`**。
- store 版本：`version: 1`；结构：`students / kcs / edges / items / progress / reviews /
  interventions / consents`（详见 `src/lib/model.ts`）。
- 学生只用本地代号 + 年级；不收集真实姓名、账号、照片。
- 掌握度写入只接受 `observed_*`；`simulated_*` 没有写入口。
- 导入 JSON 先做完整校验（版本、字段、引用、重复、图谱合法性）；失败时报错且**不覆盖**原数据。
- 导出用 Blob 下载；导入用 `<input type=file>`；运行期零网络。

### 9.4 构建与类型检查

```text
$ npm run typecheck
> tsc --noEmit
（exit 0）

$ npm run build
> tsc --noEmit && vite build
vite v5.4.21 building for production...
✓ 63 modules transformed.
dist/index.html                   0.51 kB │ gzip:   0.45 kB
dist/assets/index-6H3SBHtT.css   16.58 kB │ gzip:   3.87 kB
dist/assets/index-BqYreLUQ.js   358.60 kB │ gzip: 113.21 kB
✓ built in 2.18s
```

- `noUnusedLocals` / `noUnusedParameters` / `strict` 均保持通过。
- 产物中无 `node:` 导入：

```text
$ grep -REno "(from|import|require)[( ]*[\"']node:" dist/assets/*.js
NO_NODE_BUILTIN_IMPORTS
```

- 运行期零网络自查：

```text
$ grep -RInE '\bfetch\s*\(|\baxios\b|\bWebSocket\b' src
NO_NETWORK_APIS
$ grep -REno '\bfetch\s*\(|\baxios\b|\bWebSocket\b' dist/assets/*.js
NO_NETWORK_APIS_IN_DIST
```

> 说明：Vite 默认的 modulepreload polyfill 会在产物里注入 `fetch()`（只用于同源静态资源）。
> 为与“grep 无 fetch(”的口径一致，已在 `vite.config.ts` 关闭该 polyfill
> （`build.modulePreload.polyfill: false`）；现代浏览器原生支持 modulepreload。

### 9.5 核心行为验证脚本

```text
$ npm run check          # node scripts/check-core-behaviors.mjs
PASS 门禁拒绝未授 KC — item.fraction.multiply.candidate → kcs_not_allowed:kc.fraction.multiply
PASS 复习后 FSRS 下次时间变化 — 1.664 天 → 2.765 天
PASS 诊断产生 probe — best=item.fraction.equiv.001，候选 4，通过门禁 3
PASS 聚合报告排除撤销同意的学生 — stu_consent_case 已排除；attempts 6 → 5
ALL_CORE_BEHAVIORS_PASS
```

- 脚本用 Node 24 直接加载与 UI 相同的 TS 模块；`scripts/ts-resolve-hooks.mjs` 只做
  `@aeh/*` alias 与省略扩展名的解析，不 mock 任何核心。
- 时间戳随运行时间变化，上面的天数是本次实测值。

### 9.6 预览与路由验证

```text
$ npm run preview -- --host 127.0.0.1
$ for p in / /student /teacher /report /metrics; do curl ...; done
/ HTTP 200 root=1
/student HTTP 200 root=1
/teacher HTTP 200 root=1
/report HTTP 200 root=1
/metrics HTTP 200 root=1
asset /assets/index-BqYreLUQ.js HTTP 200 text/javascript 374340 bytes
```

- 每个路由返回 `index.html`（603 bytes），含 `<div id="root"></div>` 与
  `<title>AEH 教师工作台 · 本地</title>`，SPA fallback 生效。
- 额外做了 SSR 冒烟（不是真实浏览器；含 5 个路由与 3 个空 store 分支）：

```text
$ npm run smoke:ssr
PASS SSR / -> 3963 bytes，含“AEH 教师工作台”
PASS SSR /student -> 17425 bytes，含“学生进度、复习、诊断与门禁”
PASS SSR /teacher -> 20454 bytes，含“课程图谱、题库、干预准备与教学策略”
PASS SSR /report -> 6744 bytes，含“仅聚合的教师报告”
PASS SSR /metrics -> 5476 bytes，含“覆盖率、到期负担、回忆率与同意账本”
PASS SSR empty /student -> 2395 bytes，含“还没有学生”
PASS SSR empty /report -> 5130 bytes，含“当前没有可纳入报告的学生”
PASS SSR empty /metrics -> 5173 bytes，含“还没有学生”
SSR_SMOKE_PASS
```

**局限（诚实记录）**：环境没有可用的无头浏览器，SSR 冒烟不等于真实 DOM 交互测试；
未验证点击、表单提交在浏览器中的实际行为（这些路径由类型检查、Node 行为脚本与代码审查覆盖）。
HTTP 200 只证明服务可达与 SPA 回退，不证明浏览器内无运行时错误。

### 9.7 插件侧只读验证

```text
$ cd ../dsh-plugin && npm run typecheck
> tsc --noEmit
（exit 0）

$ npm test
ℹ tests 463
ℹ pass 463
ℹ fail 0
ℹ duration_ms 6943.763125
```

- 未修改 `dsh-plugin/` 的任何文件；`find dsh-plugin/src -mmin -180` 无输出。
- 未修改 `spec/`、`references/`；未触碰 `~/.dsh/` 或 `~/workspace/deepseek-harness`。

### 9.8 新增脚本与文档

- `scripts/check-core-behaviors.mjs`：四项核心行为断言。
- `scripts/ts-resolve-hooks.mjs`：Node 解析钩子（仅验证脚本使用，不进入浏览器 bundle）。
- `scripts/ssr-smoke.mjs`：5 路由 SSR 冒烟。
- `npm run check`、`npm run smoke:ssr` 已写入 `package.json`；未新增依赖。

