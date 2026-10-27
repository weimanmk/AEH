# AEH × dsh / Cordis 集成说明（Step 3 + Step 4 + Step 5 + Step 6 + Step 7 + Step 8 + Step 9 + Step 10 + Step 11 + Step 12 + Step 13 + Step 14 + Step 15 + Step 16 + Step 17 + Step 18）

状态：**已用真实 `@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools` 替换离线适配层，
并在一个独立隔离的 Cordis loader 实例中完成加载/卸载与工具契约测试**。Step 5 在
此基础上新增第六个工具 `aeh_generate_report`（只接收已授权聚合事件）、一个默认
不启用的文件事件存储 `FileEventStore`（append-only / 幂等 / 版本回滚 / 保留期 /
同意撤回删除传播），以及 Python 侧的独立冻结评测协议（规范 §19）。Step 6 新增
**宿主侧**受控自进化骨架 `aeh/evolution.py` 与 `dsh-plugin/src/host/evolution.ts`：
候选只允许是配置/策略/提示模板的版本化变更记录，经冻结评测集隔离评测、默认拒绝的
显式审批、仅作用于合成会话比例的灰度与熔断回滚，全链路追加式审计；**不新增任何
模型可调用的自进化工具**，审批与回滚只能由宿主侧调用。Step 7 完成 P1 加固：用
Schemastery 定义并导出 Cordis `Config`（非法配置在 `apply` 前 fail loud）、为六个
工具声明各自闭合的输出 schema、把假设快照绑定 dsh session/agent scope 并加 TTL 与
清理（不写长期孪生）、增加追加式脱敏审计（门禁拒绝原因、工具调用、审批与交付回执，
学生/租户维度只保留盐化伪名）。Step 8 完成工具入口安全加固：提示注入文本、
越权/特权参数、超大 payload 与超限速率一律 fail-closed 并记入追加式审计，
错误信息与审计日志脱敏。Step 9 增加版本化 KC 图、带审核记录的题库与本地内存 RAG
检索接口，并把“检索命中必须再过课程门禁 + 前置闭包”做成宿主/服务层边界；检索只返回
opaque itemId 与标注摘要，不返回题目原文。Step 10 增加习题演化引擎（五种受控算子、
候选带来源/声明式变更/受影响 KC、先过 fail-closed 门禁再进隔离沙箱、候选池要求
“沙箱合格 + 题库审核通过”）与动态模拟实验室（独立会话状态与独立假设快照、只收
simulated 来源的事件日志、`observedWrites` 恒为 0、配置与结果内容寻址可复现、模拟
收益与真实迁移分通道报告）。Step 14 补全主动诊断（规范 §7）：`aeh/diagnosis.py` 与
`src/core/diagnosis.ts` 支持从首个偏离步骤反向展开误解/先修/偶发失误解释、把“不确定
的答案”加入信息增益目标、以及带确定性终止原因（跳过 / 题数·时长·负担上限 / 置信度·
熵收敛 / 无可用题 / 显式停止）的诊断会话状态机；仍是合成内容，工具目录仍为六个。Step 15 增加教学策略层（规范 §10）：
fail-closed 策略路由、预习—学校—AI 强化—复习的日常协同计划、可执行的检索/间隔/交错
学习科学计划，以及学科无关的 KC/证据/策略接口与数学、物理两个示例（规范 §17/§18）；
仍只在核心模块内，不新增工具。Step 16 补齐数据模型与 Harness 状态机（规范 §12/§13/§15.3）：
`aeh/services.py` 与 `src/core/services.ts` 提供事件存储、Profile/Bundle、内容库、评测服务的
接口定义与内存/文件双实现，以及乐观并发、幂等键、写入协调与 23 状态学习闭环状态机。
仍**未**接入真实学生数据，也**未**加载进任何正在运行的
dsh 会话。本文说明 Step 1
核心如何映射为教育插件与工具、默认权限边界，以及真正接入 dsh 运行时还需要补什么。

Step 6 不修改 `aeh/` 的 Step 1/2/5 行为（只新增 `aeh/evolution.py`）与插件工具
目录（仍是六个模型可调用工具），不接入真实学生数据，不复制
`references/deepseek-harness/` 的代码；`references/` 与 `spec/` 保持只读。隔离测试
只在本目录 `dsh-plugin/` 内安装依赖（`dsh-plugin/.npm-cache`），不读写 `~/.dsh/`，
不修改 `~/workspace/deepseek-harness` 克隆或 npx 安装的 dsh。`FileEventStore` 的测试
文件只写在 `os.tmpdir()` 下的临时合成目录，默认 `enabled: false`。Step 8 同样只在
`dsh-plugin/` 与文档内工作，安全测试全部使用合成引用，未改动 `aeh/` 的 Step 1–7
行为，也未改动运行用 dsh。Step 10 同样只在 `aeh/`、`dsh-plugin/`、`tests/` 与文档内
工作：演化只重采样结构化合成标注与受控参数，不生成题干/答案/提示/图片文本；模拟
实验室只在内存中对合成行为模型采样，事件日志只接受 simulated 来源；未改动运行用 dsh，
未接入真实学生数据。

Step 18 完成**独立隔离实例中的真实会话验收**：在 `step18/` 下自建 `DSH_HOME`、profile
与 `@deepseek-ai/dsh@0.2.1-rc.3` 本地安装，用 `dsh-plugin/e2e/aeh-e2e-entry.ts` 把合成
`MemoryHostContext` 绑定进真实插件，经 Sidrune `deepseek-v4-1-flash` 跑通一次
“门禁 → 诊断 → 复习 → 报告”六工具会话；命令、事件流、会话日志与摘要都在
`step18/evidence/`。运行中的 `~/.dsh/`、npx 安装的 dsh 与 harness 源码克隆均未被读写，
也未被加载 AEH 插件。

## 1. 目标与非目标

本步要交付的是：

- 一个保持 Cordis 函数插件形状（`name` / `inject` / `apply(ctx)`）的 TypeScript
  入口；
- 把课程门禁、学生孪生、FSRS 记忆模型、虚拟学生假设、主动诊断、习题干预包
  映射为可审查的模块和六个模型可调用工具；
- 一个默认拒绝的权限清单；
- 一条清晰的宿主边界：模型可以“计算”和“准备”，但不能写长期孪生、不能交付
  干预包、不能绕过门禁。

本步**不**交付：真实 dsh 运行时挂载到生产会话、生产鉴权/KMS、同意管理后台、
真实交付 UI、真实 LLM/OCR、生产级持久化、真实生产自进化。它们列在“接入清单”和
TODO 中。Step 4 交付的是 P0 的**隔离运行时**验证与内存适配器；Step 5 在内存适配器
之上交付**最小**文件事件存储、报告工具与独立评测协议，全部仍是合成/测试实现。
Step 6 交付**宿主侧**受控自进化骨架（候选登记、隔离评测、默认拒绝审批、合成灰度、
熔断回滚、追加式审计），仍然没有生产部署通道、没有真实学生数据、没有模型可调用的
自进化工具。

## 2. 代码结构

```text
dsh-plugin/
  package.json              # 私有包；真实 @deepseek-ai/* 依赖；Node >= 24
  tsconfig.json             # strict + noEmit + NodeNext
  cordis.example.yml        # 仅示例；host 由运行时适配器注入，不写进 YAML
  scripts/
    loader-evidence.mjs     # 隔离 Cordis loader 加载/卸载 + 契约证据脚本
  src/
    index.ts                # Cordis 插件入口：name / inject / Config / apply
    dsh.ts                  # 真实 cordis/dsh-tools 的薄 authoring 适配层
    config.ts               # Step 7：Schemastery 插件 Config（fail loud）
    security.ts             # Step 8：注入/越权/payload/限流/脱敏守卫
    output-schemas.ts       # Step 7：六个工具各自的闭合输出 schema
    domain.ts               # 与 Python 核心对应的领域类型
    permissions.ts          # 默认最小权限清单与激活时校验
    report.ts               # Step 5：对应 aeh/report.py 的聚合报告边界
    service.ts              # 教育服务：工具背后的纯计算/准备逻辑
    tools.ts                # 六个模型可调用工具（声明协作式 timeoutMs）
    host/
      consent.ts            # 内存同意作用域快照，可撤回、默认拒绝
      host-context.ts       # 内存 HostContext：绑定单一 session/租户/学生
      twin-adapter.ts       # 内存宿主孪生适配器：来源认证、幂等、审计
      file-event-store.ts   # Step 5：默认关闭的 append-only 文件事件存储
      delivery.ts           # 宿主侧审批 + 交付门（工具不交付）
      evolution.ts          # Step 6：宿主侧受控自进化控制面（非工具）
      session-state.ts      # Step 7：session/agent 级假设快照（TTL/隔离/清理）
      audit-log.ts          # Step 7：追加式脱敏审计与伪名指标
    core/
      curriculum-gate.ts    # 对应 aeh/curriculum_gate.py
      curriculum-graph.ts   # Step 9：对应 aeh/curriculum_graph.py（图/题库/本地 RAG）
      exercise-evolution.ts # Step 10：对应 aeh/exercise_evolution.py（演化 + 模拟实验室）
      fsrs-calibration.ts   # Step 11：对应 aeh/fsrs_calibration.py（FSRS 校准，仅候选）
      twin.ts               # 对应 aeh/twin.py（宿主侧，不暴露写工具）
      memory.ts             # 对应 aeh/memory.py
      hypothesis.ts         # 对应 aeh/hypothesis.py
      diagnosis.ts          # Step 14：对应 aeh/diagnosis.py（反向溯源/信息增益/状态机）
      teaching-strategy.ts  # Step 15：对应 aeh/teaching_strategy.py（策略路由/日常协同/学科适配/学习科学）
      services.ts           # Step 16：对应 aeh/services.py（存储服务边界 + Harness 状态机）
      exercise.ts           # 对应 aeh/exercise.py
  tests/
    invariants.test.ts      # 13 个离线不变量测试（结构化替身）
    host-adapters.test.ts   # 12 个宿主适配器契约测试
    report.test.ts          # Step 5：8 个聚合报告边界测试
    persistence.test.ts     # Step 5：8 个文件事件存储测试
    evolution.test.ts       # Step 6：22 个宿主侧自进化骨架测试
    contract.test.ts        # 7 个真实 Cordis/dsh 运行时契约测试
    step7.test.ts           # Step 7：23 个配置/输出 schema/会话/审计测试
    security.test.ts        # Step 8：19 个注入/越权/payload/限流/脱敏测试
    curriculum-graph.test.ts # Step 9：19 个图/题库/RAG/检索后门禁测试
    exercise-evolution.test.ts # Step 10：21 个演化/模拟/隔离/共享 fixture 测试
    fsrs-calibration.test.ts   # Step 11：46 个校准/不确定性/候选门禁/共享 fixture 测试
    twin-step12.test.ts        # Step 12：24 个长期孪生生命周期/审批/绑定测试
    hypothesis-step13.test.ts  # Step 13：30 个虚拟学生群规则/保真度/快照测试
    diagnosis-step14.test.ts   # Step 14：31 个反向溯源/信息增益/状态机/共享 fixture 测试
    teaching-strategy-step15.test.ts # Step 15：54 个策略/日常协同/学习科学/学科适配测试
    services-step16.test.ts         # Step 16：64 个存储/并发/幂等/评测隔离/状态机测试
```

`src/dsh.ts` 现在直接导入真实 `@deepseek-ai/cordis` 与
`@deepseek-ai/dsh-tools`：`Context` 是 Cordis 的实现，`ctx.effect` /
`ctx.tools.register` 是真实生命周期，`defineTool` 委托 dsh-tools 做 schema 编译、
参数校验、输出校验、注册和执行：

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
```

`src/dsh.ts` 只保留一个薄的 authoring 适配层：Step 3 的工具体仍接受 `unknown`
参数，因此该层把 author-facing schema 交给 dsh-tools，并把返回定义收敛为本包
使用的形状。它**不**编译 JSON Schema、**不**校验参数、**不**提供假执行器；这些
全部由 dsh-tools 运行时负责（见 `tests/contract.test.ts`）。

## 3. Step 1 核心到 TypeScript / Cordis 的映射

| Step 1 模块 | TypeScript 模块 | Cordis 中的位置 | 默认暴露 |
|---|---|---|---|
| `curriculum_gate.py` | `core/curriculum-gate.ts` | 所有交付/诊断工具内部的策略检查 | `aeh_check_curriculum` |
| `twin.py` | `core/twin.ts` | 宿主拥有的 Profile/Bundle 事件存储适配器 | **无写工具** |
| `memory.py` | `core/memory.ts` | 复习调度计算服务 | `aeh_schedule_review` |
| `hypothesis.py` | `core/hypothesis.ts` | 会话级临时状态 | `aeh_update_hypotheses` |
| `diagnosis.py` | `core/diagnosis.ts` | 工具候选选择策略 | `aeh_select_probe` |
| `exercise.py` | `core/exercise.ts` | 干预准备/校验流水线 | `aeh_prepare_intervention` |
| `curriculum_graph.py` | `core/curriculum-graph.ts` | 宿主/服务层图与题库解析 + 检索后门禁 | **无新工具**（宿主 API） |
| `teaching_strategy.py` | `core/teaching-strategy.ts` | 策略路由、日常协同、学科适配与学习科学计划 | **无新工具**（核心/宿主 API） |

### 3.1 课程门禁：不可绕过的 fail-closed 检查

`allow(item, progress, mode)` 保持 Python 版的合取条件：

```text
safety_ok
and verified_content
and grade_appropriate
and all(required_kcs subset allowed_kcs)
and no unapproved future method
and cognitive_load_within_budget
```

缺失标注、低置信度、未知模式、空 `requiredKcs`、超预算都返回拒绝原因，而不是
默认放行。`mode` 只允许 `preview` / `learn` / `review`；插件配置还可以用
`allowedModes` 进一步收窄。

关键点：

- `aeh_check_curriculum` 只返回决策，不交付题目。
- 工具只接收 opaque `itemId` 和 `studentRef`；课程标注由宿主的 `HostContext`
  解析，模型不能内联伪造 `safetyChecked` / `contentVerified` / `taughtKcs`。
- `aeh_select_probe` 对每个 host-catalog 候选重新调用门禁；模型不能传一个
  `gateAllowed: true` 来“自称已通过”。
- `aeh_prepare_intervention` 先解析训练/迁移 item id，再逐题过门禁。
- 门禁是 Harness 侧约束，不是模型可协商的工具参数。
- 默认 `HostContext` 不解析任何内容，因此未接宿主适配器前所有需要 progress 或
  item 的工具都会 fail closed。

### 3.2 学生孪生：宿主拥有写边界

`StudentTwin` 保留 Python 版的事件溯源语义：

- `observed_*` 只接受 `student` / `teacher` / `trusted_grader` / `assessment`；
- `simulated` / `virtual_student` / `simulation` 只进入隔离的 simulated 存储；
- 模拟事件不能写入 observed，不能被提升，不能作为 mastery 更新的证据；
- mastery 更新必须引用已存在的 observed evidence id；
- 推断状态可版本化、重建、回滚，真实证据不被回滚删除。

**默认插件不注册孪生写工具。** 真实 dsh 接入时，由宿主适配器持有事件存储和
来源证明（attestation），在鉴权、同意和审计之后提交事件。模型只能看到宿主
授权的汇总/进度快照，不能构造 observed 事件。

### 3.3 FSRS 记忆模型

`core/memory.ts` 使用与 Python 版一致的示意公式：

```text
R(t) = (1 + 19/81 * t / S)^(-1/2)
dt   = 81/19 * S * (r_target^(-2) - 1)
```

质量权重：

| 观察 | 权重 | 是否独立检索成功 |
|---|---:|---|
| 独立、无提示、首次答对 | 1.0 | 是 |
| 提示后跟做/提示后答对 | 0.3 | 否 |
| 阅读讲解 | 0.0 | 否，状态不更新 |

`aeh_schedule_review` 只做计算：输入当前状态和观察，输出更新后的 stability /
difficulty、目标保持率对应的下次间隔和计数；不写数据库、不写孪生。

### 3.4 虚拟学生假设：会话级、带 unknown

`HypothesisSet` 支持 `spawn` / `split` / `merge` / `prune` / `reweight`，并始终
保留显式 `unknown` 桶。`reweight` 的贝叶斯后验包含噪声项，单次对错不会让后验
虚假地变得极尖。Step 13 在此之上补全了生成/匹配/分裂/合并/淘汰的完整规则、
`unknown` 桶管理、假设保真度指标与会话快照边界，见 §3.11。

`aeh_update_hypotheses` 接收一个快照、执行一个操作、返回下一个快照。它没有长期
证据写入，也没有跨会话持久化；`unknown` 领先时 `dominantId` 为 `null`。这对应
“短期假设可以影响下一步诊断，但不能自动变成长期真实掌握”。

### 3.5 主动诊断：信息增益减去成本，学生可跳过

`aeh_select_probe` 对每个候选计算：

```text
IG(q) + alpha * teachingValue(q)
      - beta * time(q) - gamma * risk(q) - delta * cognitiveLoad(q)
      - zeta * answerUncertainty(q)
```

只有 host-catalog 能解析、且重新通过课程门禁的候选参与排序。`skipped: true` 时
返回 `selection: null`；无候选通过时也返回 `null`；宿主无法授权 progress 时返回
`blockedReason: "progress_unavailable"`。工具不强制出题，不记录作答。

Step 14 在核心模块中补全了这一步的两端（见 §3.12）：`predictive_uncertainty` /
`predictiveUncertainty` 惩罚“预测接近掷硬币”的题，`trace_backward` / `traceBackward`
从错误步骤回溯到 KC/误解并把权重喂给选题，`DiagnosisSession` 是显式的
出题—作答—更新—终止状态机，`BurdenBudget` 限制总题数/时长/认知负担。这些能力目前
只在 `aeh/diagnosis.py` 与 `src/core/diagnosis.ts` 内可用；工具只增加
`answerUncertainty` 输出与可选 `zeta` 输入，不新增第六个以外的工具。

### 3.6 习题干预包：准备与交付分离

`aeh_prepare_intervention` 先通过 `HostContext` 解析 `trainingItemIds` /
`transferItemIds`，再做以下校验：

- 训练题、提示阶梯、完成判据、必需 KC 是否齐全；
- 训练题与迁移题是否重叠；
- 每个训练/迁移题是否通过门禁；
- 迁移题是否 `seenBefore: true`（不可用作迁移评测）；
- 包级 `requiredKcs` 是否落在允许 KC 并集内。

无法解析的 item id 或未授权的 progress 会让结果 `valid: false`，并给出
`item_not_found:<id>` / `progress_unavailable`，不会产生部分交付。

返回 `deliveryEligible`，但固定带 `notDelivered: true` 和
`requiresHostApproval: true`。真实交付必须由宿主在同意、审批和独立门禁复检后
调用宿主侧交付适配器；模型工具不能直接把题交给学生。

### 3.7 Step 2 模块的映射（Step 5 完成）

`aeh/report.py` 的边界已映射为 `src/report.ts` + 工具 `aeh_generate_report`：

- 工具参数被固定为聚合计数器（`attempts` / `independentCorrect` /
  `hintedCorrect` / `hintsRequested` / `reviewsDue` / `reviewsCompleted` /
  `minutes`）加 opaque 的 `consentScope` 与聚合批次引用 `aggregateRef`；
- `additionalProperties: false` 让题目、答案、图片、步骤、任意 `payload` 在
  dsh schema 编译阶段就被 `INVALID_ARGS` 拒绝；`report.ts` 另有字段白名单，
  即使绕过 schema 也会被拒绝；
- 按受众 scope 取交集（调用方只能收窄），跨学生/越界/未授权/重复事件只计入
  `events_excluded`；
- 输出只有聚合总量、知识点 id 与待关注原因，**不含** `aggregateRef`、原始数据或
  事件引用；`aggregateRef` 只用于幂等去重，不是原始学习事件 id。

`demo_session.py` 是离线教学演示，不在插件运行时内；插件不接收也不重放它的原始
作答。跨服务的合规身份、同意记录与保留期仍需宿主实现（见 P1）。

### 3.8 课程图谱、题库与本地检索（Step 9）

Python `aeh/curriculum_graph.py` 与 TypeScript `core/curriculum-graph.ts` 是同一
行为的双实现，共享 `tests/fixtures/curriculum_step9.json` 的合成 fixture：

- **KC 图**：不可变 `KnowledgeGraph(version)`，节点/边先校验再入图。approved
  `REQUIRES` 与 `PART_OF` 必须有向无环；自环、重复节点/边、未知端点/关系/状态、
  confidence 越界一律拒绝。`A --REQUIRES--> B` 表示 A 需要先学 B；
  `prerequisiteClosure(A)` 返回 B 及传递前置。`proposed` 边（例如 LLM 提议）保留
  在图中供审核，但不进入闭包、不作为先修、也不参与 approved 环判定。
- **版本化**：`KnowledgeGraphStore` append-only、版本严格递增，每个版本带
  canonical JSON 的 SHA-256 内容摘要；`diff(from, to)` 列出节点/边增删。Python 与
  TypeScript 的图哈希在共享 fixture 上完全一致。
- **题库**：`ItemAnnotation` 保存 source/license/stage/course、KC、Q-matrix、难度、
  题型、时长、verifier、安全/内容/正确性标注与置信度等结构化标签，不保存题干、
  答案、提示、解题步骤或图片。`ItemBank` 有不可变版本历史与追加式审核记录
  （submit/approve/reject/request_changes）；修订内容会递增版本并把审核状态重置为
  `draft`，旧批准不继承。缺失标注可保存为草稿但不可批准；映射到门禁 item 时显式
  `annotationsComplete=false`，门禁以 `incomplete_annotations` 拒绝。已批准但
  annotation confidence 低于阈值的条目仍会被门禁以 `low_annotation_confidence`
  拒绝。
- **本地内存 RAG**：`ItemBank.search(query)` 只索引当前 approved 版本，按 KC、
  难度区间/目标、题型过滤；返回 opaque `itemId`、分数和标注摘要
  （`requiredKcs`/`qMatrixKcs`/difficulty/itemType/confidence/reviewStatus/version/
  minutes/grade），没有原文、答案或提示字段。
- **检索后门禁**：`planRetrieval()` 与
  `AehEducationService.retrieveCandidatesFor()` 都会对每个命中重新解析当前 item、
  跑 `allow()` 并检查传递前置闭包。只有同时通过的命中进入 `candidates`；前置未满足
  为 `prerequisites_not_met:<kc>`，未知 KC 为 `kc_not_in_graph:<kc>`，图缺失为
  `blockedReason="graph_unavailable"`。因此前置未满足的 KC 对应题目不会被选作
  候选，更不会交付。
- **HostContext**：新增可选 `resolveGraph()` 与 `retrieveItems(query)`。
  `MemoryHostContext` 可注入宿主构造的 `graph` 与 `itemBank`，把题库当前版本加入
  可读 catalog；撤回 `curriculum:read` 后图、catalog item 与检索结果一起变为不可读。
  `toHostBinding()` 显式转发这两个方法，适配 Cordis loader 只复制数据属性的行为。
- **边界**：没有新增模型可调用工具；模型不能直接传图、题库或标注，也不能把检索
  hit 直接变成交付。插件工具目录仍是六个。

### 3.9 习题演化与模拟实验室（Step 10）

Python `aeh/exercise_evolution.py` 与 TypeScript `core/exercise-evolution.ts` 是同一
行为的双实现，共享 `tests/fixtures/exercise_evolution_step10.json` 的合成 fixture：

- **受控算子**：`numeric`（同一 KC/年级带内重采样数值参数）、`context`（替换表层
  情境、结构不变）、`distractor`（仅 `multiple_choice`，重生干扰项、正确项与所需推理
  不变）、`difficulty`（[0,1] 内调难度并按比例缩放时长）、`diagnostic`（指向误区，
  使两个假设产生不同可观察步）。算子只改结构化标注与受控参数，不生成题干文本。
- **候选溯源**：`EvolutionCandidate` 带来源 item/版本、算子、声明式 `changes`、受
  影响 KC、seed 与生成器版本；`candidate_id`/`proposed_item_id` 由来源 + 算子 + seed
  确定性生成，annotation `source` 标为 `synthetic.evolved.<operator>`、`exposureCount`
  归零，并冻结为内容寻址哈希。Python/TS 的候选哈希在共享 fixture 上完全一致。
- **fail-closed 校验**：`ExerciseEvolutionEngine.validate()` 复用课程门禁 `allow()`
  并检查缺失标注、缺失图与传递前置闭包；未授/超前 KC、低进度置信度、缺失前置、
  未知 KC、标注不完整或图缺失都使候选无效，**不会**进入沙箱。
- **隔离沙箱**：`EvolutionSandbox.evaluate()` 在通过门禁后用独立假设快照跑模拟，
  产出 `simulatedBenefit`（`isCausalEvidence=false`）与独立 `realTransfer` 通道；没有
  真实冻结迁移集与独立观测时永远是 `promotion_blocked:real_transfer_evidence_missing`。
- **候选池**：`EvolutionCandidatePool.admit()` 要求候选可交付、item-bank 记录为同一
  `proposedItemId` 且已 `approved`、`observedWrites == 0`；否则抛 `CandidatePoolError`。
  演化**不能绕过**课程门禁或题库审核。
- **模拟隔离**：`SimulationSession` 从快照构造私有 `HypothesisSet`，会话内 reweight
  不改动源假设；`SimulationEventLog` 只接受 `simulated`/`virtual_student`/`simulation`
  来源，任何真实来源抛 `SimulationIsolationError`；`observedWrites` 恒为 0，
  `SimulationResult.realTransfer` 恒为 `null`。
- **可复现**：`SimulationConfig`（seed/版本/场景/阶段计划/maxSteps）与
  `HypothesisSnapshot` 都做 canonical JSON 内容寻址；结果指纹只对整数微单位（概率、
  正确率、增益、置信区间）与逐步 `phase/item/hypothesis/correct` 计算。两侧共享
  `mulberry32`、FNV-1a 32、`jsRound`、`round4`、`quantizeMicros`，在相同 seed/配置/
  快照上得到逐字节一致的结果指纹与会话 id。
- **真实迁移通道**：TS 侧没有评测模块，故 `exercise-evolution.ts` 内联实现冻结迁移集
  与可信来源（`student`/`teacher`/`trusted_grader`/`assessment`）校验，只接受独立
  作答的 unseen 迁移题，结果仍为描述性（`causalClaimSupported=false`）。
- **边界**：没有新增模型可调用工具；模型不能直接触发生成器、沙箱或候选池。插件工具
  目录仍是六个。

### 3.10 FSRS 参数校准（Step 11）

Python `aeh/fsrs_calibration.py` 与 TypeScript `core/fsrs-calibration.ts` 是同一行为的
双实现，共享 `tests/fixtures/fsrs_calibration_step11.json` 的合成 fixture。校准**只**
产出参数候选，不写任何真实掌握度：

- **确定性拟合**：沿用规范 §8.3 的示意曲线 `R = (1 + 19/81 · t / S_eff)^(-1/2)`，
  其中 `S_eff = max(0.4, S · (10-D)/5)`；待拟合向量固定为
  `initial_stability_days / success_growth / failure_shrink / initial_difficulty /
  difficulty_success_delta / difficulty_failure_delta`。优化器是从四个确定性起点出发的
  坐标下降（best-of multi-start），目标为 Brier 分数 + 向规范先验的 ridge 收缩。
  拟合路径只用 `+ - * / sqrt`，避免 `pow`/libm 跨语言舍入差异。
- **不确定性与适用性**：`CalibrationConfig`（seed/dataVersion/parameterVersion + rounds、
  stepFraction、bootstrapResamples、ridge、confidence、阈值）与数据摘要都做 canonical
  JSON 内容寻址；bootstrap 复用共享 `mulberry32`，输出每个参数的 95% 区间、
  `identified()`（区间宽度 ≤ 半量程）与 Brier 的区间，另有 ECE、log loss、10 个可靠性
  分箱。`Applicability` 明确 scope、观测数、elapsed-day 范围、独立/提示观测计数、
  `evidenceSufficient` 与 out-of-scope 清单。点数落在 bootstrap 区间内；弱辨识参数被
  如实列出而非隐藏。
- **候选边界**：`CalibrationService.calibrate()` 返回不可变 `CalibrationReport`；
  `propose_candidate()` 只生成声明式 `Candidate`（`kind="config"`、
  `source="human_request"`、影响面 `review_scheduling`/`simulation_parameters`、
  基线版本 `fsrs_illustrative_19_81`、`changes.parameters` 为量化参数）。
  `PRODUCTION_MUTATION_ENABLED=False`、`SYNTHETIC_FIXTURES_ONLY=True`。
- **隔离评测 + 显式批准 + 激活**：`CalibrationActivationGate` 的状态机为
  `registered → evaluated/rejected → approved → activated → rolled_back`。
  `evaluate_candidate()` 在**不相交**的合成 held-out 集上计算候选相对示意基线的 Brier
  改善，模拟收益恒为 `isCausalEvidence=false`；真实迁移通道单独报告，只接受可信来源
  （`student`/`teacher`/`trusted_grader`/`assessment`）且未见过的题项。没有真实迁移证据
  时 `promotion_blocked:real_transfer_evidence_missing`，`promotionReady` 永远为 false。
  `activate()` 需要隔离评测通过**且**显式宿主审批（默认拒绝、禁止自批、要求宿主角色）；
  激活只返回冻结的参数配置对象，**不**写 `MemoryState` 或 `StudentTwin`。真实收益是
  独立声明，不能由模拟收益自证。
- **跨语言一致**：两侧共享 `mulberry32`、`round4`、`quantizeMicros`、`contentHash`/
  `canonicalJson`；在共享 fixture 上 `datasetDigest`、`configFingerprint`、
  `reportFingerprint`、参数、估计区间、metrics、适用性逐字节一致。
- **边界**：没有新增模型可调用工具；模型不能触发校准、批准或激活。插件工具目录仍是
  六个。`references/awesome-fsrs` 只作机制参考，未整体复制其代码。

### 3.11 虚拟学生群完整规则、保真度与快照边界（Step 13）

`aeh/hypothesis.py` 与 `core/hypothesis.ts` 是同一行为的双实现，共享
`tests/fixtures/hypothesis_step13.json`。它把规范 §6.1–6.4、§19.3 拆成可测试的规则：

- **生成（Spawn/Generate）**：`spawn(..., trigger=...)` 记录规范 §6.2 的触发条件
  （`unexplained_step` / `new_question_type` / `conflicting_evidence` /
  `new_subject_scope` / `diversity_collapse`）；`generate(observations, candidates)`
  只在“当前没有任何候选把某个行为预测到阈值以上”且新候选在该行为上至少提升
  `min_gain` 时才生成，避免机械复制权重最高的模型。
- **匹配（Match）**：`match(observations)` 用每个假设自己的
  `predicted_observable_behaviors` 计算 Bernoulli 似然（带 `smoothing` 防止 0/1
  概率），再走带噪声的贝叶斯后验更新；没有被任何候选建模的行为作为
  `unexplainedBehaviors` 返回。似然历史只用于本步的淘汰规则，不回写长期孪生。
- **分裂（Split）**：`splitDistinguishable(...)` 先检查子假设两两的
  `hypothesisSimilarity()` 是否 ≤ `maxSimilarity`，不可区分的分裂被拒绝，父假设保持
  `active`。相似度 = 0.6·行为预测相似 + 0.2·`bug_rules` Jaccard + 0.2·策略 Jaccard，
  缺失预测按 chance 处理。
- **合并（Merge）**：`mergeIndistinguishable(...)` 对相似度 ≥ 阈值的连通分量合并，
  新假设保留 `merged_from` 来源历史，`bug_rules`/`strategy_policy` 取并集、行为预测取
  均值、知识假设取权重最高成员。
- **淘汰（Prune/Archive）**：`pruneWeak`（后验过低）、`pruneContradicted`
  （至少 `min_matches` 次匹配的平均似然过低）、`pruneUninformative`（与更强的候选不可
  区分、没有独特解释力）都只把质量移入 `unknown`，绝不转给另一个候选。
- **unknown 桶管理**：`setUnknown`、`requestRealEvidence` / `resolveEvidenceRequest`、
  `unknownReasons` 记录原因；`unknown` 领先（`dominant()` 为 `None`）时自动标记需要真实
  证据，而不是强行选一个候选。
- **保真度指标（§19.3）**：`fidelity(observations)` 输出 Brier、log loss、ECE、
  accuracy、coverage、`unknown` 占比、有效假设数（1/Σw²）、最大权重，以及错误类型 /
  错误步骤 / 策略与主导假设规则的一致率；`recent_evidence_id` 给出“新证据到达后是否
  仍固守旧状态”的 `anti_mismatch`。无法计算时返回 `None` 而不是编造值。
- **快照边界**：`toState()/fromState()` 是工具边界上的最小 wire 形状（保持六个工具的
  输出 schema 不变）；`toSnapshot()/fromSnapshot()` 额外携带 `unknown` 原因、匹配统计与
  `bound_twin_version`，并显式带 `persistsToLongTermTwin: false`。
  `HypothesisSnapshotStore` 做 session/agent scope、TTL 与容量上限，跨会话读/删
  fail-closed；`persistToTwin()` 永远抛错。生产环境仍需持久化、访问控制的 session store。

## 4. Cordis 插件结构

入口保持与 dsh 参考结构一致的函数插件形状：

```ts
export const name = 'aeh-education'
export const inject = ['tools']
// Step 7: the loader validates/defaults this schema before `apply` runs.
export const Config = AEH_CONFIG_SCHEMA

export function apply(ctx: Context, config: PluginConfig = {}): void {
  assertMinimalPermissions(config.permissions)
  const service = createEducationService(
    resolveAehConfig(config), // single Schemastery validation path, fail loud
    config.host, // host-owned progress/item resolver; defaults to resolve-nothing
  )
  const snapshots = new SessionSnapshotStore() // Step 7: session/agent scoped
  const audit = new AehAuditLog() // Step 7: append-only, pseudonymised

  ctx.effect(() => {
    const disposers = createEducationTools(service, { audit, snapshots })
      .map((tool) => ctx.tools.register(tool))
    const detach = attachSessionCleanup(ctx, snapshots, audit)
    return () => {
      detach()
      disposers.reverse().forEach((dispose) => dispose())
    }
  })
}
```

对应关系：

| Cordis 概念 | 本骨架中的用法 |
|---|---|
| 函数插件 | `export function apply(ctx, config)` |
| 服务依赖 | `export const inject = ['tools']`，等待工具注册表就绪 |
| 可逆注册 | 所有 `ctx.tools.register` 都放在一个 `ctx.effect` 中 |
| 工具定义 | `defineTool({ name, description, parameters, output, execute })` |
| 取消 | `execute` 开头调用 `throwIfAborted(exec)`，协作式响应 `exec.signal` |
| 配置 | `profile` / `targetRetention` / `allowedModes`；真实接入改用 Schemastery |
| 宿主解析 | `HostContext.resolveProgress` / `.resolveItem` 从授权会话解析；默认 `NO_HOST_CONTEXT` 全部 fail closed |

`src/dsh.ts` 的 `defineTool` 直接委托真实 `@deepseek-ai/dsh-tools`：JSON Schema
编译、参数校验（`INVALID_ARGS`）、输出校验、注册和策略流水线都由 dsh 运行时
负责，本包不再有第二套 schema 编译器。工具声明 `timeoutMs`，并在 `execute` 开头
用 `throwIfAborted(exec)` 协作响应 `exec.signal`。

Step 4 新增的内存适配器位于 `src/host/`：

- `MemoryHostContext`：绑定单一 `sessionId` / `tenantId` / `studentRef`，只解析
  该学生的 progress 和受信 catalog；撤回 `curriculum:read` 后所有读取 fail closed。
  因为 Cordis loader 的 config 传输只保留数据属性，它提供 `toHostBinding()` 返回
  一个闭包当前适配器的普通对象，供运行时装配。
- `MemoryHostTwin`：在 `StudentTwin` 之上加宿主职责——来源认证（可注入
  `verifyAttestation`，内存实现**不是**生产密码学）、同意作用域、按 `eventId`
  幂等、追加式审计（只记 opaque id/版本/原因码，不记 payload）、observed 与
  simulated 硬隔离。
- `ApprovalLedger` / `HostDeliveryAdapter`：宿主侧审批与交付门，交付前重新解析
  包并再过门禁；工具只返回 `notDelivered` / `requiresHostApproval`。
- `FileEventStore`（Step 5）：在 `MemoryHostTwin` 之上持久化**已认证 observed**
  事件到本地 `events.jsonl`，默认 `enabled: false`；只接受 `synthetic.*` /
  `demo.*` 学生引用与 `syntheticRoot` 内的目录；按 `eventRef` 幂等、记录 SHA-256
  完整性校验（不是签名）、`retentionDays` 到期与 `twin:observe` 撤回都以
  `tombstones.jsonl` 追加式墓碑实现删除传播，撤回后读写与 `load()` 全部 fail
  closed；持久化记录**不含** payload，因此原始作答不会写入文件。

这些适配器全部是合成/测试用的内存或本地文件实现，不是生产鉴权、KMS、持久化或
交付通道。`FileEventStore` 的测试只使用 `os.tmpdir()` 临时目录。

## 5. 工具目录

| 工具 | 输入 | 输出 | 状态变更 | 权限 |
|---|---|---|---|---|
| `aeh_check_curriculum` | `mode`、`itemId`、`studentRef` | 门禁决策 + 拒绝原因 | 无 | `curriculum:read` |
| `aeh_update_hypotheses` | 假设快照 + 单个操作 | 归一化快照、权重、dominant | 仅调用方持有的会话快照 | `session:hypothesis:write` |
| `aeh_select_probe` | 候选 `itemId`、权重、`studentRef`、mode | 选中的 probe / null + 被拒候选 | 无 | `curriculum:read` |
| `aeh_schedule_review` | memory state + observations + target | 更新后的记忆状态、下次间隔 | 无 | `review:schedule:compute` |
| `aeh_prepare_intervention` | 包含 `trainingItemIds` / `transferItemIds` 的包、`studentRef`、mode | 校验结果、`deliveryEligible`、`notDelivered` | 无 | `intervention:prepare` |
| `aeh_generate_report` | `audience`、`studentRef`、窗口、已授权聚合事件、可选收窄 scope | 最小化聚合报告（总量 + 知识点 + 待关注） | 无（纯读取/计算） | `report:aggregate:read` |

没有 `aeh_twin_write`、`aeh_deliver_intervention`、`aeh_override_gate` 或
`aeh_read_raw_student_data`。这不是遗漏，是默认权限设计的一部分。`aeh_generate_report`
也不接收题目原文、答案、图片、步骤或原始事件 id：schema 闭合 + 运行时白名单双重拒绝。

Step 6 同样**没有** `aeh_*_evolution_*` / `aeh_approve_*` / `aeh_rollback_*` 工具：
候选登记、隔离评测、批准、灰度、晋升与回滚只在宿主侧
`src/host/evolution.ts` / `aeh/evolution.py` 中调用，模型最多能提供候选记录数据，
不能审批、晋升或回滚任何版本。

门禁/诊断/干预工具的参数里**没有** curriculum item、progress 或安全标注对象；
模型只传 `itemId` / `studentRef`。`HostContext.resolveProgress` 和
`resolveItem` 返回宿主已授权的快照；默认实现返回 `undefined`，因此插件在没有
宿主适配器时对这三类工具全部 fail closed。模型因此无法通过伪造
`taughtKcs`、`safetyChecked` 或 `annotationConfidence` 来解锁内容。

所有工具输出都是 JSON 友好的普通对象。Step 7 起每个工具都在
`src/output-schemas.ts` 声明**顶层闭合**的 object schema（`type: 'object'` +
`additionalProperties: false`；动态 key 映射在嵌套层用 `additionalProperties: true`），
dsh-tools 在返回前校验，越界返回是 `INVALID_TOOL_OUTPUT`。

## 6. 权限模型：默认最小权限

`src/permissions.ts` 的 `MINIMAL_PERMISSIONS` 是唯一允许的清单：

| 能力 | 默认 | 用途 |
|---|---|---|
| `curriculum:read` | 允许 | 读取宿主授权的课程/进度快照 |
| `session:hypothesis:write` | 允许 | 更新会话级假设快照，不写长期证据 |
| `review:schedule:compute` | 允许 | 纯 FSRS 计算 |
| `intervention:prepare` | 允许 | 准备/校验干预包，不交付 |
| `report:aggregate:read` | 允许 | 只用已授权聚合事件生成最小化报告 |

永久拒绝：

| 权限 | 为什么拒绝 |
|---|---|
| 学生原始数据（`studentRawData`） | 插件只接收 opaque `studentRef`；进度/标注由 `HostContext` 解析 |
| 数据库写（`databaseWrite`） | 事件提交由宿主适配器负责 |
| 凭据（`credentials`） | 插件不需要任何密钥/令牌 |
| 任意文件（`arbitraryFilesystem`） | 骨架不读文件；内容由宿主注入 |
| 网络（`network`） | 无模型调用、无外部服务、无遥测 |
| observed twin 写（`observedTwinWrite`） | 真实证据只能经宿主来源认证后提交 |
| 门禁覆盖（`gateOverride`） | 课程/安全门禁不可由模型或插件降低 |
| 自我批准（`selfApprove`） | 交付/候选批准属于宿主与独立评测器 |

执行方式：

- 插件激活时调用 `assertMinimalPermissions(config.permissions)`；任何未知能力、
  永久拒绝项或 `more` 扩展请求都会让激活失败（fail-closed）。
- 没有“授权提权”入口；需要更大能力的宿主必须实现并审查独立适配器，而不是放宽
  本插件。
- 工具参数不包含题目原文、答案、图片、作答步骤或任意原始 `payload`；
  `studentRef` 是 opaque 引用。
- progress/item 标注由 `HostContext` 解析，默认 resolve-nothing；模型参数不能
  伪造课程进度或安全标注。
- 门禁和诊断在选择/准备阶段都会重新计算，不能靠模型参数跳过。
- Step 8 起工具入口增加独立的注入/越权/payload/限流守卫；错误信息与审计日志脱敏
  由同一守卫保证（见 §6.1）。

### 6.1 Step 8 工具入口安全加固

`src/security.ts` 的 `SecurityGuard` 在**每个工具的 body 之前**执行（`tools.ts` 的
`withSecurityAndAudit` 包装）：先做会话/学生限流，再做参数安全检查，最后才调用
真正的计算逻辑。任何拒绝都抛 `SecurityError`（继承 dsh `HarnessError`，因此真实
dsh 运行时把稳定的 `info.code` 暴露给调用方，而不是一段不可路由的文本），并把
原因码写入追加式审计；拒绝不会启动工具体，也不会改变门禁/权限/受众/审批状态。

- **提示注入防护**：递归扫描参数中的字符串与键名。命中“改门禁/改权限/改报告受众/
  改审批/角色冒充/套取系统提示或密钥”等中英文指令式文本时，以
  `AEH_INJECTION_REJECTED` fail-closed，审计只记 `instruction_pattern:<category>`
  与参数路径，**不记原始文本**。模式锚定“动词 + 受保护对象”，普通课程描述与
  opaque id 不会误伤。
- **越权防护**：伪造的进度、标注、scope、`studentRef` 仍只经宿主
  `HostContext.resolveProgress` / `resolveItem` 解析，解析不到即 fail-closed；
  额外拒绝会冒充宿主决策对象的参数键（如 `gateOverride` / `permissions` /
  `studentRawData` / `audienceOverride` / `approvalId` 等），返回
  `AEH_UNAUTHORIZED_ARGUMENT`。宿主决策对象不可能来自模型参数。
- **超大 payload 拒绝**：按配置上限拒绝超长字符串、超长数组、过多对象键、过深
  嵌套、总序列化字节超限，以及循环引用，统一返回 `AEH_PAYLOAD_TOO_LARGE` 与
  `payload_too_large:<kind>` 原因码；错误对象不回显原始值。
- **速率限制**：按 dsh session/agent scope 与 opaque `studentRef` 两个固定窗口
  独立计数，返回 `AEH_RATE_LIMITED` + `rate_limited:session` / `rate_limited:student`。
  超限只拒绝当前窗口的调用，不消耗也不影响其他 session/学生；窗口过期后自动恢复。
- **错误与日志脱敏**：工具抛出的错误在离开 body 前去掉绝对路径、`file://` URL 与
  密钥样式 token 并压平换行；`AehAuditLog` 仍然只接受标量与原因码、递归拒绝
  题目/答案/图片/prompt/payload/密钥类键，工具审计从不写参数。`SecurityGuard` 的
  限流桶只保存会话/学生键，不写日志、不产出指标。

上限与限流默认值在 `config.ts` 的 `security.limits` / `security.rateLimits` 中声明，
非法值在 `apply` 前 fail loud：字符串 4096、数组 256、对象键 128、深度 12、序列化
131072 字节；每 60 秒每 session 120 次、每学生 240 次。注意这是单插件实例的内存
限流，跨进程/跨副本的分布式限流与 locale 展示仍属未完成项（见 §11）。

## 7. 数据与信任边界

```text
真实学生/教师/可信判题
        │  (宿主认证、同意、审计)
        ▼
宿主事件存储 / Profile / Bundle / FileEventStore（默认关闭，append-only + 墓碑）
        │                                   │
        │                                   ├─►  StudentTwin（observed，只追加）
        │ 授权进度/聚合快照                  │         │ 推断 mastery
        ▼                                   │         ▼
  AEH 插件工具（无原始数据）          宿主侧版本/回滚
        │
        ├─ 门禁决策
        ├─ 会话假设
        ├─ 诊断选择
        ├─ FSRS 调度
        ├─ 干预包准备 ──► 宿主审批/交付（插件不直接交付）
        └─ 聚合报告 ──► 教师/家长视图（不含原始数据与事件引用）

模拟学生 ──► simulated 隔离存储 ──► 可影响短期假设/教学实验
                              ✗ 不能写 observed、不能提升为真实证据
                              ✗ 不能在评测里充当真实迁移证据（见 §9 Step 5）
```

测试只用 `synthetic.student.001` 这类合成引用；仓库不包含真实学生数据、密钥或
生产凭据。`StudentTwin` 的 `payload` 字段存在是为了宿主适配器的完整性，但默认
工具不接受它；真实接入时应把 payload 留在宿主存储，不进入模型上下文。

## 8. 一次典型调用链

1. 宿主适配器实现 `HostContext`：`resolveProgress(studentRef)` 返回已授权进度，
   `resolveItem(itemId)` 返回受信内容标注；默认实现什么都不返回。
2. 模型调用 `aeh_check_curriculum({ mode, itemId, studentRef })`；宿主解析失败或
   门禁拒绝时接受拒绝原因，不重试绕过。
3. 模型把候选 `itemId`、每个假设的预测正确率交给 `aeh_select_probe`；工具解析受信
   标注、重新过门禁，学生可 `skipped: true`。
4. 观察到作答后，模型/宿主在会话内调用 `aeh_update_hypotheses` 更新后验。
5. 复习阶段调用 `aeh_schedule_review`，得到下次间隔；真实排程由宿主写入。
6. 需要干预时调用 `aeh_prepare_intervention`（包内只有 `trainingItemIds` /
   `transferItemIds`），只得到 `deliveryEligible`。
7. 宿主做同意/审批/独立门禁复检，调用宿主交付适配器；插件不直接发题。
8. 报告阶段，宿主把窗口内**已授权聚合事件**交给 `aeh_generate_report`；工具按受众
   scope 取交集、排除跨学生/越界/未授权/重复事件，只返回最小化聚合报告；原始题目、
   答案、图片、步骤与事件 id 既不进入参数也不出现在输出。

## 9. 真正接入 dsh 运行时还要补什么

### P0：没有这些不能上线（Step 4 完成情况）

状态图例：**已完成** = 本轮在隔离测试实例中验证；**部分** = 骨架/内存实现完成，
生产项未完成；**未完成** = 本轮未做。

| P0 项 | Step 4 状态 | 证据 / 残留 |
|---|---|---|
| 替换 `src/dsh.ts` 为真实 `@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools` | **已完成（隔离实例）** | `src/dsh.ts` 直接导入两个真实包；`npm run typecheck` 通过；`tests/contract.test.ts` 与 `npm run evidence:loader` 用真实 `cordis-plugin-loader` 挂载 6 个工具、dsh 编译 schema、卸载后归零 |
| `HostContext` 适配器 | **部分** | `src/host/host-context.ts` 的 `MemoryHostContext` 绑定单一 session/租户/学生，未授权与撤回同意 fail closed；`tests/host-adapters.test.ts` 覆盖。**未完成**：真实身份提供方、KMS/签名会话、跨进程租户存储 |
| 宿主孪生适配器 | **部分** | `src/host/twin-adapter.ts` 的 `MemoryHostTwin` 支持 append-only、`eventId` 幂等、版本/回滚、可注入来源认证、追加式审计、observed/simulated 硬隔离；`tests/host-adapters.test.ts` 覆盖。**未完成**：真实签名 attestation/KMS、持久化存储、保留期与删除传播 |
| 身份、租户、同意作用域 | **部分** | `src/host/consent.ts` 的显式、可撤回 scope + session 绑定；撤回后读取/写入均拒绝并有审计。**未完成**：真实同意记录来源、法定监护人流程、跨服务撤销传播 |
| 交付适配器与审批 | **部分** | `src/host/delivery.ts` 的 `ApprovalLedger` + `HostDeliveryAdapter` 在交付前校验 session、`intervention:deliver` 同意、审批记录，并重新解析包再过门禁；工具本身只 prepare。**未完成**：真实 LMS/UI 通道、审批后台、独立评测与回滚流水线 |
| dsh 契约/集成测试 | **已完成（隔离实例）** | `tests/contract.test.ts`：参数校验（`INVALID_ARGS`）、取消（`exec.signal` → `ABORTED_BEFORE_DISPATCH`）、超时（`TOOL_TIMEOUT`）、卸载清理；`npm run evidence:loader` 记录加载证据 |
| 错误与取消语义 | **部分** | 所有工具在入口协作响应 `exec.signal`，声明 `timeoutMs = 2000`，错误由 dsh 结构化为 `INVALID_ARGS` / `ABORTED_BEFORE_DISPATCH` / `TOOL_TIMEOUT`，工具不产生半写状态（纯内存计算）。**未完成**：真实持久化事务与跨步骤回滚 |

### Step 4 加载证据（可复现）

命令：

```bash
cd dsh-plugin
npm install --cache .npm-cache   # 只在本目录，独立缓存
npm run typecheck
node --test tests/*.test.ts
npm run evidence:loader
```

`npm run evidence:loader` 在独立 `Context` 中构造 `SystemPrompt` + dsh
`ToolRuntime` + timeout policy + `cordis-plugin-loader`，再用 loader 从
`src/index.ts` 挂载插件。本机 Node `v24.22.1` 下的输出：

```text
AEH Step 4+5+8 isolated Cordis/dsh loader evidence
- node: v24.22.1
- @deepseek-ai/cordis: 4.0.5
- @deepseek-ai/dsh-tools: 0.2.1-rc.3
- @deepseek-ai/cordis-plugin-loader: 1.0.6
- loader entry: a1f7de26
- mounted tools: aeh_check_curriculum, aeh_generate_report, aeh_prepare_intervention, aeh_schedule_review, aeh_select_probe, aeh_update_hypotheses
- authorised gate decision: {"allowed":true,"reasons":[],"allowedKcs":["kc.fraction.add","kc.fraction.equiv","kc.place.value"],"itemId":"item.fraction.add.001","mode":"learn","policy":"aeh.curriculum_gate.v1"}
- report data-minimization: {"authorized_aggregate_events_only":true,"raw_student_data_included":false,"event_refs_included":false,"source_events_used":1,"source_events_excluded":0,"authorized_scopes":["educational_report","teacher_report"]}
- invalid-argument code: INVALID_ARGS
- injection-rejection code: AEH_INJECTION_REJECTED
- cancellation code: ABORTED_BEFORE_DISPATCH
- timeout code: TOOL_TIMEOUT
- tools after unload: 0
OK: loader mount, dsh schema validation, cancellation, timeout, and unload verified in isolation.
```

隔离边界：该脚本与测试都只创建自己的 `Context` 与工作目录，依赖装在
`dsh-plugin/node_modules`（缓存 `dsh-plugin/.npm-cache`），不读也不写 `~/.dsh/`，
不改动 `~/workspace/deepseek-harness` 克隆或 npx dsh，也不会把插件加载进正在运行
本任务的 harness 会话。

### Step 5 完成情况

状态图例同上：**已完成** = 在本目录合成数据上实现并有测试；**部分** = 最小模型
完成，生产项未完成。

| Step 5 交付项 | 状态 | 证据 / 残留 |
|---|---|---|
| 报告插件（只接收已授权聚合事件） | **已完成（合成数据/隔离实例）** | `src/report.ts` 对应 `aeh/report.py` 边界；`aeh_generate_report` 参数 schema 闭合（`additionalProperties: false`），dsh 编译阶段即拒绝原始字段；`report.ts` 运行时白名单二次拒绝；输出无 `aggregateRef`/原始数据。`tests/report.test.ts`（8）、`tests/contract.test.ts` 报告契约测试、`tests/invariants.test.ts` 报告断言覆盖。**残留**：真实身份/同意网关、法定监护人流程、跨服务审计 |
| 文件事件存储（append-only/幂等/版本回滚/保留期/删除传播） | **部分** | `src/host/file-event-store.ts` 默认 `enabled: false`，只接受 synthetic root/学生；`events.jsonl` append-only + SHA-256 完整性校验（非签名）、`eventRef` 幂等、委托 `MemoryHostTwin` 版本/回滚、`retentionDays` 与 `twin:observe` 撤回写 `tombstones.jsonl` 并拒绝后续读写/`load()`；持久化记录不含 payload。`tests/persistence.test.ts`（8）覆盖。**残留**：跨服务删除传播、事务/乐观并发、加密、备份生命周期、真实 KMS attestation |
| 评测脚本与报告模板（模拟收益/真实迁移分离） | **已完成（合成数据）** | `aeh/evaluation.py` 的 `FrozenEvalSet`（train/explanation/transfer 分片隔离、transfer `seen_before=false`、SHA-256 冻结摘要）与 `EvaluationProtocol`（模拟通道只允许非迁移题、真实通道只允许可信来源的独立 unseen 迁移题、`SimulatedOutcome` 不能进入真实通道）；`aeh/eval_cli.py` 可运行并只报告模拟收益、真实迁移为空；`docs/evaluation-report-template.md`；`tests/test_evaluation.py`（17）。**残留**：真实 RCT/对照组、延迟保持、跨知识迁移、不良效果测量 |

CI 无新增外部服务：Python job 直接运行 stdlib 评测脚本，Node job 仍是 `npm ci`
+ `tsc --noEmit` + `node --test` + 隔离 loader 证据。

### Step 6 完成情况（受控自进化骨架，规范 §27）

状态图例同上。Step 6 是**宿主侧骨架**：它实现了候选登记、隔离评测、默认拒绝审批、
合成会话灰度、熔断与回滚、追加式审计五个环节，但**没有**生产部署通道，也没有模型
可调用的自进化工具（插件工具目录仍是六个）。所有评测与演示只用合成 fixture。

| Step 6 交付项 | 状态 | 证据 / 残留 |
|---|---|---|
| 候选生成与登记（配置/策略/提示模板的版本化变更记录） | **已完成（合成数据）** | `aeh/evolution.py` 的 `Candidate` + `CandidateRegistry` 与 `src/host/evolution.ts` 的 `Candidate` + `CandidateRegistry`：候选只能是 `config` / `policy` / `prompt_template`，带 `source` / `change_summary` / `impact_scope` / `baseline_version`，`changes` 必须是可 JSON 化的声明式数据。候选不能声明 `target_files` 或 `mutates_production`。**残留**：真实候选来源检测器（漂移/回归/成本）与 PR/变更单集成本轮未做 |
| 候选不得降低门禁/权限/隐私（protected invariants） | **已完成** | 双方模块递归拒绝 `changes` 的键名或 `impact_scope` 条目中出现课程门禁、安全门禁、权限、同意、隐私、真实-模拟隔离、observed 孪生写、自我批准、回滚权、原始学生数据、DB 写、凭据、网络、任意文件等 token（`ProtectedInvariantError`）。这些变更必须走独立治理流程（规范 §27.1）。测试：`tests/test_evolution.py`、`tests/evolution.test.ts` |
| 隔离评测（冻结评测集 + 隔离沙箱；模拟收益/真实迁移分开） | **部分** | Python 侧 `IsolatedSandbox` 直接复用 Step 5 `FrozenEvalSet` + `EvaluationProtocol`：模拟通道只能引用 train/explanation，真实通道只接受可信来源的 unseen transfer，模拟数据不能重标为真实；TypeScript 侧 `IsolatedSandbox` 接收宿主评测服务产出的分通道摘要并做同样的筛查/晋升判定。评测不通过或证据不足（无证据、模拟收益低于阈值、真实迁移低于阈值/非 unseen/来源不可信）时**自动拒绝**。**残留**：TS 侧未内置冻结集协议（由宿主评测服务提供摘要）；真实 RCT/对照组、延迟保持未做 |
| 批准（显式、带审批人/时间/理由，默认拒绝） | **已完成** | `ApprovalRecord` + `_assert_host_actor`：无审批记录、非宿主角色、`approved_by` 与操作者不一致、或候选作者自我批准都会拒绝；只有通过隔离评测的候选才能被审批。测试覆盖默认拒绝与自我批准 |
| 灰度（仅合成会话比例，带熔断与一键回滚） | **已完成（合成）** | `CanaryConditions` + `observe_canary`：canary 强制 `synthetic_only=True`，`fraction ∈ (0,1]`；样本量达到 `min_samples` 且回归或错误率超阈值时自动触发 `circuit_breaker` 并立即回滚。**残留**：真实流量分级、影子实验、监控指标接入未做 |
| 回滚（恢复上一稳定版本 + 记录事件） | **已完成（内存/合成）** | `rollback` 恢复 `baseline_version` / `previous_stable_version` 并追加 `RollbackEvent`；只允许宿主角色调用，候选不能自行回滚生产（`RollbackDeniedError`）。**残留**：真实部署/配置中心的版本切换未做 |
| 审计（候选/评测/批准/灰度/回滚全链路追加式，无原始学生数据） | **已完成（内存）** | 单一 `AuditLog` / `EvolutionAuditLog`，无更新/删除 API，递归拒绝 `answer` / `payload` / `student_name` / `trace` 等原始数据键；测试断言全链路 action 存在且不含原始数据键。**残留**：跨服务审计汇聚、保留期、防篡改存储未做 |
| 不新增模型可调用自进化工具 | **已完成** | 插件工具目录仍是六个（`tests/evolution.test.ts` 断言名字里没有 `evolution`/`approve`/`rollback`/`canary`）；审批、灰度、晋升、回滚只在 `src/host/evolution.ts` 中由宿主调用，未注册为 dsh 工具 |

Step 6 的 Python 测试为 `tests/test_evolution.py`（35），TypeScript 测试为
`tests/evolution.test.ts`（22）。两者都只用合成 fixture，且不读写任何生产路径。

### Step 7 完成情况（P1 加固：配置、输出 schema、会话状态、审计）

状态图例同上：**已完成** = 在本目录合成数据/隔离实例上实现并有测试；**部分** = 最小
模型完成，生产项未完成。Step 7 不新增模型工具（仍是六个），不接入真实学生数据。

| Step 7 交付项 | 状态 | 证据 / 残留 |
|---|---|---|
| Schemastery `Config` 替换 `normalizeConfig` 运行时校验，非法配置 fail loud | **已完成（隔离实例）** | `src/config.ts` 定义 `AEH_CONFIG_SCHEMA`（`profile`、`targetRetention ∈ (0,1)`、`allowedModes`、不透明的 `host` / `permissions`），`src/index.ts` 导出为 Cordis `Config`。Cordis 在 `apply` 前用该 schema 校验并填默认值：`root.plugin(aehPlugin, { targetRetention: 3 })` 拒绝为 `ValidationError`（`$.targetRetention expected number <= 1`），loader 路径同样不挂载任何工具（fail closed，不部分挂载）。`apply` / `AehEducationService` 仍经 `resolveAehConfig` 走同一 schema。`tests/step7.test.ts` 覆盖越界 retention、非法 profile、非法 mode、非对象配置、默认值与服务构造校验。**残留**：真实配置中心的变更审批/回滚、热重载审计 |
| 六个工具输出 schema 收紧（替换 `type: 'json'`） | **已完成（隔离实例）** | `src/output-schemas.ts` 为 `aeh_check_curriculum` / `aeh_update_hypotheses` / `aeh_select_probe` / `aeh_schedule_review` / `aeh_prepare_intervention` / `aeh_generate_report` 各定义顶层 `type: 'object'` + `additionalProperties: false` 的闭合 schema；动态 key 映射（权重、预测、`itemDecisions`）在嵌套层用 `additionalProperties: true`。dsh-tools 执行后校验返回值；`tests/step7.test.ts` 用真实 ToolRuntime 断言越界返回为 `INVALID_TOOL_OUTPUT`，并让六个工具各跑一次真实输出通过校验。**残留**：schema 版本迁移与对旧宿主的兼容策略 |
| 假设快照绑定 dsh session/agent scope，明确 TTL、隔离与清理，不写长期孪生 | **已完成（内存/合成）** | `src/host/session-state.ts` 的 `SessionSnapshotStore`：`(sessionId, agentId)` 精确绑定，跨 session/agent 读取返回 `undefined`；默认 TTL 15 分钟（可注入时钟），`sweep()` / `cleanupExpired()`、每 scope/全局限额；`endSession()` 清 session 全部 agent scope，`index.ts` 把 `session/disposed` 桥接到它并写 `session.cleanup` 审计；工具在缺少 `exec.agent.id` 时拒绝 `snapshotRef`（`snapshot_ref_requires_session_scope`）。与 `StudentTwin`/`MemoryHostTwin` 无读写路径，测试断言孪生 `version` / `evidenceRevision` 不变。**残留**：跨进程/持久化 session store、真实 dsh session 服务注入与多租户隔离 |
| 追加式审计：门禁拒绝原因、工具调用、审批与交付回执；不记原始题目/答案/图片；指标带学生/租户维度但不可反识别 | **已完成（内存/合成）** | `src/host/audit-log.ts` 的 `AehAuditLog`：append-only（无 update/delete，容量满 fail loud），记录 `gate.decision`（原因码）、`tool.call`（只记工具名与结果，不记参数）、`approval.record`、`delivery.receipt`、`session.cleanup`；`detail` 仅标量/标量数组并递归拒绝 `answer`/`question`/`image`/`payload`/`prompt`/`trace`/`studentName` 等键；`studentKey`/`tenantKey` 是 `sha256(salt, tenantRef, ref)` 伪名，`metrics()` 只出计数与伪名 key。`ApprovalLedger` / `HostDeliveryAdapter` 接受可选 audit，重放不重复计数。`tests/step7.test.ts` 覆盖。**残留**：防篡改/WORM 存储、跨服务汇聚与保留期、真实 KMS 管理的 salt（当前默认每进程随机，文档明确伪名化≠匿名化） |
| 不新增模型可调用工具 | **已完成** | 插件工具目录仍是六个；审计与 session store 不是 dsh 工具，审批/交付回执只由宿主侧 `ApprovalLedger` / `HostDeliveryAdapter` 写入 |

Step 7 的 TypeScript 测试为 `tests/step7.test.ts`（23），步骤完成时全量
`node --test tests/*.test.ts` 为 93 通过、`python3 -m unittest discover -s tests -v`
为 220 通过（Step 7 未新增 Python 测试，Step 1–6 行为未改）、`tsc --noEmit` 通过、
`npm run evidence:loader` 仍成功。

### Step 8 完成情况（工具入口安全加固）

状态图例同上：**已完成** = 在本目录合成数据/隔离实例上实现并有测试；**部分** = 最小
模型完成，生产项未完成。Step 8 不新增模型工具（仍是六个），不改 `aeh/` 的 Python
行为，不接入真实学生数据，不把插件加载进运行中的 dsh 会话。

| Step 8 交付项 | 状态 | 证据 / 残留 |
|---|---|---|
| 提示注入防护（工具参数中的指令式文本不得改变决策，fail-closed 并记入审计） | **已完成（合成数据/隔离实例）** | `src/security.ts` 的 `INJECTION_PATTERNS` 覆盖中英文的 prompt 覆盖、角色冒充、门禁覆盖、权限提升、受众变更、审批绕过、密钥套取；`SecurityGuard.assertArgumentSafety` 递归扫描字符串与键名，命中即抛 `AEH_INJECTION_REJECTED`。`tests/security.test.ts` 覆盖英文/中文/受众/审批注入、拒绝后下一次合法调用决策不变、以及真实 dsh `ToolRuntime` 把错误映射为 `info.code = AEH_INJECTION_REJECTED`；`npm run evidence:loader` 也记录该 code。审计只记 `instruction_pattern:<category>` + 路径，不记原文。**残留**：对抗性变体（同形字、编码混淆、多轮外泄）需要持续规则/模型侧防御与红队 |
| 越权防护（伪造进度/标注/scope/studentRef 不通过 host 解析，越权参数 fail-closed） | **已完成（合成数据）** | 进度/标注/scope 仍只由 `HostContext` 解析；`security.test.ts` 断言伪造标量标注不能让未知 item 通过门禁、另一学生 `studentRef` 得到 `progress_unavailable`、无宿主时内联 progress 仍拒绝、报告 scope 只能收窄且跨学生事件被排除。`SecurityGuard` 额外拒绝冒充宿主决策对象的参数键（`gateOverride`/`permissions`/`studentRawData`/`audienceOverride`/`approvalId` 等）为 `AEH_UNAUTHORIZED_ARGUMENT`。**残留**：真实身份/同意网关与跨租户隔离仍属宿主职责 |
| 超大 payload 拒绝（超过配置上限的参数/数组/字符串结构化拒绝） | **已完成（合成数据）** | `src/security.ts` 递归限制字符串/数组/对象键/深度/总序列化字节与循环引用；`AEH_PAYLOAD_TOO_LARGE` 带 `payload_too_large:<kind>`，错误不回显原值。上限经 `config.ts` 的 Schemastery `security.limits` 校验并在 `apply` 前 fail loud。`tests/security.test.ts` 覆盖字符串/数组/键数/深度/字节与默认上限放行。**残留**：按工具/租户差异化配额与流式大对象处理未做 |
| 速率限制（按 session 与 studentRef 限流，超限结构化拒绝且不影响其他会话） | **已完成（单实例内存）** | `SecurityGuard` 用两个固定窗口分别按 dsh session/agent scope 与 `studentRef` 计数，超限抛 `AEH_RATE_LIMITED`。`tests/security.test.ts` 断言 session A 超限后 session B 正常、同一学生跨 session 限流、不同学生互不影响、窗口过期恢复。**残留**：跨进程/跨副本分布式限流与真实 dsh 会话级配额未做 |
| 错误与日志脱敏（错误不泄露路径/配置/原始数据；审计不含题目/答案/图片/密钥） | **已完成（合成数据）** | 工具错误在离开 body 前由 `redactThrown` 去掉绝对路径、`file://` URL 与密钥样式 token 并压平换行；`AehAuditLog` 继续只接收标量/原因码并递归拒绝原始数据键，工具审计从不记录参数。`tests/security.test.ts` 断言注入调用的审计序列化中不含注入原文、密钥、`studentRef` 原文，并断言 `redactMessage`/`redactThrown` 行为。**残留**：真实日志汇聚、保留期与防篡改存储仍属宿主实现 |

Step 8 的 TypeScript 测试为 `tests/security.test.ts`（19），步骤完成时全量
`node --test tests/*.test.ts` 为 112 通过、`python3 -m unittest discover -s tests -v`
为 220 通过（Step 8 未新增 Python 测试，未改 Step 1–7 行为）、`tsc --noEmit` 通过、
`npm run evidence:loader` 仍成功并新增注入拒绝证据。

### Step 9 完成情况（课程图谱与题库，规范 §3）

状态图例同上：**已完成** = 在本目录合成数据/隔离实例上实现并有测试；**部分** = 最小
模型完成，生产项未完成。Step 9 不新增模型工具（仍是六个），不改运行用 dsh，不接入
真实学生数据，题库不保存真实题干/答案/提示/图片。

| Step 9 交付项 | 状态 | 证据 / 残留 |
|---|---|---|
| KC 图节点/边/前置关系、非法图拒绝 | **已完成（合成数据）** | `aeh/curriculum_graph.py` 与 `src/core/curriculum-graph.ts` 的 `KnowledgeGraph`：approved `REQUIRES`/`PART_OF` 环、自环、重复节点/边、未知端点/关系/状态、confidence 越界全部拒绝；`tests/test_curriculum_graph.py` 与 `tests/curriculum-graph.test.ts` 覆盖。**残留**：真实教材/课标导入、图数据库、跨租户图隔离 |
| 前置闭包查询与版本化 | **已完成（合成数据）** | `prerequisiteClosure()`、`topologicalOrder()`、`KnowledgeGraphStore`（append-only、版本递增、SHA-256 内容摘要、`diff`）。共享 fixture 在 Python/TS 上哈希、闭包、拓扑序完全一致。**残留**：图变更审批/回滚工作流、生产版本存储 |
| proposed 边不自动成为正式先修 | **已完成** | 只有 `status="approved"` 的 `REQUIRES` 进入闭包；`proposed` 边保留但不算先修、不触发 approved 环拒绝。测试覆盖。**残留**：真实专家/统计关系审核流水线 |
| 题库 item + 标注 + 版本 + 审核状态 | **已完成（合成数据）** | `ItemAnnotation` 覆盖 source/license/stage/course/KC/Q-matrix/难度/题型/时长/verifier/安全/内容/正确性/置信度等；`ItemBank` 版本历史不可变、修订递增版本并重置 `draft`、审核记录追加（submit/approve/reject/request_changes）、approve 前检查标注完整。**残留**：真实教师审核身份/权限、真实题目内容与版权/安全审核、生产题库服务 |
| 标注缺失或低置信度时门禁 fail-closed | **已完成** | 缺失标注映射为 `annotationsComplete=false`，门禁以 `incomplete_annotations` 拒绝；已批准但低置信度仍以 `low_annotation_confidence` 拒绝。测试覆盖。**残留**：无 |
| 本地内存 RAG：按 KC/难度/题型检索，返回 opaque id + 标注摘要 | **已完成（合成/内存）** | `ItemBank.search()` 只索引当前 approved 版本，确定性整数评分与稳定排序；`RetrievalHit` 只有 opaque `itemId` 与标注摘要，无题干/答案/提示/解法字段。**残留**：BM25/向量/交叉编码重排、真实文档索引、大规模索引与缓存 |
| 检索结果必须再过课程门禁；前置未满足不得交付 | **已完成** | Python `plan_retrieval()` 与 TS `planRetrieval()`/`retrieveCandidatesFor()` 对每个命中重新解析、跑 `allow()`、检查传递前置闭包；只有两者都通过才进入 `candidates`。前置未满足、未知 KC、缺失图、未知 item 全部拒绝。**残留**：把候选接入真实交付 UI/LMS 与宿主审批流 |
| 宿主解析仍走 HostContext | **已完成（隔离实例）** | `HostContext.resolveGraph()`/`retrieveItems()` 可选；`MemoryHostContext` 注入宿主 `graph`/`itemBank`，同意撤回后全部不可读；`toHostBinding()` 保留闭包。测试覆盖服务层检索与 loader copy 路径。**残留**：生产身份/同意网关与真实多租户会话 |
| Python/TS 测试与 `tsc --noEmit` | **已完成** | Python 242 通过（新增 22）；Node 131 通过（新增 19）；`npm run typecheck` 通过；`npm run evidence:loader` 仍在独立隔离实例成功（工具目录仍为六个）。**残留**：无 |

### Step 10 完成情况（习题演化与动态模拟实验室，规范 §9、§11）

状态图例同上：**已完成** = 在本目录合成数据/隔离实例上实现并有测试；**部分** = 最小
模型完成，生产项未完成。Step 10 不新增模型工具（仍是六个），不改运行用 dsh，不接入
真实学生数据，演化不生成题干/答案/提示/图片文本。

| Step 10 交付项 | 状态 | 证据 / 残留 |
|---|---|---|
| 五种演化算子（数值/情境/干扰项/难度/诊断指向性）且候选带来源/变更/受影响 KC | **已完成（合成数据）** | `aeh/exercise_evolution.py` 与 `src/core/exercise-evolution.ts` 的 `applyOperator()`：`numeric`/`context`/`distractor`/`difficulty`/`diagnostic`，只改结构化标注与受控参数；`distractor` 仅限 `multiple_choice`。候选 `provenance` 含来源 item/版本、`changes`、`affectedKcs`、seed、生成器版本；`candidate_id`/`proposed_item_id` 确定性生成。**残留**：真实内容库/题型模板、真实题干/答案/图片生成与版权/安全审核 |
| 每个演化候选先过课程门禁与前置闭包，再进隔离沙箱 | **已完成** | `ExerciseEvolutionEngine.validate()` 复用 `allow()` 并检查缺失标注、缺失图与传递前置闭包；未授/超前 KC、低进度置信度、缺失前置、未知 KC、标注不完整、缺图全部 fail-closed，门禁拒绝的候选 `sandboxVerdict=null`。**残留**：真实教师审核工作流接入 |
| 候选进入候选池不能绕过沙箱筛查或题库审核 | **已完成** | `EvolutionCandidatePool.admit()` 要求沙箱筛查通过、item-bank 同一 `proposed_item_id` 且 `reviewStatus="approved"`、`observedWrites==0`；否则抛 `CandidatePoolError`。测试覆盖“未批准拒绝”“门禁拒绝不产生沙箱结果”。**残留**：生产题库服务与审批后台 |
| 模拟会话隔离：独立状态、独立假设快照、事件不写 observed | **已完成** | `SimulationSession` 从快照构造私有 `HypothesisSet`（reweight 不改源假设）；`SimulationEventLog` 只接受 `simulated`/`virtual_student`/`simulation`，真实来源抛 `SimulationIsolationError`；`observedWrites` 恒为 0，`SimulationResult.realTransfer` 恒为 `null`。**残留**：跨进程模拟调度与持久化 |
| 实验配置与结果可用 seed/版本/摘要复现 | **已完成** | `SimulationConfig` 与 `HypothesisSnapshot` 做 canonical JSON 内容寻址；结果指纹只对整数微单位与逐步 `phase/item/hypothesis/correct` 计算；共享 `mulberry32`/FNV-1a 32/`jsRound`/`round4`/`quantizeMicros`。共享 fixture 上 Python/TS 指纹、会话 id、逐步结果逐字节一致。**残留**：真实硬件/分布式复现环境 |
| 模拟收益与真实迁移分开报告，模拟不能自证真实效果 | **已完成** | `simulatedBenefit.is_causal_evidence=false`；真实迁移只来自冻结 unseen 迁移集与可信来源，且 `causalClaimSupported=false`、`promotionReady` 需真实迁移证据。TS 侧内联实现真实通道（无 TS 评测模块）。**残留**：真实对照/延迟保持迁移实验与真实学生行为校准 |
| Python/TS 测试与 `tsc --noEmit` | **已完成** | Python 290 通过（新增 48）；Node 152 通过（新增 21）；`npm run typecheck` 通过；`npm run evidence:loader` 仍在独立隔离实例成功（工具目录仍为六个）。**残留**：无 |

### Step 11 完成情况（FSRS 参数校准，规范 §8）

状态图例同上：**已完成** = 在本目录合成数据/隔离实例上实现并有测试；**部分** = 最小
模型完成，生产项未完成。Step 11 不新增模型工具（仍是六个），不改运行用 dsh，不接入
真实学生数据；校准只产生参数候选，激活只返回冻结配置对象，**绝不**写掌握度或孪生。

| Step 11 交付项 | 状态 | 证据 / 残留 |
|---|---|---|
| 从合成作答序列拟合 FSRS 参数（stability/difficulty/retrievability） | **已完成（合成数据）** | `aeh/fsrs_calibration.py` 与 `src/core/fsrs-calibration.ts`：示意曲线 `R=(1+19/81·t/S_eff)^(-1/2)`，`S_eff=max(0.4,S·(10-D)/5)`；拟合 6 维动力学向量，含先验/边界/ridge 收缩。**残留**：真实版本/人群数据、真实遗忘曲线与优化器替换、生产参数注册表 |
| 可复现（seed、数据版本、参数版本、配置指纹） | **已完成** | `CalibrationConfig.as_dict()/fingerprint()`、`CalibrationDataset.digest()`、`CalibrationReport.fingerprint()` 全部 canonical JSON 内容寻址；相同 seed/配置/数据得到相同指纹，改 seed 只改 bootstrap 区间不改点估计。**残留**：跨机器/跨版本可复现性声明与数据集快照托管 |
| 结果带不确定性 + 适用性声明 | **已完成** | bootstrap（共享 `mulberry32`）给出每个参数的 `ciLow/ciHigh` 与 `identified()`，Brier 区间、ECE、log loss、10 个可靠性分箱；`Applicability` 声明 scope/观测数/elapsed 范围/独立与提示观测/`evidenceSufficient`/out-of-scope。**残留**：真实保留期/人群漂移监控与重校准触发 |
| 校准不直接改真实掌握度，只产参数候选 | **已完成** | `CalibrationService.propose_candidate()` 只生成声明式 `Candidate`（`kind="config"`、基线 `fsrs_illustrative_19_81`、`changes.parameters`）；`PRODUCTION_MUTATION_ENABLED=False`。**残留**：生产配置中心写入适配器（当前仅内存冻结对象） |
| 先隔离评测 + 显式批准才生效 | **已完成** | `CalibrationActivationGate`：不相交合成 held-out 评测 → 通过才可 `evaluate`；`approve` 默认拒绝、禁止自批、要求宿主角色；`activate` 需已批准，返回冻结配置；`rollback` 回到上一稳定版本。**残留**：真实 held-out 冻结集、真实审批后台与持久审计存储 |
| 模拟收益与真实迁移分开报告 | **已完成** | `simulatedBenefit.isCausalEvidence=false`；真实迁移通道只接受可信来源与 unseen 题项；无真实证据时 `promotion_blocked:real_transfer_evidence_missing`，`promotionReady=false`；`CalibrationEvaluation` 构造期即禁止把模拟/真实标成因果。**残留**：真实对照/延迟保持迁移实验与真实学生行为校准 |
| Python/TS 双实现行为一致，共享 fixture 数值一致 | **已完成** | 共享 `tests/fixtures/fsrs_calibration_step11.json`：`datasetDigest`/`configFingerprint`/`reportFingerprint`/参数/估计/`metrics`/`applicability` 逐字节一致；拟合路径只用 `+ - * / sqrt`。**残留**：无 |
| Python/TS 测试与 `tsc --noEmit` | **已完成** | Python 340 通过（新增 50）；Node 198 通过（新增 46）；`npm run typecheck` 通过；`npm run evidence:loader` 仍在独立隔离实例成功（工具目录仍为六个）。**残留**：无 |

### Step 12 完成情况（长期孪生体生命周期，规范 §5）

状态图例同上。Step 12 不新增模型工具（仍是六个），不改运行用 dsh，不接入真实学生
数据；所有事件、观测、参数与假设都是合成内容。长期孪生的 checkpoint、校准审批与
假设 binding 目前只在内存中，真实持久化/跨进程并发未做。

| Step 12 交付项 | 状态 | 证据 / 残留 |
|---|---|---|
| 事件溯源全生命周期：append / version / checkpoint / rollback / replay | **已完成** | `aeh/twin.py` 与 `src/core/twin.ts`：真实事件 append-only，推断步统一日志并产生 `version`；`TwinCheckpoint`/`asDict()`、`restore_checkpoint()`/`rollback()`/`replay()` 只回退推断状态，真实证据与 `evidence_revision` 不变；重放重新校验证据 id。**残留**：checkpoint 与事件日志的生产持久化、跨进程并发与保留期 |
| 观察 / 模拟严格隔离扩展到记忆与假设 | **已完成** | `record_memory_review()`、`bind_hypotheses()`、`evolve_hypotheses()` 只接受 observed cursor 中存在的 id；模拟 id 无法提供证据；`promote_simulated()` 永远 fail closed。**残留**：无（合成范围内） |
| 多 KC 长期记忆：FSRS stability/difficulty 随时间衰减 + 复习更新 | **已完成（合成数据）** | `MemoryParameters`（6 参数 + version，默认等于旧示意公式）、参数化 `update_memory()`、`apply_forgetting()`、`memory_health()`/`aggregate_memory()`；逾期只提高不确定性并标记 `needs_calibration`，绝不降低 stability/difficulty。**残留**：真实保持/遗忘数据、生产 FSRS 版本与参数注册表 |
| Step 11 校准参数作为候选挂起，显式批准后才生效 | **已完成** | `propose_memory_calibration()` / `propose_memory_calibration_from_candidate()` 只挂起；`activate_memory_calibration()` 要求非空 approval id + actor，否则 `CalibrationApprovalRequired`；激活只切换后续 review 的参数版本，`rollback_memory_calibration()` 从截断日志重新推导生效参数。**残留**：真实审批后台、生产配置热切换、持久审计 |
| 假设集随证据演化并绑定孪生版本 | **已完成** | `HypothesisSet.revision/bind_twin_version/prune_weak/clone`；`bind_hypotheses()` 与 `evolve_hypotheses()` 支持 spawn/split/reweight/merge/prune，在 clone 上执行并绑定新 twin version；回滚恢复绑定集合与 revision。**残留**：跨会话假设集持久化与真实候选来源 |
| Python/TS 双实现行为一致，共享 fixture | **已完成** | 共享 `tests/fixtures/twin_step12.json`：checkpoint 的 version/evidenceRevision/knowledge/memory/hypothesisRevision/hypothesisWeights/observedEvidenceIds/参数版本逐值一致；两侧 ISO 时间戳拼写不同，fixture 不比较时间字段。**残留**：无（合成范围内） |
| Python/TS 测试与 `tsc --noEmit` | **已完成** | Python 391 通过（Step 12 新增 51）；Node 222 通过（新增 24）；`npm run typecheck` 通过；`npm run evidence:loader` 仍在独立隔离实例成功（工具目录仍为六个）。**残留**：无 |


### Step 13 完成情况（虚拟学生群完整实现，规范 §6 / §19.3）

状态图例同上。Step 13 不新增模型工具（仍是六个），不改运行用 dsh，不接入真实学生
数据；假设、观测与快照都是合成内容。生成/匹配/分裂/合并/淘汰规则、保真度指标、
unknown 桶与会话快照边界都在 Python 与 TypeScript 双实现内完成并共享 fixture。

| Step 13 交付项 | 状态 | 证据 / 残留 |
|---|---|---|
| 生成规则：证据约束的 spawn/generate + 触发条件 | **已完成** | `spawn(..., trigger=...)` 记录 `SPAWN_*`；`generate()` 只在阈值以上无解释且 `min_gain` 达标时生成；`resample` 仍保留。**残留**：真实“新题型/冲突证据”检测器与 LLM 生成候选接入 |
| 匹配规则：行为似然 + 带噪声后验 | **已完成** | `HypothesisSet.match()`（两侧）：按 `predicted_observable_behaviors` 算 Bernoulli 似然、smoothing、匹配统计，返回 `unexplainedBehaviors`；更新仍走 `reweight` 噪声项。**残留**：真实步骤级似然模型与概率校准 |
| 分裂规则：可区分才分裂 | **已完成** | `split_distinguishable()` / `splitDistinguishable()`：子代相似度 > 阈值即拒绝，父假设保持 active。**残留**：真实诊断题的区分性来自 `diagnosis.py`，本步只提供集合侧规则 |
| 合并规则：不可区分才合并、保留来源 | **已完成** | `merge_indistinguishable()` / `mergeIndistinguishable()`：连通分量合并、`merged_from` 保留、规则并集、行为均值。**残留**：无（合成范围内） |
| 淘汰规则：弱、矛盾、无独特解释力 | **已完成** | `prune_weak` / `prune_contradicted`（≥min_matches 的均值似然）/ `prune_uninformative`；质量只进 `unknown`。**残留**：长期真实证据驱动的归档与恢复策略 |
| unknown 桶管理 | **已完成** | `set_unknown`、`request_real_evidence`、`resolve_evidence_request`、`unknown_reasons`、`needs_real_evidence`；unknown 领先时自动请求真实证据。**残留**：无（合成范围内） |
| 假设保真度指标（§19.3） | **已完成（合成数据）** | `fidelity()`：Brier / log loss / ECE / accuracy / coverage / unknown 占比 / 有效假设数 / 最大权重 / 错误类型·步骤·策略一致率 / `anti_mismatch`；不可计算处返回 `None`。**残留**：真实留出步骤、真实教师根因标签与真实人群校准 |
| 假设快照的会话隔离与持久化边界 | **已完成（内存）** | `to_snapshot`/`from_snapshot` + `HypothesisSnapshotStore`（session/agent scope、TTL、容量、跨会话 fail-closed），`persists_to_long_term_twin=false`，`persist_to_twin()` 永远抛错。**残留**：跨进程/持久化 session store、真实 dsh session 服务注入 |
| Python/TS 双实现行为一致，共享 fixture | **已完成** | 共享 `tests/fixtures/hypothesis_step13.json`：初始权重、相似度、匹配似然/后验、generate/split/merge/prune 结果、fidelity 指标、快照权重逐值一致。**残留**：无（合成范围内） |
| Python/TS 测试与 `tsc --noEmit` | **已完成** | Python 421 通过（Step 13 新增 30）；Node 252 通过（新增 30）；`npm run typecheck` 通过；`npm run evidence:loader` 仍在独立隔离实例成功（工具目录仍为六个）。**残留**：无 |
| 规则层暴露为工具操作 | **未完成** | `generate` / `match` / `fidelity` / `merge_indistinguishable` 等目前只在核心模块可用；`aeh_update_hypotheses` 仍只有 spawn/split/merge/prune/reweight/snapshot，避免改变六个闭合输出 schema。**需要**：schema 版本迁移与审批后再扩展工具面 |


### Step 14 完成情况（主动诊断与反向溯源完整实现，规范 §7）

状态图例同上。Step 14 不新增模型工具（仍是六个），不改运行用 dsh，不接入真实学生
数据；错误规则图、步骤、候选与作答都是合成内容。反向溯源、信息增益、诊断会话状态机
与负担上限在 Python 与 TypeScript 双实现内完成并共享 fixture。

| Step 14 交付项 | 状态 | 证据 / 残留 |
|---|---|---|
| 反向溯源 Observe→Localize→Expand | **已完成（合成）** | `order_steps`/`orderSteps` 稳定拓扑排序，`localize_first_deviation`/`localizeFirstDeviation` 定位首个偏离；`trace_backward`/`traceBackward` 展开误解、先修规则/KC 缺口与 slip，孤立错误提升 slip 先验、已做对的上游按 `contradiction_decay` 降权，结果含归一化权重与显式 `unknown`，`to_hypotheses`/`traceToHypotheses` 可转成假设。**残留**：真实步骤解析/符号推理、真实教师根因标签 |
| 信息增益计算 | **已完成** | 原 `IG + α·teaching − β·time − γ·risk − δ·load` 增加 `ζ·predictive_uncertainty`（预测作答正确事件的伯努利熵）；`ProbeSelection` 增加 `answerUncertainty` 分解。**残留**：真实步骤级似然与概率校准 |
| 诊断会话状态机（出题—作答—更新—终止条件） | **已完成（内存）** | `DiagnosisSession` 状态 `idle/awaiting_answer/updated/terminated`；非法转移抛 `DiagnosisStateError`；`should_terminate`/`shouldTerminate` 给出确定性原因（跳过/显式、题数、时长、负担、置信度、熵、无可用题），`unknown` 领先时禁止判定“已解决”；记录 transition 历史与实际信息增益。**残留**：跨进程持久化、真实 dsh session 服务注入 |
| 学生跳过与负担上限 | **已完成** | `skip()` 随时终止且不强制出题；`BurdenBudget{max_questions,max_total_minutes,max_total_load}` 与 `BurdenState` 累计题数/时长/认知负担，`max_questions=0` 拒绝开始。**残留**：按学生/时段的生产配额与跨会话预算 |
| Python/TS 双实现行为一致，共享 fixture | **已完成** | `tests/fixtures/diagnosis_step14.json`（合成）由两侧测试读取，对首次偏离、解释集合与权重、逐候选 IG/不确定度/分数、选中项、会话状态序列、终止原因与负担逐值一致。**残留**：无（合成范围内） |
| 工具面 | **未完成（有意）** | 仍是六个工具；`aeh_select_probe` 新增 `answerUncertainty` 输出与可选 `zeta` 输入，但反向溯源、状态机、负担上限未暴露为工具操作。**需要**：输出 schema 版本迁移与审批 |
| Python/TS 测试与 `tsc --noEmit` | **已完成** | Python 463 通过（Step 14 新增 42）；Node 283 通过（新增 31）；`npm run typecheck` 通过；`npm run evidence:loader` 仍在独立隔离实例成功（工具目录仍为六个）。**残留**：无 |


### Step 15 完成情况（教学策略、日常协同、跨学科与学习科学，规范 §10 / §17 / §18）

状态图例同上。Step 15 不新增模型工具（仍是六个），不改运行用 dsh，不接入真实学生
数据；所有 KC、日程、证据、题目与学科示例均为合成内容。策略层只做“下一步做什么”的
选择与计划，任何实际题目仍必须经过课程门禁，宿主交付仍需审批。

| Step 15 交付项 | 状态 | 证据 / 残留 |
|---|---|---|
| 教学策略路由器（§10.1） | **已完成（合成）** | `select_strategy` / `selectStrategy` 覆盖九个规范动作：诊断题、最小提示、示范例题、微课、定向练习、迁移任务、间隔复习、进度确认、直接回答。决策包含 `targetKcs`、`methodIds`、分钟数、理由、护栏、`requiresConfirmation`、`blocked`，并始终带 `deliveryRequiresGate=true`。**残留**：真实教师/内容库的任务意图与策略效果校准 |
| 策略选择规则与护栏 | **已完成（fail-closed）** | 规则优先级固定：证据来源/模拟隔离 → 考试诚信 → 时间预算 → 学校进度确认 → 考试范围确认 → 预习范围 → 显式求助/时间压力 → 假设冲突 → 先修/误解/程序错误/迁移/复习。护栏覆盖未确认进度、未确认预习、未确认考试范围、评估进行中、零预算、直接回答关闭、模拟证据不得驱动生产决策。**残留**：生产身份/同意网关与真实学生日程 |
| 日常协同流程（§10.2） | **已完成（合成）** | `plan_daily_coordination` / `planDailyCoordination` 输出 `preview → school → ai_reinforcement → review` 四阶段；学校阶段固定 0 AI 分钟、`no_action`、`school_time_not_monitored`，不推断课堂掌握。预习只在“下一课确认 + 预习范围确认 + 进度可用”时解锁。**残留**：真实校历/作业系统接入；课堂同步资料未实现 |
| 动态时间分配（§10.3） | **已完成** | 按预习需求、先修缺口、学校压力、考试压力、复习积压动态分配，总分钟数不超过学习者预算；按 `maxBlockMinutes` 计算休息次数，按 `breakPreference` 计算休息分钟；零预算/评估中直接阻断。**残留**：真实疲劳信号与跨日预算 |
| 跨学科适配层（§17） | **已完成（两个示例）** | `SubjectAdapter` 共享 KC 前缀、证据种类、验证器、必需证据、策略亲和度与高风险 KC 前缀；`MathSubjectAdapter`（步骤等价/CAS）与 `PhysicsSubjectAdapter`（单位/量纲/受力图/高风险电学）为两个示例。适配失败（不支持的 KC、证据种类、未验证证据）fail-closed；高风险 KC 标记 `safetyRequired`。**残留**：化学、编程、语言、专科实践课适配器；真实学科验证服务与专业监管流程 |
| 学习科学方法映射（§18） | **已完成（映射 + 3 个可执行计划）** | `LEARNING_SCIENCE_METHODS` 覆盖规范表 16 种方法，每种含动作、使用条件、实现、验证与护栏；**检索练习、间隔、交错**有可执行计划：`plan_retrieval_practice`（先作答、无答案预览、提示后正确不算独立检索）、`plan_spaced_review`（按当前可提取性排序、由 stability 反解间隔）、`plan_interleaved_practice`（基础理解门槛、尽量不连续同 KC、确定性分块）。其余 13 种标注为 `mapped`，不宣称已自动执行。**残留**：示范例题/渐隐支架/自我解释等尚无独立执行器；真实延迟保持与策略选择率验证 |
| Python/TS 双实现与共享 fixture | **已完成** | `tests/fixtures/teaching_strategy_step15.json`（合成）由 `tests/test_teaching_strategy.py` 与 `dsh-plugin/tests/teaching-strategy-step15.test.ts` 读取，对策略动作/目标/方法/时长/护栏、日常阶段与预算、检索/间隔/交错序列、学科适配与证据拒绝逐值一致。**残留**：无（合成范围内） |
| 工具面 | **未完成（有意）** | 仍是六个工具；策略路由、日常计划、学习科学计划与学科适配只在核心/宿主 API 可用，未暴露为模型工具，避免输出 schema 版本迁移和把策略层变成可自由调用的全权工具。**需要**：schema 版本迁移、审批与宿主编排设计 |
| Python/TS 测试与 `tsc --noEmit` | **已完成** | Python 517 通过（Step 15 新增 54）；Node 337 通过（新增 54）；`npm run typecheck` 通过；`npm run evidence:loader` 仍在独立隔离实例成功（工具目录仍为六个）。**残留**：无 |

### Step 16 完成情况（数据模型、存储服务与 Harness 状态机，规范 §12 / §13 / §15.3）

状态图例同上。Step 16 仍是核心/宿主 API 层的工作，**不新增模型工具**（工具目录仍为
六个），不接入真实学生数据，不修改运行中的 dsh，也不读写 `~/.dsh/`。Python 与
TypeScript 共享 `tests/fixtures/services_step16.json`（合成）验证行为一致。

| Step 16 交付项 | 状态 | 证据 / 残留 |
|---|---|---|
| 事件存储边界（§13.1 / §22.1） | **已完成（内存 + 文件）** | `EventDraft` / `LearningEvent` / `AppendResult` + `EventStore` 抽象；`InMemoryEventStore` 与 `FileEventStore`（JSONL append-only）。信封含 event/stream/type/source/occurred_at/sequence/idempotency_key/session/provenance/payload/schema_version。文件实现重开时校验每条记录的 SHA-256 内容摘要，篡改或混入其他 domain 会抛 `IntegrityError`。**残留**：单机单进程模型，无跨进程锁、加密、保留期与压缩 |
| 乐观并发与幂等键 | **已完成** | `append(draft, expected_version=...)` 在版本不匹配时抛 `OptimisticConcurrencyError`；同一 `(stream, idempotency_key)` 重放返回原事件（`deduplicated=True`，sequence 不变），但类型/时间/来源/payload 不一致时抛 `IdempotencyConflictError`。event_id 由 `stream + key` 稳定派生。**残留**：键的回收/过期策略未做 |
| observed / simulated 存储域隔离 | **已完成（fail-closed）** | 两个独立 store/文件；observed store 拒绝 simulated 来源与 `SIMULATION_STARTED/COMPLETED` 事件，simulated store 拒绝 observed 来源。隔离在写入前检查，不依赖调用方。**残留**：生产环境需要独立数据库/租户与审计级隔离 |
| Profile / Bundle 存储（§13） | **已完成（内存 + 文件）** | `StudentProfile`（stage、guardian_consent、settings、version）与 `ProfileStore.create/get/update`，更新必须带 `expected_version`。`ProfileBundle` 冻结 `student_ref + twin_version + school_progress_version + content_version + created_at` 的内容寻址摘要；同 id 同摘要幂等，同 id 不同摘要抛 `ConflictError`。**残留**：读取时的一致性快照/跨服务事务未做 |
| 内容库服务（§13） | **已完成（review-gated）** | `ContentRecord` 按 contentId 版本化，含 kcIds、difficulty、reviewState（`draft/approved/retired`）与内容摘要；`put` 带 `expected_version`，同内容重放幂等、旧版本重放返回当前版本、陈旧写入抛冲突。`retrieve` 只返回 `approved`，按 KC + 可选难度过滤并稳定排序，默认上限 10；无批准内容时返回空而不是猜测。**残留**：真实内容仓库、版权/授权元数据与审核工作流 |
| 评测服务（§15 / §19） | **已完成（隔离 + 防自证）** | `FrozenEvalSet` 不可变、内容寻址、要求 train 与 unseen transfer，transfer 不得 `seen_before`；`EvaluationService` 冻结数据集并执行隔离评测：模拟只能走 train/explanation，真实迁移只接受可信来源（`trusted_grader` 等）、transfer 分片、unseen 且独立作答；模拟数据重标为真实证据抛 `SelfProofError`。运行结果幂等（同 key 同输入返回同一 run，不同输入抛冲突），显式保存 claim / self_proof_guard / limitations；无真实证据时明确写“no real transfer evidence”。**残留**：TypeScript 侧是评测协议的最小镜像（完整协议仍在 `aeh/evaluation.py`），无生产评测数据仓库与统计功效分析 |
| 写入协调 | **已完成（进程内）** | `WriteCoordinator.recall/remember/run_once` 按 `(stream, idempotency_key)` 记忆化，重复操作只执行一次；事件存储自身再做幂等兜底。**残留**：TypeScript 单线程事件循环下没有 OS 级锁；跨进程写协调需要数据库唯一约束或分布式锁 |
| Harness 状态机（§12.2） | **已完成（23 状态）** | `HarnessStateMachine` 覆盖规范全部 23 个状态与正常转移；终态 fail-closed（`Completed/Failed/Aborted` 不可再转移）；`advance` 支持幂等键与冲突检测；`.snapshot()` 只含状态、转移理由、退化记录与计数，不含学生作答内容。**残留**：真实 agent 编排、工具调用重试与检查点恢复 |
| 异常/退化分支（§15.3） | **已完成（12 条）** | `EXCEPTION_BRANCHES` 把规范失败/退化表映射为 12 个分支：OCR 不确定、符号验证不确定、RAG 缺来源、学校进度不明、假设全不匹配、模拟超时、记忆数据稀疏、策略低置信、学生拒绝诊断、异常压力、课程门禁拒绝、内容拒绝。分支带目标状态、退化模式与说明；`rag_source_missing` / `low_confidence_strategy` / `abnormal_pressure` 原地退化不改状态，其余按目标重路由（跨正常边时显式允许）。未知分支抛 `ValidationError`。**残留**：真实监控指标与自动降级阈值 |
| 有界返工循环 | **已完成** | `register_rejection` 在 `max_rejections`（默认 3）内回到 `ExerciseEvolution`；第 4 次拒绝转 `Failed` 并记录 `rework_budget_exhausted`，不会无限循环。**残留**：预算应按任务/学生配置而非全局常量 |
| Python/TS 双实现与共享 fixture | **已完成** | `tests/fixtures/services_step16.json` 由 `tests/test_services_step16.py`（66 个）与 `dsh-plugin/tests/services-step16.test.ts`（64 个）读取，对 append/幂等/并发冲突、Profile/Bundle、内容检索、评测均值/增益/真实准确率/来源/claim、状态机脚本/拒绝上限/异常目标逐值一致。**残留**：跨语言摘要算法对非 ASCII 的字节级一致性未单独断言 |
| 工具面 | **未完成（有意）** | 仍是六个工具；服务与状态机只在核心/宿主 API 可用。**需要**：输出 schema 版本迁移、审批/审计接入与宿主编排设计 |
| Python/TS 测试与 `tsc --noEmit` | **已完成** | Python 583 通过（Step 16 新增 66）；Node 401 通过（新增 64）；`npm run typecheck` 通过；`npm run evidence:loader` 仍在独立隔离实例成功（工具目录仍为六个）。**残留**：无（合成范围内） |

### Step 17 完成情况（隐私、安全、未成年人保护与指标面板，规范 §20 / §21）

状态图例同上。Step 17 仍是核心 API 层的工作，**不新增模型工具**（工具目录仍为六个），不接入真实学生数据，不修改运行中的 dsh，也不读写 `~/.dsh/`。Python 与 TypeScript 共享 `tests/fixtures/privacy_step17.json`（合成）验证行为一致。

| Step 17 交付项 | 状态 | 证据 / 残留 |
|---|---|---|
| 同意账本（§21） | **已完成** | `ConsentEvent` / `ConsentLedger` 追加式账本：grant/revoke 永不覆盖历史，重复 consent_id、未知 scope/主体、过期时间早于授权时间或出现在撤回事件上均 fail-closed；`active_scopes(subject, at, age=...)` 只返回在该时刻有效的 scope。**残留**：生产同意记录需身份网关与监护人身份核验 |
| 未成年人保护（§21） | **已完成** | 未成年人（阈值 18）时 `GUARDIAN_REQUIRED_SCOPES` 中的 scope 只有监护人授权才生效；`research:aggregate` 对未满 18 岁一律不可达。受众访问只收窄不扩大，未知受众/scope 抛错；教师默认不含 `audit:export`。**残留**：真实监护关系核验与年龄核验未做 |
| 保留期与删除传播（§21） | **已完成** | `RetentionPolicy` 必须为每个数据类给出规则否则 fail-closed；到期判定闭区间且稳定排序。`DeletionCoordinator` 把删除请求传播到所有已注册存储，逐存储返回计数与状态并生成 `DeletionReceipt`，任一失败为 partial、全部失败为 failed，绝不谎报成功；删除后读取直接报错，其他学生不受影响。**残留**：真实跨服务删除传播、加密擦除与备份清除 |
| 审计导出（§20.3） | **已完成** | `export_audit` 按时间窗与事件类型过滤，默认去标识伪名键，只有显式授权且受众被授权时才保留；拒绝作答/提示/答案等禁止 detail 键与非标量值。导出 bundle 含逐类型/逐结果计数、稳定排序 payload 与内容寻址摘要，Python 与 TypeScript 对同一 fixture 产出相同摘要。**残留**：真实签名 attestation 与 KMS |
| 指标面板与成本估算（§20） | **已完成** | `METRIC_DEFINITIONS` 覆盖学习/系统/成本三维度并声明聚合方式与是否允许模拟来源；模拟来源不得写入学习类指标，观测/模拟分通道快照，小群体抑制计数。`CostModel` 为纯合成估算，`billing_connected` 恒为 False，不接真实计费。**残留**：生产指标采集与计费接入 |
| Python/TS 测试与 `tsc --noEmit` | **已完成** | Python 641 通过（Step 17 新增 58）；Node 463 通过（新增 62）；`npm run typecheck` 通过；`npm run evidence:loader` 仍在独立隔离实例成功（工具目录仍为六个）。**残留**：无（合成范围内） |

### Step 18 完成情况（真实会话端到端验收，隔离实例）

状态图例同上。Step 18 不新增业务规则，也不新增第七个工具；它验证的是“真实 dsh
运行时 + 真实 Cordis 插件 + 真实模型”的端到端链路。全部数据为合成数据，运行中的
harness 未被修改。

| Step 18 交付项 | 状态 | 证据 / 残留 |
|---|---|---|
| 独立隔离 dsh 实例 | **已完成** | `step18/runtime` 内独立 `npm install @deepseek-ai/dsh@0.2.1-rc.3`（独立 `step18/.npm-cache`）；`DSH_HOME=step18/home`、profile `aeh-e2e`；未使用 `~/.dsh`、headless 配置或 npx 安装 |
| 插件在独立实例中加载 | **已完成** | `dsh-plugin/e2e/aeh-e2e-entry.ts` 复用真实 `src/index.ts` 的 `name` / `inject` / `Config` / `apply`，把合成 `MemoryHostContext` 作为宿主绑定注入；`dump-config.txt` 显示 `aeh-education-e2e` 行已插入 |
| 真实模型会话（Sidrune） | **已完成** | provider `sidrune`、model `deepseek-v4-1-flash`；退出码 0，39 个 JSON 事件，6/6 工具调用与结果，0 错误事件 |
| 门禁—诊断—复习—报告 | **已完成** | 允许 `item.fraction.add.001`，fail-closed 拒绝 `item.fraction.multiply.001`（`kcs_not_allowed:kc.fraction.multiply`）；选中 `item.fraction.equiv.001`；复习间隔 3.2 天；报告 4 次尝试 / 3 次独立正确 / 1 次提示 / 10 分钟 |
| 可复现证据 | **已完成** | `step18/evidence/20261027T110556Z/`：`command.txt`、`stdout.jsonl`、`stderr.log`、`session-log/`、`summary.md`、`summary.json`、`metadata.json`、profile 副本与 `dump-config.txt` |
| 凭证与脱敏 | **已完成** | `custom.sidrune` 的 `hsurr:` 代理凭证只进入子进程 `SIDRUNE_API_KEY`；证据中无 `hsurr:` / `sk-` 明文，命令记录写为 `[surrogate-redacted]` |
| 运行中 harness 隔离 | **已完成** | 读写均限制在 `step18/`；未修改 `~/.dsh/`、`~/workspace/deepseek-harness` 或 npx 安装；未把插件加载进执行本任务的会话 |
| 生产接入 | **未完成（有意）** | 仍是单会话、单模型、合成数据；宿主绑定是代码级入口而非可序列化生产配置；未做多租户、配额/计费、审批后台、LMS 交付与崩溃恢复 |

### Step 18 复现命令

```bash
# 首次：独立安装隔离运行时（只在 step18/ 内）
mkdir -p step18/runtime
printf '%s\n' '{"name":"aeh-step18-isolated-dsh-runtime","private":true,"dependencies":{"@deepseek-ai/dsh":"0.2.1-rc.3"}}' > step18/runtime/package.json
npm install --prefix "$PWD/step18/runtime" --cache "$PWD/step18/.npm-cache" --no-audit --no-fund

# 组合 profile（不调用模型）
python3 step18/run-e2e.py --dry-run

# 真实会话 + 证据（写入 step18/evidence/<UTC 时间戳>/）
python3 step18/run-e2e.py
```

隔离矩阵、合成场景与证据清单见 `step18/README.md`。凭证通过本机已注册的
`custom.sidrune` connector 取得；换机器需要重新注册，否则无法完成模型调用。

### P1：上线前应补齐

1. **配置 schema**：**Step 7 已完成**（`src/config.ts` + 入口导出的 Cordis `Config`；
   非法配置在 `apply` 前 fail loud）。残留：真实配置中心的变更审批/回滚与热重载审计。
2. **输出 schema 收紧**：**Step 7 已完成**（`src/output-schemas.ts`，六个工具各自闭合
   object schema；越界返回 `INVALID_TOOL_OUTPUT`）。残留：schema 版本迁移策略。
3. **会话状态**：**Step 7 已完成**（`src/host/session-state.ts`：session/agent 绑定、
   TTL、隔离、`endSession` 清理，且不写长期孪生）。残留：跨进程持久化 session store、
   真实 dsh session 服务注入与多租户隔离。
4. **审计与可观察性**：**Step 7 已完成**（`src/host/audit-log.ts`：append-only、脱敏、
   门禁/工具/审批/交付/清理事件、伪名学生/租户维度；`ApprovalLedger` 与
   `HostDeliveryAdapter` 可选接入）。**Step 8 已完成**错误与审计脱敏（工具错误去掉
   路径/密钥、审计只记原因码）。残留：WORM/防篡改存储、跨服务汇聚与保留期、
   真实 KMS 管理的 salt。
5. **安全**：提示注入、越权参数、超大 payload、速率限制、日志脱敏、错误信息
   泄露审查；保持无网络/无任意文件。**Step 8 已完成**（`src/security.ts` +
   `tools.ts` 包装 + `config.ts` 的 `security` 块）。残留：跨进程/分布式限流、
   对抗性注入的持续红队、真实身份/同意网关。
6. **FSRS 校准**：**Step 11 已完成最小实现**（`aeh/fsrs_calibration.py` +
   `src/core/fsrs-calibration.ts`：确定性拟合、bootstrap 不确定性与适用性声明、参数
   候选、隔离评测 + 显式批准 + 激活/回滚状态机；`python -m aeh.fsrs_calibration_cli`）。
   参数目前仍是合成数据上的候选，激活只返回冻结配置对象，**不**写掌握度。残留：
   真实版本/人群校准、生产参数注册表与热切换、真实 held-out 冻结集、真实审批后台。

7. **长期孪生**：**Step 12 已完成最小实现**（`aeh/twin.py` + `src/core/twin.ts`：
   事件溯源 checkpoint/rollback/replay、多 KC 记忆衰减与复习、Step 11 候选审批门禁、
   假设集五种演化并绑定版本）。残留：生产持久化与跨进程并发、真实审批后台与
   参数热切换、真实长期保持/遗忘数据。
8. **报告插件**：Step 5 已完成最小实现（`src/report.ts` + `aeh_generate_report`）。
   残留：真实身份/同意网关、报告受众的法定流程、跨服务审计。
8. **CI**：已在 `.github/workflows/ci.yml` 的 Node 24 job 中加入
   `npm ci`（`dsh-plugin/` 内，独立缓存）、`npm run typecheck`、`node --test`
   与 `npm run evidence:loader`；Python job 另加一个离线评测脚本步骤（无外部服务）。
9. **本地化/展示**：工具描述、错误消息和 UI 卡片需要 locale 与无障碍审查。
10. **并发/持久化**：Step 5 已完成单机最小模型（`FileEventStore`：append-only、
    幂等、版本/回滚、保留期、同意撤回删除传播），仍是本地合成文件、默认关闭。
    残留：跨服务删除传播、事务/乐观并发、加密、备份生命周期、真实 KMS 签名。
11. **课程图谱与题库**：Step 9 已完成版本化 KC 图、题库审核/版本、本地内存检索与
    检索后门禁（合成数据）。残留：真实教材/文档索引、BM25/向量/交叉编码重排、
    生产图数据库/题库服务、真实教师审核工作流、真实题目内容与版权/安全审核、
    跨租户隔离、图变更审批/回滚、候选到真实交付的接入。

### 仍需明确的架构决策

- 孪生事件存储放在 Profile、Bundle 还是独立服务；谁持有加密密钥与保留期。
- 干预交付由 dsh 工具、Web UI 还是外部 LMS 执行；审批记录放在哪里。
- 诊断候选由谁生成（教师/内容库/LLM），以及生成器与校验器如何分权。
- 报告受众的 scope 模型与未成年人保护流程。

## 10. 本地验证

要求 Node **>= 24**。Step 4 起插件测试使用真实的 `@deepseek-ai/*` 依赖，因此需要
先在本目录内安装（独立缓存，不动全局/运行配置）：

```bash
cd dsh-plugin
npm install --cache .npm-cache
npm run typecheck                      # tsc --noEmit（含 e2e 入口）
node --test tests/*.test.ts            # 463 个测试
npm run evidence:loader                # 隔离 loader 加载/卸载证据
```

Step 18 的独立实例验收（不装进 `dsh-plugin/` 的依赖树，见 `step18/README.md`）：

```bash
python3 step18/run-e2e.py --dry-run    # 组合隔离 profile 并打印 --dump-config
python3 step18/run-e2e.py              # 真实 Sidrune 合成会话 + 证据
```

Python 核心测试（Step 17 后共 641 个；Step 9 新增 22 个，Step 10 新增 48 个，
Step 11 新增 50 个，Step 12 新增 51 个，Step 13 新增 30 个，Step 14 新增 42 个，
Step 15 新增 54 个，Step 16 新增 66 个，Step 17 新增 58 个）：

```bash
python3 -m unittest discover -s tests -v
python3 -m aeh.eval_cli                 # 可运行的合成评测报告
python3 -m aeh.eval_cli --json          # 机器可读
python3 -m aeh.fsrs_calibration_cli     # Step 11：合成校准 + 候选门禁演示
python3 -m aeh.fsrs_calibration_cli --json
python3 -m unittest discover -s tests -p 'test_twin_step12*.py' -v  # Step 12
python3 -m unittest discover -s tests -p 'test_memory_step12.py' -v
python3 -m unittest discover -s tests -p 'test_hypothesis_step12.py' -v
python3 -m unittest discover -s tests -p 'test_hypothesis_step13.py' -v  # Step 13
python3 -m unittest discover -s tests -p 'test_diagnosis_step14.py' -v  # Step 14
python3 -m unittest discover -s tests -p 'test_teaching_strategy.py' -v  # Step 15
python3 -m unittest discover -s tests -p 'test_services_step16.py' -v  # Step 16
```

Node 测试分层：

- `tests/invariants.test.ts`：13 个离线不变量测试，用结构化替身驱动插件注册与
  纯逻辑（门禁拒绝、preview 锁定、模拟隔离、证据绑定 mastery、回滚、记忆权重、
  FSRS 反解、假设归一化、诊断门禁复检与跳过、干预训练/迁移隔离、默认权限拒绝、
  报告边界）。
- `tests/host-adapters.test.ts`：12 个宿主适配器测试（session/租户绑定、同意撤回、
  来源认证、幂等冲突、模拟隔离、版本/回滚、审计脱敏、审批幂等、交付门禁、工具
  只准备不交付）。
- `tests/report.test.ts`：8 个聚合报告边界测试（字段白名单、受众 scope 收窄、
  跨学生/窗口/授权/重复排除、去重、待关注标记、输出不含 ref/原始数据）。
- `tests/persistence.test.ts`：8 个文件事件存储测试（默认关闭、合成目录/学生守卫、
  append-only 与幂等、真实来源限制、重开加载与篡改检测、版本回滚、保留期墓碑、
  同意撤回删除传播与读取拒绝）。
- `tests/evolution.test.ts`：22 个宿主侧自进化测试（候选声明式/受保护不变量拒绝、
  追加式幂等登记、模拟/真实分通道与自动拒绝、默认拒绝审批与自我批准拒绝、合成灰度
  与熔断回滚、晋升需真实迁移、候选不能自行回滚、审计无原始数据、无自进化工具）。
- `tests/contract.test.ts`：7 个真实 Cordis/dsh 运行时契约测试（loader 挂载与
  schema、参数校验、报告工具闭合 schema 与原始字段拒绝、授权/未授权、取消、超时、
  卸载清理）。
- `tests/step7.test.ts`：23 个 P1 加固测试（Schemastery 默认值/fail-loud/服务构造
  校验、Cordis 直接注册与 loader 非法配置都不挂载、六个工具输出 schema 顶层闭合、
  真实运行时六工具输出校验、越界返回 `INVALID_TOOL_OUTPUT`、快照 scope 隔离/TTL/
  上限/session 结束清理/无孪生写路径/工具级 snapshotRef、审计 append-only 与事件
  种类、原始数据键拒绝、门禁/工具/审批/交付回执审计、伪名指标、容量 fail loud、
  插件审计包装与 `apply` 隔离上下文）。
- `tests/security.test.ts`：19 个 Step 8 安全测试（提示注入中英文/受众/审批拒绝与
  审计无原文、拒绝后决策不变、特权参数键 fail-closed、伪造进度/标注/学生/scope
  不通过 host、报告 scope 只收窄、字符串/数组/键数/深度/字节超限、默认上限放行、
  session 与 student 限流互不影响与窗口恢复、错误与审计脱敏、安全配置默认值/非法值
  fail loud、真实 ToolRuntime 把 `SecurityError` 映射为 `info.code`）。

- `tests/curriculum-graph.test.ts`：19 个 Step 9 测试（图闭包/拓扑序/环与非法图拒绝、
  proposed 边不入闭包、版本 append-only 与 diff、题库修订/审核状态机/缺失标注不可
  批准、低置信度门禁拒绝、检索过滤与摘要无原文、检索后门禁与前置闭包、未知 KC/缺失
  图拒绝、共享 fixture 哈希/顺序/分数/候选/拒绝原因、MemoryHostContext 图/题库解析与
  同意撤回、`toHostBinding()` 闭包、未知命中拒绝）。

- `tests/exercise-evolution.test.ts`：21 个 Step 10 测试（RNG/哈希/舍入原语、五种算子
  与 provenance、门禁/前置/缺失图 fail-closed、沙箱独立通道与真实迁移 gating、候选池
  必须“沙箱合格 + 审核通过”、门禁拒绝不产生沙箱结果、模拟事件只收 simulated 来源、
  假设快照隔离、相同 seed 复现与不同 seed 区分、非法阶段/uint32 seed 拒绝、共享 fixture
  的候选哈希与模拟指纹逐字节一致）。

- `tests/fsrs-calibration.test.ts`：46 个 Step 11 测试（`mulberry32`/`round4`/微单位/
  百分位原语、示意曲线与 difficulty 调制、成功增长/失败收缩/零权不更新与边界、参数与
  数据与配置校验、报告指纹复现与 seed 只改区间、bootstrap 区间上界、10 个可靠性分箱、
  适用性与证据充分性、生成器确定性、候选声明式/无生产变更/参数回环、模拟与真实分通道、
  可信来源与 unseen 迁移题 gating、门禁状态机/默认拒绝/禁止自批/非宿主拒绝/回滚、
  校准不改孪生/冻结配置、共享 fixture 全量 canonical 一致）。

- `tests/twin-step12.test.ts`：24 个 Step 12 测试（append/version/checkpoint/rollback/
  replay 与证据不变、模拟事件不得进入 observed/记忆/假设、多 KC 记忆复习与衰减不变量、
  候选挂起/审批激活/回滚/拒绝、五种假设操作与版本绑定、共享 fixture checkpoint 一致）。

- `tests/hypothesis-step13.test.ts`：30 个 Step 13 测试（生成触发与证据约束 generate、
  行为似然匹配与 unexplained、相似度、可区分分裂与不可区分合并、弱/矛盾/无独特解释力
  淘汰、unknown 原因与真实证据请求、Brier/log loss/ECE/一致率/anti-mismatch、状态与快照
  往返、session/agent 隔离、TTL/结束会话、持久化 fail-closed、共享 fixture 一致）。

- `tests/diagnosis-step14.test.ts`：31 个 Step 14 测试（稳定拓扑排序与非法步骤图拒绝、
  首个偏离定位、误解/先修/slip 展开与降权、解释转假设、预测不确定度与 `zeta` 惩罚、
  终止原因优先级、状态机 select/observe/skip/terminate 与非法转移、题数/时长/负担上限、
  共享 fixture 的偏离/权重/分数/选中项/状态序列/终止原因/负担逐值一致）。

- `tests/teaching-strategy-step15.test.ts`：54 个 Step 15 测试（fail-closed 策略路由、
  诊断题/最小提示/示范/微课/定向练习/迁移/间隔复习/进度确认/直接回答、预习—学校—
  AI 强化—复习的日常协同与动态时间分配、检索/间隔/交错学习科学计划、数学/物理学科
  适配、共享 fixture 逐值一致）。

- `tests/services-step16.test.ts`：64 个 Step 16 测试（事件 append/幂等重放/幂等冲突/乐观
  并发/get·list·lookup、observed/simulated 域隔离与模拟事件拒绝、payload/schema 校验、
  文件事件日志重开/篡改检测/异域记录拒绝、写入协调 runOnce 与异步扇出、Profile 版本化
  更新与冲突、Bundle 内容寻址与持久化、内容库审核门禁/难度过滤/版本重放与陈旧写入、
  冻结评测集的分片隔离/模拟不触迁移/可信来源/运行幂等与冲突、状态机正常转移/非法转移/
  终态/幂等 advance/快照无内容/返工上限/12 条异常分支、共享 fixture 全量一致）。

- `tests/privacy-step17.test.ts`：62 个 Step 17 测试（同意账本追加/重复/过期/未知
  scope fail-closed、未成年人监护人 scope 与 `research:aggregate` 不可达、受众只收窄、
  保留期闭区间到期与逐类删除请求、跨存储删除传播与 partial/failed、删除后读取拒绝、
  审计过滤/去标识/摘要、指标注册与模拟来源隔离、小群体抑制、成本估算与
  `billing_connected=False`、共享 fixture 逐值一致）。

Step 18 的 `dsh-plugin/e2e/aeh-e2e-entry.ts` 也被 `tsconfig.json` 纳入
`npm run typecheck`，但它只是隔离实例的合成宿主入口，不注册到插件包导出，也不会被
`node --test tests/*.test.ts` 或运行中的 harness 加载。

Python 侧新增 `tests/test_services_step16.py`（66 个）与共享
`tests/fixtures/services_step16.json`：事件存储幂等/并发/域隔离/文件重开与篡改、写入
协调、Profile/Bundle、内容库审核与版本、冻结评测集与防自证、23 状态转移/拒绝上限/
异常分支，Python/TS 逐值一致。

Python 侧新增 `tests/test_curriculum_graph.py`（22 个）：图闭包/拓扑序/环与非法图
拒绝、proposed 边、版本存储与 diff、题库版本/审核/缺失标注、检索过滤、检索后门禁与
前置闭包、未知 KC/缺失图、共享 fixture 一致性。

Python 侧新增 `tests/test_exercise_evolution.py`（48 个）：RNG/FNV/舍入与微单位原语、
五种算子的行为与 provenance、门禁/前置/低置信度/缺失标注/缺失图 fail-closed、沙箱
分通道与真实迁移 gating、候选池准入必须“沙箱合格 + 题库审核通过”、模拟事件来源
白名单与 `observedWrites==0`、独立假设快照、配置与结果指纹复现/区分、非法配置拒绝、
共享 fixture 一致性。

Python 侧新增 `tests/test_fsrs_calibration.py`（50 个）：`mulberry32`/`round4`/微单位/
百分位原语、示意曲线与 difficulty 调制、成功增长/失败收缩/零权不更新与边界、参数与
数据与配置校验、报告指纹复现与 seed 只改区间、bootstrap 区间上界、10 个可靠性分箱、
适用性与证据充分性、生成器确定性、候选声明式/无生产变更/参数回环、模拟与真实分通道、
可信来源与 unseen 迁移题 gating、门禁状态机/默认拒绝/禁止自批/非宿主拒绝/回滚、
`MemoryState`/`StudentTwin` 隔离、共享 fixture 全量一致、CLI 冒烟。

Python 侧新增 `tests/test_memory_step12.py`（13 个）、`tests/test_hypothesis_step12.py`
（8 个）、`tests/test_twin_step12.py`（26 个）与 `tests/test_twin_step12_fixture.py`
（2 个）：记忆参数/衰减/多 KC 聚合、假设 revision/绑定/剪枝/clone、孪生生命周期与
隔离、校准审批门禁、五种假设演化、共享 fixture checkpoint 一致。

Python 侧新增 `tests/test_hypothesis_step13.py`（30 个）与共享
`tests/fixtures/hypothesis_step13.json`：生成触发与证据约束 generate、行为似然匹配与
unexplained、相似度、可区分分裂与不可区分合并、弱/矛盾/无独特解释力淘汰、unknown
原因与真实证据请求、Brier/log loss/ECE/一致率/anti-mismatch、状态与快照往返、
session/agent 隔离、TTL/结束会话、持久化 fail-closed、Python/TS fixture 一致。

Python 侧新增 `tests/test_diagnosis_step14.py`（42 个）与共享
`tests/fixtures/diagnosis_step14.json`：稳定拓扑排序与非法步骤图、首个偏离、误解/
先修/slip 展开与已做对上游降权、解释转假设、预测不确定度与 `zeta` 惩罚、终止原因
优先级、状态机 select/observe/skip/terminate 与非法转移、题数/时长/负担上限、
Python/TS fixture 一致。

Python 侧新增 `tests/test_evaluation.py`（17 个）：冻结集摘要与分片隔离、迁移题
unseen、模拟不能进迁移通道、真实迁移只接受可信来源、模拟数据不能重标为真实证据、
报告分节与防自证声明、CLI 可运行。

Python 侧新增 `tests/test_evolution.py`（35 个）：候选契约与受保护不变量、追加式
幂等登记、模拟/真实分离与评测不通过自动拒绝、默认拒绝与自我批准拒绝、合成灰度与
熔断自动回滚、晋升需真实迁移、候选不能自行回滚、全链路审计与原始数据键拒绝、
`pipeline_snapshot` 的合成隔离声明。

## 11. 已知 TODO / 未实现

- 尚未在生产 dsh 会话中挂载；Step 4 的 loader/契约测试与 Step 18 的端到端验收都只在
  独立隔离的 Cordis/dsh 实例中验证。Step 18 已用真实 Sidrune 模型跑通一次合成
  “门禁—诊断—复习—报告”会话，但仍是单会话、单模型、合成数据，宿主绑定是代码级
  入口（`dsh-plugin/e2e/aeh-e2e-entry.ts`），不是可序列化的生产配置；多租户、
  配额/计费、审批后台、LMS 交付与崩溃恢复未做。
- 生产鉴权/KMS/签名 attestation、跨服务租户隔离、生产级持久化未做；
  `MemoryHostTwin.verifyAttestation` 与 `FileEventStore` 的 checksum 是接缝/完整性
  校验，不是密码学来源证明。单机最小保留期与同意撤回删除传播已做（见 §9 Step 5），
  但跨服务/备份/向量索引的删除传播未做。
- 真实交付 UI/LMS 通道、审批后台、独立评测器与生产部署通道未做；Step 6 只提供
  **宿主侧内存/合成骨架**（候选登记、隔离评测、默认拒绝审批、合成灰度、熔断回滚、
  追加式审计），没有生产发布/配置中心，也没有模型可调用的自进化工具。
- 没有真实 LLM 生成、OCR、图片脱敏、数学判题或内容安全服务。
- 报告插件是最小策略骨架，不是身份/同意服务：真实身份网关、同意记录来源、法定
  监护人流程、审计与保留期仍需宿主实现；Step 2 的 `aeh/report.py` 仍保留为离线
  Python 参考实现。
- 评测协议只提供冻结集隔离、模拟/真实分离与防自证约束；没有真实 RCT/对照组、
  延迟保持、跨知识迁移与不良效果测量，且本仓库只用合成数据。
- Step 16 的服务与状态机仍是单机骨架：文件存储没有跨进程锁、加密、保留期或压缩；
  Profile/Bundle 读取没有跨服务一致性快照；内容库没有真实版权/授权元数据与审核
  工作流；TypeScript 评测服务是 `aeh/evaluation.py` 的最小镜像而非完整协议；状态机
  没有接入真实 agent 编排、工具重试与检查点恢复，也未暴露为模型工具。Step 16 的
  `FileEventStore` 与 Step 5 `src/host/file-event-store.ts` 同名但不同层，顶层
  `index.ts` 仍导出后者，前者需从 `core/services.ts` 引入。
- 自进化仍为骨架：候选来源检测器（漂移/回归/成本）与 PR/变更单生成、真实冻结
  评测服务、生产灰度/监控接入、跨服务防篡改审计与保留期都未实现；TypeScript 侧
  的 `IsolatedSandbox` 接收宿主评测摘要而非自己运行冻结集协议。
- 输出 schema 已按 Step 7 收紧为顶层闭合 object schema（动态 key 映射在嵌套层使用
  `additionalProperties: true`）；参数对象仍开放（工具体只读白名单字段）。Step 8
  已在工具入口实现提示注入/越权/payload/单实例速率限制与错误审计脱敏；仍未实现：
  跨进程/跨副本分布式限流、按工具/租户的差异化配额、locale 展示，以及对抗性注入
  的持续红队与真实身份/同意网关。
- 课程图谱/题库仍是合成/内存实现：没有真实教材或文档索引，没有 BM25/向量/交叉
  编码重排，没有生产图数据库/题库服务、真实教师审核身份与权限、真实题目内容与
  版权/安全审核、跨租户图隔离、图变更审批/回滚，也没有把检索候选接入真实交付
  UI/LMS。Step 9 只提供可测试的结构与门禁边界，不宣称生产可用。
- 习题演化与模拟实验室仍是合成骨架：没有真实题目文本/答案/图片生成与安全审核、
  真实内容库/题型模板、真实学生行为校准（当前模拟是合成行为模型）、真实对照/延迟
  保持迁移实验、跨进程模拟调度与持久化，也没有把演化候选接入真实交付/UI。Step 10
  只提供可测试的演化/隔离/可复现边界，不宣称生产可用。
- FSRS 校准仍是合成骨架：参数只从合成 review 序列拟合，`/8` 示意曲线与线性难度项
  固定，只拟合 6 维动力学向量；没有真实版本/人群校准、真实遗忘/保持数据、生产参数
  注册表与热切换、真实 held-out 冻结集、真实审批后台与持久审计存储；`activation`
  只返回冻结配置对象并记录决策，从不写 `MemoryState`/`StudentTwin`，也不是真实效果
  声明。Step 11 只提供可测试的拟合/不确定性/候选边界，不宣称生产可用。
- 长期孪生的 checkpoint / 校准审批 / 假设 binding 仍只在内存中：没有生产持久化、
  跨进程并发控制、真实审批后台、参数注册表与热切换；pending 候选不占用推断版本
  （只有激活/回滚占用）；Python/TypeScript 的 ISO 时间戳拼写不同，共享 fixture 不比较
  时间字段。真实长期保持/遗忘数据与真实学习效果未验证。
- 虚拟学生群的生成/匹配/分裂/合并/淘汰规则已完整（Step 13），但生成触发只由调用者
  声明，没有真实的“新题型/冲突证据/步骤首次偏离”检测器；匹配用合成行为似然而不是
  真实步骤级模型；保真度指标只跑合成观测，没有真实留出步骤/教师根因标签/人群校准；
  `HypothesisSnapshotStore` 是内存 session store，没有跨进程持久化与生产访问控制；
  规则层尚未暴露为 `aeh_update_hypotheses` 的新操作（工具输出 schema 需先迁移版本）。
- 主动诊断/反向溯源仍是合成骨架（Step 14）：错误规则图、误解与先修关系由调用方提供
  合成标注，没有真实步骤解析器/符号推理器、真实教师根因标签或真实步骤级认知模型；
  `slip_likelihood` 与深度/矛盾衰减是策略先验而非校准参数；诊断题预测仍是合成概率；
  状态机是内存会话，没有跨进程持久化与 dsh session 服务注入；反向溯源、状态机与负担
  上限尚未暴露为模型工具（仍是六个工具）。
- 教学策略/日常协同仍是合成骨架（Step 15）：学校日程、考试范围、任务意图、先修缺口
  与错误信号由调用方以合成标注传入，没有真实校历、LMS/作业系统、教师确认流程或课堂
  同步资料；策略效果没有真实对照/延迟保持验证；预习与考试范围只做“已确认才解锁”的
  门禁，不推断学校进度。跨学科只交付数学与物理两个示例，化学/编程/语言/专科实践课
  适配器、真实学科验证服务与高风险实验的专业监管未实现；16 种学习科学方法中只有
  检索、间隔、交错有可执行计划，其余 13 种是映射声明。策略路由、日常计划、学习科学
  计划与学科适配尚未暴露为模型工具（仍是六个工具）。
- FSRS 参数为示意值，不是生产校准参数。
- `Config` 已在 Step 7 改为 Schemastery 校验并导出为 Cordis `Config`；残留真实配置
  中心的变更审批/回滚与热重载审计。
- Step 7 的会话快照与审计仍是内存/合成实现：跨进程持久化 session store、WORM/防篡改
  审计存储、跨服务审计汇聚与保留期、真实 KMS 管理的审计 salt 未做；`AehAuditLog` 的
  学生/租户维度是伪名化而非匿名化。

## 12. 参考与许可证

- `references/deepseek-harness/`：MIT。仅参考 Cordis 插件/工具结构，本仓库未复制
  其源码。
- `references/MiroFish/`：AGPL-3.0。本项目未引入其代码；未来若引入需重新评估
  AGPL 义务。
- `references/StudentSim/`：许可证与数据权利需分别核验；本仓库未复制其代码或数据。
- `references/awesome-fsrs/`：算法参考；本项目使用规范 §8.3 的示意公式，不绑定
  特定 FSRS 版本。

`references/` 与 `spec/` 始终只读，且 `references/` 已被 `.gitignore` 忽略。
