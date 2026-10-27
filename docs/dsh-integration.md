# AEH × dsh / Cordis 集成说明（Step 3）

状态：**可离线测试的插件骨架，尚未在真实 dsh 运行时加载**。本文说明 Step 1
核心如何映射为教育插件与工具、默认权限边界，以及真正接入 dsh 运行时还需要补什么。

Step 3 不修改 `aeh/` 的 Python 行为，不接入真实学生数据，不复制
`references/deepseek-harness/` 的代码；`references/` 与 `spec/` 保持只读。

## 1. 目标与非目标

本步要交付的是：

- 一个保持 Cordis 函数插件形状（`name` / `inject` / `apply(ctx)`）的 TypeScript
  入口；
- 把课程门禁、学生孪生、FSRS 记忆模型、虚拟学生假设、主动诊断、习题干预包
  映射为可审查的模块和五个模型可调用工具；
- 一个默认拒绝的权限清单；
- 一条清晰的宿主边界：模型可以“计算”和“准备”，但不能写长期孪生、不能交付
  干预包、不能绕过门禁。

本步**不**交付：真实 dsh 运行时挂载、持久化、鉴权、同意管理、真实交付 UI、
真实 LLM/OCR、教师/家长报告插件、自进化流水线。它们列在“接入清单”和 TODO 中。

## 2. 代码结构

```text
dsh-plugin/
  package.json              # 私有骨架包；Node >= 24
  tsconfig.json             # strict + noEmit + NodeNext
  cordis.example.yml        # 仅示例，替换适配层后才可加载
  src/
    index.ts                # Cordis 插件入口：name / inject / apply
    dsh.ts                  # 离线结构适配层（真实接入时替换）
    domain.ts               # 与 Python 核心对应的领域类型
    permissions.ts          # 默认最小权限清单与激活时校验
    service.ts              # 教育服务：工具背后的纯计算/准备逻辑
    tools.ts                # 五个模型可调用工具
    core/
      curriculum-gate.ts    # 对应 aeh/curriculum_gate.py
      twin.ts               # 对应 aeh/twin.py（宿主侧，不暴露写工具）
      memory.ts             # 对应 aeh/memory.py
      hypothesis.ts         # 对应 aeh/hypothesis.py
      diagnosis.ts          # 对应 aeh/diagnosis.py
      exercise.ts           # 对应 aeh/exercise.py
  tests/
    invariants.test.ts      # 13 个离线不变量/契约测试
```

`src/dsh.ts` 只提供本骨架用到的 Cordis 子集（`Context`、`ctx.effect`、
`ctx.tools.register`）和 `defineTool` 的形状/参数 schema 编译。它不是第二套
框架，也不复制 dsh 源码；真实接入时必须替换为：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
```

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

### 3.7 未映射的 Step 2 模块

`report.py` 与 `demo_session.py` 不在 Step 3 范围内。后续若要接入，应另建：

- 只接收已授权聚合事件的报告工具（不接收原始题目/答案/图片）；
- 仅用于本地验收的合成 demo 适配器（不作为生产数据入口）。

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

`src/dsh.ts` 的本地 `defineTool` 会把 author-facing 参数 spec 编译为 JSON Schema
形状的 `parameters`，以便离线验证；它**不**实现 dsh 的参数校验、策略流水线、
展示层或超时策略。替换为真实包后，应以 dsh 的 `defineTool` 和工具测试套件为准。

## 5. 工具目录

| 工具 | 输入 | 输出 | 状态变更 | 权限 |
|---|---|---|---|---|
| `aeh_check_curriculum` | `mode`、`itemId`、`studentRef` | 门禁决策 + 拒绝原因 | 无 | `curriculum:read` |
| `aeh_update_hypotheses` | 假设快照 + 单个操作 | 归一化快照、权重、dominant | 仅调用方持有的会话快照 | `session:hypothesis:write` |
| `aeh_select_probe` | 候选 `itemId`、权重、`studentRef`、mode | 选中的 probe / null + 被拒候选 | 无 | `curriculum:read` |
| `aeh_schedule_review` | memory state + observations + target | 更新后的记忆状态、下次间隔 | 无 | `review:schedule:compute` |
| `aeh_prepare_intervention` | 包含 `trainingItemIds` / `transferItemIds` 的包、`studentRef`、mode | 校验结果、`deliveryEligible`、`notDelivered` | 无 | `intervention:prepare` |

没有 `aeh_twin_write`、`aeh_deliver_intervention`、`aeh_override_gate` 或
`aeh_read_raw_student_data`。这不是遗漏，是默认权限设计的一部分。

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
宿主事件存储 / Profile / Bundle  ──►  StudentTwin（observed，只追加）
        │                                   │
        │ 授权进度/聚合快照                  │ 推断 mastery
        ▼                                   ▼
  AEH 插件工具（无原始数据）          宿主侧版本/回滚
        │
        ├─ 门禁决策
        ├─ 会话假设
        ├─ 诊断选择
        ├─ FSRS 调度
        └─ 干预包准备 ──► 宿主审批/交付（插件不直接交付）

模拟学生 ──► simulated 隔离存储 ──► 可影响短期假设/教学实验
                              ✗ 不能写 observed、不能提升为真实证据
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

## 9. 真正接入 dsh 运行时还要补什么

### P0：没有这些不能上线

| 需要补 | 为什么 | 验收标准 |
|---|---|---|
| 替换 `src/dsh.ts` 为真实 `@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools` | 当前是离线结构适配层，未做运行时契约测试 | 在真实 Cordis loader 中加载，工具 schema 通过 dsh 校验，热卸载可清理 |
| `HostContext` 适配器 | 插件默认 resolve-nothing；模型不能伪造 progress 或 item 标注 | `resolveProgress`/`resolveItem` 绑定授权 session/租户；未授权请求 fail closed |
| 宿主孪生适配器 | 插件没有 observed 写权限；事件需要来源证明与持久化 | 事件 append-only、幂等、版本/回滚、来源认证、审计可查 |
| 身份、租户、同意作用域 | `studentRef` 只是引用；真实部署必须绑定授权主体 | 未授权学生/受众无法读取或写入；同意撤回可传播 |
| 交付适配器与审批 | `aeh_prepare_intervention` 故意不交付 | 交付前有审批记录、门禁复检、可回滚、独立评测隔离 |
| dsh 契约/集成测试 | 离线测试不能证明运行时行为 | 使用 dsh tool testkit + loader 测试参数校验、取消、超时、卸载 |
| 错误与取消语义 | 真实工具可能超时/取消 | `exec.signal` 协作取消；错误结构化；不产生半写状态 |

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
7. **报告插件**：只接收已授权聚合事件，复用 Step 2 `report.py` 的边界。
8. **CI**：已加入 Node 24 的 `node --test dsh-plugin/tests/*.test.ts`；再补
   `tsc --noEmit`（安装 devDependencies 后）。
9. **本地化/展示**：工具描述、错误消息和 UI 卡片需要 locale 与无障碍审查。
10. **并发/持久化**：事件提交的乐观并发、幂等键、写入协调、回滚与删除传播。

### 仍需明确的架构决策

- 孪生事件存储放在 Profile、Bundle 还是独立服务；谁持有加密密钥与保留期。
- 干预交付由 dsh 工具、Web UI 还是外部 LMS 执行；审批记录放在哪里。
- 诊断候选由谁生成（教师/内容库/LLM），以及生成器与校验器如何分权。
- 报告受众的 scope 模型与未成年人保护流程。

## 10. 本地验证

要求 Node **>= 24**（使用内置 TypeScript type stripping，无需安装依赖）：

```bash
cd dsh-plugin
node --test tests/*.test.ts
```

可选类型检查：

```bash
cd dsh-plugin
npm install
npm run typecheck
```

Python 核心测试保持不变：

```bash
python3 -m unittest discover -s tests -v
```

离线测试覆盖：门禁拒绝、preview 锁定、模拟事件隔离、证据绑定 mastery、回滚、
阅读/提示/独立作答权重、FSRS 反解、假设归一化、诊断门禁复检与跳过、干预包
训练/迁移隔离、默认权限拒绝、插件注册与卸载。

## 11. 已知 TODO / 未实现

- 插件尚未在真实 dsh 运行时加载；`src/dsh.ts` 未做 dsh 契约测试。
- 没有宿主孪生存储、鉴权、同意、租户隔离、审计、保留期或删除传播。
- 没有真实交付 UI、审批流、独立评测器或回滚流水线。
- 没有真实 LLM 生成、OCR、图片脱敏、数学判题或内容安全服务。
- 没有报告插件；Step 2 的报告仍是 Python 离线实现。
- 没有自进化候选—隔离评测—批准—灰度—回滚流水线。
- 输出 schema 仍宽松；locale、速率限制、可观察性和并发控制未实现。
- FSRS 参数为示意值，不是生产校准参数。

## 12. 参考与许可证

- `references/deepseek-harness/`：MIT。仅参考 Cordis 插件/工具结构，本仓库未复制
  其源码。
- `references/MiroFish/`：AGPL-3.0。本项目未引入其代码；未来若引入需重新评估
  AGPL 义务。
- `references/StudentSim/`：许可证与数据权利需分别核验；本仓库未复制其代码或数据。
- `references/awesome-fsrs/`：算法参考；本项目使用规范 §8.3 的示意公式，不绑定
  特定 FSRS 版本。

`references/` 与 `spec/` 始终只读，且 `references/` 已被 `.gitignore` 忽略。
