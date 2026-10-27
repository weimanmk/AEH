# AEH × dsh / Cordis 集成说明（Step 3 + Step 4 + Step 5 + Step 6 + Step 7 + Step 8 + Step 9）

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
opaque itemId 与标注摘要，不返回题目原文。仍**未**接入真实学生数据，也**未**加载进
任何正在运行的 dsh 会话。本文说明 Step 1 核心如何映射为教育插件与工具、默认权限
边界，以及真正接入 dsh 运行时还需要补什么。

Step 6 不修改 `aeh/` 的 Step 1/2/5 行为（只新增 `aeh/evolution.py`）与插件工具
目录（仍是六个模型可调用工具），不接入真实学生数据，不复制
`references/deepseek-harness/` 的代码；`references/` 与 `spec/` 保持只读。隔离测试
只在本目录 `dsh-plugin/` 内安装依赖（`dsh-plugin/.npm-cache`），不读写 `~/.dsh/`，
不修改 `~/workspace/deepseek-harness` 克隆或 npx 安装的 dsh。`FileEventStore` 的测试
文件只写在 `os.tmpdir()` 下的临时合成目录，默认 `enabled: false`。Step 8 同样只在
`dsh-plugin/` 与文档内工作，安全测试全部使用合成引用，未改动 `aeh/` 的 Step 1–7
行为，也未改动运行用 dsh。

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
      twin.ts               # 对应 aeh/twin.py（宿主侧，不暴露写工具）
      memory.ts             # 对应 aeh/memory.py
      hypothesis.ts         # 对应 aeh/hypothesis.py
      diagnosis.ts          # 对应 aeh/diagnosis.py
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
虚假地变得极尖。

`aeh_update_hypotheses` 接收一个快照、执行一个操作、返回下一个快照。它没有长期
证据写入，也没有跨会话持久化；`unknown` 领先时 `dominantId` 为 `null`。这对应
“短期假设可以影响下一步诊断，但不能自动变成长期真实掌握”。

### 3.5 主动诊断：信息增益减去成本，学生可跳过

`aeh_select_probe` 对每个候选计算：

```text
IG(q) + alpha * teachingValue(q)
      - beta * time(q) - gamma * risk(q) - delta * cognitiveLoad(q)
```

只有 host-catalog 能解析、且重新通过课程门禁的候选参与排序。`skipped: true` 时
返回 `selection: null`；无候选通过时也返回 `null`；宿主无法授权 progress 时返回
`blockedReason: "progress_unavailable"`。工具不强制出题，不记录作答。

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
6. **FSRS 校准**：当前参数是规范 §8.3 的示意值；生产应按实际版本、优化器和
   人群校准，并保留模型版本与不确定性。
7. **报告插件**：Step 5 已完成最小实现（`src/report.ts` + `aeh_generate_report`）。
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
npm run typecheck                      # tsc --noEmit
node --test tests/*.test.ts            # 131 个测试
npm run evidence:loader                # 隔离 loader 加载/卸载证据
```

Python 核心测试（Step 9 后共 242 个；Step 9 新增 22 个）：

```bash
python3 -m unittest discover -s tests -v
python3 -m aeh.eval_cli                 # 可运行的合成评测报告
python3 -m aeh.eval_cli --json          # 机器可读
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

Python 侧新增 `tests/test_curriculum_graph.py`（22 个）：图闭包/拓扑序/环与非法图
拒绝、proposed 边、版本存储与 diff、题库版本/审核/缺失标注、检索过滤、检索后门禁与
前置闭包、未知 KC/缺失图、共享 fixture 一致性。

Python 侧新增 `tests/test_evaluation.py`（17 个）：冻结集摘要与分片隔离、迁移题
unseen、模拟不能进迁移通道、真实迁移只接受可信来源、模拟数据不能重标为真实证据、
报告分节与防自证声明、CLI 可运行。

Python 侧新增 `tests/test_evolution.py`（35 个）：候选契约与受保护不变量、追加式
幂等登记、模拟/真实分离与评测不通过自动拒绝、默认拒绝与自我批准拒绝、合成灰度与
熔断自动回滚、晋升需真实迁移、候选不能自行回滚、全链路审计与原始数据键拒绝、
`pipeline_snapshot` 的合成隔离声明。

## 11. 已知 TODO / 未实现

- 尚未在生产 dsh 会话中挂载；本轮只在独立隔离的 Cordis/dsh 测试实例中验证。
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
