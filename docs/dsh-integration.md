# AEH × dsh / Cordis 集成说明（Step 3 + Step 4 + Step 5）

状态：**已用真实 `@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools` 替换离线适配层，
并在一个独立隔离的 Cordis loader 实例中完成加载/卸载与工具契约测试**。Step 5 在
此基础上新增第六个工具 `aeh_generate_report`（只接收已授权聚合事件）、一个默认
不启用的文件事件存储 `FileEventStore`（append-only / 幂等 / 版本回滚 / 保留期 /
同意撤回删除传播），以及 Python 侧的独立冻结评测协议（规范 §19）。仍**未**接入
真实学生数据，也**未**加载进任何正在运行的 dsh 会话。本文说明 Step 1 核心如何
映射为教育插件与工具、默认权限边界，以及真正接入 dsh 运行时还需要补什么。

Step 5 不修改 `aeh/` 的 Step 1/2 行为（只新增 `aeh/evaluation.py` 与
`aeh/eval_cli.py`），不接入真实学生数据，不复制 `references/deepseek-harness/`
的代码；`references/` 与 `spec/` 保持只读。隔离测试只在本目录 `dsh-plugin/` 内
安装依赖（`dsh-plugin/.npm-cache`），不读写 `~/.dsh/`，不修改
`~/workspace/deepseek-harness` 克隆或 npx 安装的 dsh。`FileEventStore` 的测试文件
只写在 `os.tmpdir()` 下的临时合成目录，默认 `enabled: false`。

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
真实交付 UI、真实 LLM/OCR、自进化流水线、生产级持久化。它们列在“接入清单”和
TODO 中。Step 4 交付的是 P0 的**隔离运行时**验证与内存适配器；Step 5 在内存适配器
之上交付**最小**文件事件存储、报告工具与独立评测协议，全部仍是合成/测试实现。

## 2. 代码结构

```text
dsh-plugin/
  package.json              # 私有包；真实 @deepseek-ai/* 依赖；Node >= 24
  tsconfig.json             # strict + noEmit + NodeNext
  cordis.example.yml        # 仅示例；host 由运行时适配器注入，不写进 YAML
  scripts/
    loader-evidence.mjs     # 隔离 Cordis loader 加载/卸载 + 契约证据脚本
  src/
    index.ts                # Cordis 插件入口：name / inject / apply
    dsh.ts                  # 真实 cordis/dsh-tools 的薄 authoring 适配层
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
    core/
      curriculum-gate.ts    # 对应 aeh/curriculum_gate.py
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
    contract.test.ts        # 7 个真实 Cordis/dsh 运行时契约测试
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

## 4. Cordis 插件结构

入口保持与 dsh 参考结构一致的函数插件形状：

```ts
export const name = 'aeh-education'
export const inject = ['tools']

export function apply(ctx: Context, config: PluginConfig = {}): void {
  assertMinimalPermissions(config.permissions)
  const service = createEducationService(
    normalizeConfig(config),
    config.host, // host-owned progress/item resolver; defaults to resolve-nothing
  )

  ctx.effect(() => {
    const disposers = createEducationTools(service)
      .map((tool) => ctx.tools.register(tool))
    return () => disposers.reverse().forEach((dispose) => dispose())
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

门禁/诊断/干预工具的参数里**没有** curriculum item、progress 或安全标注对象；
模型只传 `itemId` / `studentRef`。`HostContext.resolveProgress` 和
`resolveItem` 返回宿主已授权的快照；默认实现返回 `undefined`，因此插件在没有
宿主适配器时对这三类工具全部 fail closed。模型因此无法通过伪造
`taughtKcs`、`safetyChecked` 或 `annotationConfidence` 来解锁内容。

所有工具输出都是 JSON 友好的普通对象；当前输出 schema 使用宽松的
`type: 'json'`，真实接入时应按工具收紧为明确的 object schema。

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
- 日志/审计脱敏、速率限制、提示注入防护仍需在真实接入时补齐（见下节）。

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
AEH Step 4+5 isolated Cordis/dsh loader evidence
- node: v24.22.1
- @deepseek-ai/cordis: 4.0.5
- @deepseek-ai/dsh-tools: 0.2.1-rc.3
- @deepseek-ai/cordis-plugin-loader: 1.0.6
- loader entry: a1f7de26
- mounted tools: aeh_check_curriculum, aeh_generate_report, aeh_prepare_intervention, aeh_schedule_review, aeh_select_probe, aeh_update_hypotheses
- authorised gate decision: {"allowed":true,"reasons":[],"allowedKcs":["kc.fraction.add","kc.fraction.equiv","kc.place.value"],"itemId":"item.fraction.add.001","mode":"learn","policy":"aeh.curriculum_gate.v1"}
- report data-minimization: {"authorized_aggregate_events_only":true,"raw_student_data_included":false,"event_refs_included":false,"source_events_used":1,"source_events_excluded":0,"authorized_scopes":["educational_report","teacher_report"]}
- invalid-argument code: INVALID_ARGS
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

### P1：上线前应补齐

1. **配置 schema**：用 Schemastery 定义 `Config`，替换 `normalizeConfig` 的运行时
   校验；非法配置 fail loud。
2. **输出 schema 收紧**：把 `type: 'json'` 换成每个工具的明确 object schema，避免
   模型/宿主对返回结构做宽松假设。
3. **会话状态**：假设快照应绑定 dsh session/agent scope，明确 TTL、隔离和清理；
   不得写入长期孪生。
4. **审计与可观察性**：记录门禁拒绝原因、工具调用、审批和交付回执；不记录原始
   题目/答案/图片；指标要有学生/租户维度但不可反识别。
5. **安全**：提示注入、越权参数、超大 payload、速率限制、日志脱敏、错误信息
   泄露审查；保持无网络/无任意文件。
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
node --test tests/*.test.ts            # 48 个测试
npm run evidence:loader                # 隔离 loader 加载/卸载证据
```

Python 核心测试（Step 5 后共 185 个）：

```bash
python3 -m unittest discover -s tests -v
python3 -m aeh.eval_cli                 # 可运行的合成评测报告
python3 -m aeh.eval_cli --json          # 机器可读
```

Node 测试分五层：

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
- `tests/contract.test.ts`：7 个真实 Cordis/dsh 运行时契约测试（loader 挂载与
  schema、参数校验、报告工具闭合 schema 与原始字段拒绝、授权/未授权、取消、超时、
  卸载清理）。

Python 侧新增 `tests/test_evaluation.py`（17 个）：冻结集摘要与分片隔离、迁移题
unseen、模拟不能进迁移通道、真实迁移只接受可信来源、模拟数据不能重标为真实证据、
报告分节与防自证声明、CLI 可运行。

## 11. 已知 TODO / 未实现

- 尚未在生产 dsh 会话中挂载；本轮只在独立隔离的 Cordis/dsh 测试实例中验证。
- 生产鉴权/KMS/签名 attestation、跨服务租户隔离、生产级持久化未做；
  `MemoryHostTwin.verifyAttestation` 与 `FileEventStore` 的 checksum 是接缝/完整性
  校验，不是密码学来源证明。单机最小保留期与同意撤回删除传播已做（见 §9 Step 5），
  但跨服务/备份/向量索引的删除传播未做。
- 真实交付 UI/LMS 通道、审批后台、独立评测器与回滚流水线未做。
- 没有真实 LLM 生成、OCR、图片脱敏、数学判题或内容安全服务。
- 报告插件是最小策略骨架，不是身份/同意服务：真实身份网关、同意记录来源、法定
  监护人流程、审计与保留期仍需宿主实现；Step 2 的 `aeh/report.py` 仍保留为离线
  Python 参考实现。
- 评测协议只提供冻结集隔离、模拟/真实分离与防自证约束；没有真实 RCT/对照组、
  延迟保持、跨知识迁移与不良效果测量，且本仓库只用合成数据。
- 没有自进化候选—隔离评测—批准—灰度—回滚流水线。
- 输出 schema 仍宽松（`type: 'json'`；参数对象开放但工具体只读白名单字段）；
  locale、速率限制、可观察性和跨进程并发控制未实现。
- FSRS 参数为示意值，不是生产校准参数。
- `Config` 仍用 `normalizeConfig` 运行时校验，未改用 Schemastery。

## 12. 参考与许可证

- `references/deepseek-harness/`：MIT。仅参考 Cordis 插件/工具结构，本仓库未复制
  其源码。
- `references/MiroFish/`：AGPL-3.0。本项目未引入其代码；未来若引入需重新评估
  AGPL 义务。
- `references/StudentSim/`：许可证与数据权利需分别核验；本仓库未复制其代码或数据。
- `references/awesome-fsrs/`：算法参考；本项目使用规范 §8.3 的示意公式，不绑定
  特定 FSRS 版本。

`references/` 与 `spec/` 始终只读，且 `references/` 已被 `.gitignore` 忽略。
