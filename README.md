# AEH — Adaptive Cognitive Twin Education Harness

AEH 是一个**规范驱动**的自适应教育 Harness 核心骨架。本仓库对应
[`TASKS.md`](TASKS.md) 的 **Step 1 + Step 2 + Step 3 + Step 4 + Step 5 + Step 6**：
Step 1 用 Python 标准库实现可测试的核心机制；Step 2 在核心之上增加一个完全离线的
合成演示会话，以及只消费已授权聚合事件的教师/家长报告；Step 3 增加一个 TypeScript
的 dsh / Cordis 教育插件骨架；Step 4 把插件骨架的离线适配层替换为真实的
`@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools`，并在**独立隔离**的 Cordis/dsh
实例中完成加载、契约与卸载验证，同时补齐内存宿主适配器；Step 5 增加只接收已授权
聚合事件的报告工具、默认关闭的本地文件事件存储（保留期与同意撤回删除传播），
以及独立冻结的评测协议（模拟收益与真实迁移严格分离）；Step 6 增加**宿主侧**受控
自进化骨架（候选登记 → 隔离评测 → 默认拒绝审批 → 合成灰度/熔断 → 晋升/回滚 →
追加式审计），不新增模型可调用的自进化工具。

当前状态：**核心骨架 + 合成演示 + 已在隔离实例中验证的插件，不是生产系统**。
Python 模块无第三方依赖，CI 不需要 `pip install`；插件使用真实 `@deepseek-ai/*`
依赖，依赖只安装在 `dsh-plugin/` 内（独立缓存），不会加载进任何正在运行的 dsh
会话，也不读写 `~/.dsh/`。Step 5 的文件事件存储只写 `os.tmpdir()` 下的合成临时
目录，且默认 `enabled: false`。

## 这是什么

- 一个可审计的学生认知状态骨架：长期孪生（事件溯源、版本化、可回滚）与短期虚拟
  学生假设（spawn / split / reweight / merge / prune / unknown）。
- 一个 fail-closed 的课程门禁：发题或交付干预前检查安全、内容、适龄、先修 KC、
  超前方法和认知负荷。
- 一个 FSRS 风格的可检索记忆模型：保留率、目标保持概率反解间隔、独立作答与提示后
  作答的质量区分。
- 一个区分性诊断选择器：信息增益减去时间、风险与认知负荷惩罚，允许学生跳过。
- 一个干预包结构：训练题、提示阶梯、讲解资源、独立迁移题和完成判据严格分离，
  未通过门禁的候选不会交付。
- 一个离线命令行演示：用内置合成 fixture 串起“拍题 → 批改 → 诊断 → 复习”的最小
  闭环，所有状态变化都经过 Step 1 的门禁、孪生、假设、记忆与交付模块。
- 一个最小权限的报告生成器：只接受固定 schema 的已授权聚合事件，不接收题目、答案、
  图片、作答步骤或任意自由文本，输出中也不包含事件 ID。
- 一个 dsh / Cordis 教育插件（TypeScript）：把门禁、孪生边界、FSRS 复习、
  短期假设、诊断选择、干预包准备和聚合报告映射为六个默认最小权限工具；孪生写与
  干预交付仍由宿主负责，模型无法绕过门禁或直接发题。插件已用真实 cordis/dsh-tools
  依赖在隔离实例中完成加载、schema、取消、超时与卸载契约测试。
- 一个默认关闭的本地文件事件存储（TypeScript 宿主适配器）：append-only、按事件
  幂等、版本/回滚、保留期，以及同意撤回后的删除传播；只接受合成目录与学生引用，
  持久化记录不含 payload。
- 一个独立冻结的评测协议（Python 标准库）：train/explanation/transfer 分片隔离、
  迁移题 unseen、内容摘要冻结；模拟收益与真实迁移分开报告，且模拟数据在任何路径上
  都不能充当真实学习效果证据。
- 一个宿主侧受控自进化骨架（Python `aeh/evolution.py` + TypeScript
  `dsh-plugin/src/host/evolution.ts`）：候选只允许是配置/策略/提示模板的版本化变更
  记录，不能降低门禁、放宽权限或写生产文件；候选经冻结评测集隔离评测（模拟收益与
  真实迁移分开，评测不通过/证据不足自动拒绝）、显式且默认拒绝的宿主审批、仅作用于
  合成会话比例的灰度与熔断回滚，全链路追加式审计且不含原始学生数据。审批与回滚
  **只由宿主侧调用**，不是模型工具。

## 这不是什么

- 不是完整的教学系统、App 或生产服务；没有生产数据库、生产鉴权、多租户隔离、
  真实 LLM 或真实学生数据接入。Step 4/5 的插件只在**独立隔离**的 Cordis/dsh 测试
  实例中加载验证，没有加载进任何正在运行的 dsh 会话；内存宿主适配器与本地文件
  事件存储都不是生产实现。
- 不是真实 OCR、拍照 App 或通用数学判题器。演示中的“照片”、OCR、学生步骤和判题
  结果都是内存中的合成 fixture，不读文件、不连网、不调用模型。
- 报告生成器不是完整的同意管理或访问控制服务；它只实现“授权聚合事件进、
  最小化聚合报告出”的策略骨架，真实部署仍需服务端身份、同意、审计与保留期。
- Step 5 的文件事件存储不是生产数据库：它是本地合成目录上的最小模型，默认关闭，
  没有加密、事务并发、跨服务删除传播或真实签名 attestation。
- 评测协议不是随机对照试验：它只保证冻结集分片隔离与“模拟/真实分离、不自证”；
  没有真实对照组、延迟保持、跨知识迁移或不良效果的完整测量。
- Step 6 的自进化不是自主上线：它是宿主侧内存/合成骨架，没有生产发布或配置中心，
  没有真实流量灰度、监控或跨服务防篡改审计，也没有让模型自行批准、晋升或回滚的
  工具；真实自进化仍必须走人工审批与独立安全流程。
- 不宣称“读心”。所有推断都来自可观察证据，并保留不确定性与 `unknown`。
- 不把模拟试学收益等同于真实学习效果；训练、讲解和迁移评测必须隔离。
- 不复制 `references/` 中任何参考仓库的代码。参考仓库只用于机制与算法研究。
- 不包含任何密钥、真实学生数据或生产凭据。

## 核心不变量与测试映射

| 不变量 | 实现 | 测试 |
|---|---|---|
| 模拟不能改变真实掌握；`observed_*` 只由可信真实来源写入 | `aeh/twin.py` | `tests/test_twin.py`、`tests/test_invariants.py` |
| 未授/超前知识被门禁拒绝，缺失或低置信度标注 fail-closed | `aeh/curriculum_gate.py` | `tests/test_curriculum_gate.py` |
| 提示后正确 ≠ 独立检索成功；阅读讲解不更新记忆 | `aeh/memory.py` | `tests/test_memory.py` |
| 假设权重在 spawn/split/merge/prune/reweight 后保持归一化 | `aeh/hypothesis.py` | `tests/test_hypothesis.py` |
| 被门禁拒绝的候选不能交付给学生 | `aeh/exercise.py` | `tests/test_exercise.py` |
| 诊断按信息增益选 probe，学生可跳过，不允许的题不参与 | `aeh/diagnosis.py` | `tests/test_diagnosis.py` |
| 演示只用合成 fixture；超前探针不会被选中 | `aeh/demo_session.py` | `tests/test_demo_session.py` |
| 报告只用已授权聚合事件，不输出原始数据或事件 ID | `aeh/report.py`、`dsh-plugin/src/report.ts` | `tests/test_report.py`、`dsh-plugin/tests/report.test.ts` |
| 插件默认最小权限；无原始数据、DB 写、凭据、文件或网络访问 | `dsh-plugin/src/permissions.ts` | `dsh-plugin/tests/invariants.test.ts` |
| 孪生写与干预交付属于宿主；模型不能绕过门禁或直接发题 | `dsh-plugin/src/tools.ts`、`dsh-plugin/src/core/twin.ts` | `dsh-plugin/tests/invariants.test.ts` |
| 文件事件存储 append-only、幂等、版本/回滚、保留期、同意撤回删除传播 | `dsh-plugin/src/host/file-event-store.ts` | `dsh-plugin/tests/persistence.test.ts` |
| 评测冻结集分片隔离、迁移题 unseen、模拟收益不能自证真实效果 | `aeh/evaluation.py` | `tests/test_evaluation.py` |
| 自进化候选不能改门禁/权限/隐私，不能写生产文件，不能自我批准或自我回滚 | `aeh/evolution.py`、`dsh-plugin/src/host/evolution.ts` | `tests/test_evolution.py`、`dsh-plugin/tests/evolution.test.ts` |
| 评测不通过或证据不足自动拒绝；模拟收益不能单独作为晋升依据 | `aeh/evolution.py`、`dsh-plugin/src/host/evolution.ts` | `tests/test_evolution.py`、`dsh-plugin/tests/evolution.test.ts` |
| 审批显式且默认拒绝；灰度仅合成比例、带熔断与回滚；全链路审计无原始数据 | `aeh/evolution.py`、`dsh-plugin/src/host/evolution.ts` | `tests/test_evolution.py`、`dsh-plugin/tests/evolution.test.ts` |

另外，`tests/test_invariants.py` 用端到端断言直接命名并覆盖了 TASKS.md 要求的四条
Step 1 不变量。Step 2 的测试额外覆盖“演示不接真实数据”和“报告不泄露原始数据”；
Step 3 的离线测试覆盖插件侧的模拟隔离、证据绑定 mastery、门禁复检、FSRS 质量权重、
假设归一化、训练/迁移隔离和默认权限拒绝；Step 5 的测试覆盖报告工具边界、文件
事件存储的保留期/撤回删除传播，以及评测的防自证约束；Step 6 的测试覆盖候选契约、
受保护不变量拒绝、评测自动拒绝、默认拒绝审批、合成灰度与熔断回滚、候选不能自我
批准/回滚，以及无原始数据的追加式审计。

## Step 2：命令行演示会话

演示不需要任何安装、网络、数据库或真实学生数据。在项目根目录运行：

```bash
python3 -m aeh.demo
```

如果本机有 `python` 命令，也可以：

```bash
python -m aeh.demo
```

演示会依次打印：

1. **拍题**：读取内置 `synthetic://` 图片引用和合成 OCR 结果；题目先过课程门禁。
2. **批改**：对照已验证的合成参考答案定位首个错误步骤，识别
   `bug.no_compensation`，并通过 `trusted_grader` 路径追加真实证据、更新长期孪生。
3. **诊断**：构造“不会补偿 / 公式错误 / 偶发失误”三个短期假设，用信息增益、时间、
   风险与认知负荷选出允许的探针；合成学生作答后更新归一化后验。一个信息增益很高
   但属于超前知识的探针会被门禁拒绝，且不会出现在候选选择中。
4. **复习**：先记录一次提示后成功（不计为独立检索），再记录一次独立成功；用
   FSRS 风格公式安排下次复习，并通过门禁交付训练题 + 未见迁移题的复习包。
5. **报告**：只把窗口内的合成聚合事件交给报告生成器，输出教师或家长视图。

家长/监护人视图：

```bash
python3 -m aeh.demo --audience guardian
```

机器可读输出（演示轨迹 + 聚合报告）：

```bash
python3 -m aeh.demo --json
```

演示使用固定时钟 `2026-03-02`，便于测试和审计；学生引用固定为
`demo.student.synthetic_001`。`DemoSession` 会拒绝任何不以 `demo.` 开头的学生 ID，
`SyntheticPhoto` 会拒绝非 `synthetic://` 的图片引用。

## Step 2：教师 / 家长报告边界

报告输入是 `aeh.report.AggregateEvent`，字段只有固定计数与统计量：

```text
event_id, student_ref, occurred_at, kind, consent_scope, kc_id,
attempts, independent_correct, hinted_correct, hints_requested,
reviews_due, reviews_completed, minutes
```

它**没有**题目、答案、图片、答案步骤、任意 `payload` 或自由文本字段。`kc_id` 也
只接受短标识符，不接受长文本或换行。`generate_report(...)` 会：

- 只使用 `consent_scope` 在该受众允许范围内的聚合事件；
- 调用方传入的 scope 只能收窄受众默认权限，不能扩大（例如家长不能读取
  `teacher_report` 专属 scope）；
- 排除其他学生、窗口外、未授权和重复事件，并只输出排除数量；
- 只输出聚合计数、比率、知识点 ID 和待关注原因，不输出事件 ID；
- 在 JSON 与 Markdown 中都声明“仅授权聚合事件、无原始学生数据”。

这仍是策略骨架：生产环境必须由可信身份网关注入受众与 scope，并补齐同意记录、
访问审计、保留期、删除传播和未成年人保护流程。

## Step 3：dsh / Cordis 教育插件骨架

Step 3 在**不改变 Python 核心行为**的前提下，新增 `dsh-plugin/`：一个保持 Cordis
函数插件形状（`name` / `inject` / `apply(ctx)`）的 TypeScript 骨架，把 Step 1 的
机制映射为教育服务与五个模型可调用工具（Step 5 增为六个）。完整映射、权限表和接入清单见
[`docs/dsh-integration.md`](docs/dsh-integration.md)。

Step 3 最初使用一个离线结构适配层 `dsh-plugin/src/dsh.ts`（只实现
`Context` / `ctx.effect` / `ctx.tools.register` / `defineTool` 子集）。该适配层已在
Step 4 替换为真实的 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-tools`，见下一节。

### 核心映射

| Step 1 核心 | TypeScript 位置 | Cordis 中的位置 | 默认工具 |
|---|---|---|---|
| `curriculum_gate` | `dsh-plugin/src/core/curriculum-gate.ts` | 所有交付/诊断前的策略检查 | `aeh_check_curriculum` |
| `twin` | `dsh-plugin/src/core/twin.ts` | 宿主拥有的 Profile/Bundle 事件存储适配器 | 无写工具 |
| `memory` | `dsh-plugin/src/core/memory.ts` | 复习调度计算 | `aeh_schedule_review` |
| `hypothesis` | `dsh-plugin/src/core/hypothesis.ts` | 会话级临时状态 | `aeh_update_hypotheses` |
| `diagnosis` | `dsh-plugin/src/core/diagnosis.ts` | 诊断候选选择 | `aeh_select_probe` |
| `exercise` | `dsh-plugin/src/core/exercise.ts` | 干预准备/校验流水线 | `aeh_prepare_intervention` |

这五个 Step 3 工具都是“计算/准备”型：不写数据库、不写长期孪生、不直接交付题目。
门禁/诊断/干预工具只接收 opaque `itemId` / `studentRef`；题目安全标注和课程进度
由宿主 `HostContext` 解析，默认实现什么都不返回（fail closed），模型不能内联伪造
`taughtKcs`、`safetyChecked` 或传 `gateAllowed: true` 绕过。孪生 observed 写入与
干预交付属于宿主，需要来源认证、同意、审批和独立门禁复检。

### 默认最小权限

`dsh-plugin/src/permissions.ts` 只允许：

```text
curriculum:read
session:hypothesis:write
review:schedule:compute
intervention:prepare
```

永久拒绝学生原始数据、数据库写、凭据、任意文件、网络、observed twin 写、门禁
覆盖和自我批准。激活时任何越权请求都会让插件加载 fail-closed；没有提权入口。
测试只使用 `synthetic.student.001` 这类合成引用，不包含真实学生数据或密钥。

### 本地验证

要求 Node **>= 24**（使用内置 TypeScript type stripping，无需安装依赖）：

```bash
cd dsh-plugin
node --test tests/*.test.ts
```

13 个离线不变量测试覆盖门禁拒绝、preview 锁定、模拟事件隔离、证据绑定 mastery、回滚、
阅读/提示/独立作答权重、FSRS 反解、假设归一化、诊断门禁复检与跳过、干预包
训练/迁移隔离、默认权限拒绝、插件注册与卸载，以及无宿主授权时的 fail-closed。
（Step 6 后 `node --test tests/*.test.ts` 共 70 个测试，见下文。）

可选类型检查（需要先 `npm install` 安装 devDependencies）：

```bash
cd dsh-plugin
npm run typecheck
```

### 接入状态（Step 3 结束时）

Step 3 结束时插件**没有**在真实 dsh / Cordis 运行时加载过，也没有接入真实学生
数据。Step 4 已在独立隔离实例中补齐 P0 的加载与契约验证，并把仍未完成的生产项
如实列在 [`docs/dsh-integration.md`](docs/dsh-integration.md) 第 9 节。

## Step 4：真实 dsh / Cordis 接入（P0）

Step 4 在**不改变 Python 核心行为、不改动运行中 harness** 的前提下完成：

- `dsh-plugin/src/dsh.ts` 直接导入真实 `@deepseek-ai/cordis` 与
  `@deepseek-ai/dsh-tools`；`defineTool` 委托 dsh 做 schema 编译、参数/输出校验、
  注册与执行。依赖声明在 `dsh-plugin/package.json`，只安装在 `dsh-plugin/`
  内（独立缓存 `dsh-plugin/.npm-cache`），`npm run typecheck`（`tsc --noEmit`）通过。
- 新增内存宿主适配器 `dsh-plugin/src/host/`：
  - `MemoryHostContext`：绑定单一 session/租户/学生，`resolveProgress` /
    `resolveItem` 只读授权快照；未授权、跨学生或撤回 `curriculum:read` 均 fail
    closed；`toHostBinding()` 用于只保留数据属性的配置传输。
  - `MemoryHostTwin`：append-only、按 `eventId` 幂等、版本/回滚、可注入来源认证
    接缝、追加式审计（不记 payload）、observed/simulated 硬隔离。
  - `ApprovalLedger` / `HostDeliveryAdapter`：宿主审批 + 交付门；模型工具
    `aeh_prepare_intervention` 仍只准备、不交付。
- 真实运行时契约测试 `dsh-plugin/tests/contract.test.ts`：用独立 `Context` +
  dsh `ToolRuntime` + timeout policy + `cordis-plugin-loader` 挂载插件，验证
  schema、参数校验（`INVALID_ARGS`）、取消（`exec.signal` →
  `ABORTED_BEFORE_DISPATCH`）、超时（`TOOL_TIMEOUT`）与卸载清理。
- 加载证据：`npm run evidence:loader` 在独立实例中打印挂载的 6 个工具（Step 5
  加入报告工具）、门禁决策、报告最小化字段与各错误码，卸载后工具归零。命令与
  完整输出见
  [`docs/dsh-integration.md`](docs/dsh-integration.md) 第 9 节。

**仍未完成**（文档中如实列出，未假装实现）：生产鉴权/KMS/签名 attestation、
持久化孪生存储、租户隔离、保留期与删除传播、真实交付 UI/LMS 与审批后台、生产级
独立评测与回滚通道、输出 schema 收紧、locale/速率限制、FSRS 生产校准。报告工具与
独立冻结评测协议已在 Step 5 完成最小实现，宿主侧受控自进化骨架已在 Step 6 完成
（均仍为合成/内存实现）。本轮**只准备、不交付**，也不引入真实学生数据或密钥。

## Step 5：报告插件、持久化最小模型与独立评测

Step 5 只在本目录内工作，不修改运行用 dsh（`~/.dsh/`、`~/workspace/deepseek-harness`
克隆、npx 安装的 dsh），不把 AEH 插件加载进正在执行本任务的 harness 会话，全部
使用合成数据。

### 5.1 聚合报告工具（`aeh_generate_report`）

`dsh-plugin/src/report.ts` 是 `aeh/report.py` 边界的 TypeScript 映射，注册为第六个
dsh 工具。它：

- 只接收固定字段的**聚合**事件（`attempts` / `independentCorrect` /
  `hintedCorrect` / `hintsRequested` / `reviewsDue` / `reviewsCompleted` /
  `minutes`）加 opaque `consentScope` 与去重用的聚合批次引用 `aggregateRef`；
- 工具参数 schema 是闭合的（`additionalProperties: false`），题目、答案、图片、
  作答步骤、任意 `payload` 或原始事件 ID 在 dsh schema 编译阶段即被 `INVALID_ARGS`
  拒绝；`report.ts` 还有运行时字段白名单二次拒绝；
- 按受众（teacher/guardian）默认 scope 取交集，调用方传入的 scope 只能收窄；
  其他学生、窗口外、未授权、重复事件只计入 `events_excluded`；
- 输出只有聚合总量、知识点 ID 与待关注原因，**不含** `aggregateRef`、原始数据或
  事件引用；`aggregateRef` 只用于幂等去重，不是原始学习事件 ID。

测试：`dsh-plugin/tests/report.test.ts`（8）与 `dsh-plugin/tests/contract.test.ts`
的报告契约测试；Python 侧原 `tests/test_report.py` 继续作为离线边界参考。

### 5.2 文件事件存储（宿主侧，默认关闭）

`dsh-plugin/src/host/file-event-store.ts` 在 Step 4 的 `MemoryHostTwin` 之上加最小
持久化模型：

- **默认不启用**：必须显式 `enabled: true`，否则所有读写抛
  `FileEventStoreDisabledError`；
- **仅合成数据**：构造时校验 `directory` 位于 `syntheticRoot` 内，学生引用必须是
  `synthetic.*` / `demo.*`，否则拒绝；
- **append-only + 幂等**：`events.jsonl` 只追加；同一事件重放返回原事件且不写新行；
  持久化记录不含 host twin 的 `payload`，原始作答不会落盘；
- **完整性**：每条记录带 SHA-256 校验，重开加载时检测篡改（这是完整性校验，不是
  签名或 KMS 来源证明）；
- **版本/回滚**：证据日志只读，推断 mastery 可版本化并回滚；
- **保留期**：`retentionDays` 到期的记录写成 `tombstones.jsonl` 追加式墓碑，不重写
  事件文件；
- **同意撤回删除传播**：撤回 `twin:observe` 后为所有事件写墓碑，之后 `append` /
  `readObserved` / `load` 全部 fail closed，相关读取拒绝。

测试：`dsh-plugin/tests/persistence.test.ts`（8），文件只写在 `os.tmpdir()` 的临时
合成目录。**未完成**：跨服务删除传播、事务/乐观并发、加密、备份生命周期、真实
签名 attestation。这些在文档中如实列为未完成。

### 5.3 独立冻结评测（规范 §19）

`aeh/evaluation.py`（Python 标准库）提供：

- `FrozenEvalSet`：不可变、内容寻址（SHA-256 摘要）的评测集，`train` /
  `explanation` / `transfer` 三片 item id 互不重叠，迁移题强制
  `seen_before=False`；
- `EvaluationProtocol.run(...)`：**模拟通道**只接受 `SimulatedOutcome`，只能引用
  train/explanation 分片；**真实通道**只接受可信来源（`student` / `teacher` /
  `trusted_grader` / `assessment`）的 `RealOutcome`，只能引用 unseen transfer 分片；
  模拟数据不可能进入真实通道，也不能被重标为真实证据；
- `EvaluationResult`：模拟收益与真实迁移分节输出，含防自证声明与已知限制；没有
  真实迁移观测时明确写“无真实证据”，不用模拟数据填充。

可运行脚本：

```bash
python3 -m aeh.eval_cli          # 合成冻结集 + 模拟收益 + 空真实迁移
python3 -m aeh.eval_cli --json
```

报告模板：[`docs/evaluation-report-template.md`](docs/evaluation-report-template.md)。
测试：`tests/test_evaluation.py`（17）。**未完成**：真实 RCT/对照组、延迟保持、
跨知识迁移、不良效果测量；所有数据均为合成 fixture。

### 5.4 不变式与隔离

- 运行用 dsh 没有被改动：没有写 `~/.dsh/`、没有改 `~/workspace/deepseek-harness`
  克隆、没有改 npx 安装的 dsh、没有把插件加载进本任务会话；
- loader 契约测试仍使用独立隔离的 `Context` + `cordis-plugin-loader` 实例；
- Python 与 TypeScript 测试全部通过，`tsc --noEmit` 通过；CI 未新增外部服务。

## Step 6：受控自进化流水线骨架（规范 §27）

Step 6 只在本目录内工作，不修改运行用 dsh（`~/.dsh/`、`~/workspace/deepseek-harness`
克隆、npx 安装的 dsh），不把插件加载进正在执行本任务的 harness 会话，全部使用合成
数据。它是**宿主侧控制面骨架**，不是自主改写系统的 Agent。

### 6.1 候选生成与登记

`aeh/evolution.py` 的 `Candidate` + `CandidateRegistry` 与
`dsh-plugin/src/host/evolution.ts` 的 `Candidate` + `CandidateRegistry`：

- 候选只能是 `config` / `policy` / `prompt_template` 的**版本化变更记录**，必须带
  `source`（漂移检测、错题报告、评测回归、工具失败、成本报告、人工请求等）、
  `change_summary`、`impact_scope`、`baseline_version` 和作者；
- `changes` 必须是可 JSON 化的声明式数据，不能携带函数/代码；候选不能声明
  `target_files`，也不能声明 `mutates_production`，因此候选本身无法修改任何生产文件；
- 递归拒绝 `changes` 的键名或 `impact_scope` 条目中触及受保护不变量的 token（课程
  门禁、安全门禁、内容校验、权限、同意、隐私、真实-模拟隔离、observed 孪生写、
  自我批准、回滚权、原始学生数据、DB 写、凭据、网络、任意文件）。这些变更必须走
  独立的安全/产品治理流程（规范 §27.1）；
- 登记是内存中的 append-only、按 `(candidate_id, version)` 幂等；同 id/version 不同
  内容会被拒绝。

### 6.2 隔离评测

每个候选必须经 `IsolatedSandbox` 在 Step 5 的 `FrozenEvalSet` 与隔离沙箱中评测
（TypeScript 侧接收宿主评测服务产出的分通道摘要）：

- **模拟收益**只能来自 train/explanation 分片，标记为 `is_causal_evidence=false`；
- **真实迁移**只接受可信来源（`student` / `teacher` / `trusted_grader` /
  `assessment`）的 unseen transfer 证据；
- 模拟数据不能进入真实通道，也不能被重标为真实证据（`SplitIsolationError` /
  `SelfProofError` 会变成失败评测并自动拒绝）；
- 评测不通过或证据不足（无证据、模拟收益低于阈值、真实迁移低于阈值/非 unseen/
  来源不可信）时，候选状态直接变为 `rejected`；
- **模拟收益不能单独作为晋升依据**：只有真实迁移证据达标时 `promotion_ready` 才为
  真，否则最多进入候选池/灰度。

### 6.3 批准与灰度

- 批准必须是显式的 `ApprovalRecord`（审批人、时间、理由、角色），**默认拒绝**：
  没有审批记录、非宿主角色、记录中的审批人与操作者不一致、或候选作者自我批准都会
  被拒绝；
- 灰度只影响**合成会话比例**（`synthetic_only=true`，`fraction ∈ (0,1]`），必须
  先有显式批准；
- 灰度带熔断条件（`max_regression` / `max_error_rate` / `min_samples` /
  `max_duration_minutes`），样本达标且超阈值时自动触发 `circuit_breaker` 并立即
  回滚，即“一键回滚”。

### 6.4 回滚

`rollback` 恢复上一稳定版本（`baseline_version` / `previous_stable_version`）并
记录 `RollbackEvent`（from/to、触发者、理由、触发方式）。只允许宿主角色调用；
候选不能自行回滚生产系统，也不能自行批准自己（`RollbackDeniedError` /
`ApprovalDeniedError`）。

### 6.5 审计

单一 append-only `AuditLog` / `EvolutionAuditLog` 覆盖候选登记、隔离评测、批准、
灰度开始/观测/熔断、晋升、回滚全链路，无更新/删除 API；递归拒绝 `answer` /
`payload` / `student_name` / `trace` 等原始学生数据键。`pipeline_snapshot()` 显式
声明 `production_mutation_enabled=false`、`sandbox_has_production_access=false`、
`synthetic_fixtures_only=true`。

### 6.6 工具与隔离边界

- **不新增模型可调用的自进化工具**：插件工具目录仍是六个，名字里没有
  `evolution` / `approve` / `rollback` / `canary`（`tests/evolution.test.ts` 断言）；
- 审批、灰度、晋升、回滚只在宿主侧 `src/host/evolution.ts` 中调用；
- 测试：`tests/test_evolution.py`（35）与 `dsh-plugin/tests/evolution.test.ts`（22），
  全部使用合成 fixture。**未完成**：真实候选来源检测器与 PR/变更单生成、真实冻结
  评测服务、生产灰度/监控接入、跨服务防篡改审计与保留期、真实部署/回滚通道。

## 目录结构

```text
aeh/
  __init__.py
  curriculum_gate.py   # 规范 §4.3 fail-closed 课程门禁
  twin.py              # 规范 §5 长期孪生：事件溯源 / 版本 / 回滚
  memory.py            # 规范 §8.3–8.6 FSRS 风格记忆模型
  hypothesis.py        # 规范 §6 短期虚拟学生假设集合
  diagnosis.py         # 规范 §7 区分性诊断题选择
  exercise.py          # 规范 §9.2/9.4 干预包与交付校验
  demo_session.py      # Step 2 合成拍题/批改/诊断/复习闭环
  report.py            # Step 2 已授权聚合事件的教师/家长报告
  evaluation.py        # Step 5 独立冻结评测协议（规范 §19，防自证）
  eval_cli.py          # Step 5 可运行评测入口（python -m aeh.eval_cli）
  evolution.py         # Step 6 受控自进化骨架（规范 §27，宿主侧）
  demo.py              # Step 2 命令行入口（python -m aeh.demo）
dsh-plugin/            # Step 3+4+5+6 TypeScript dsh / Cordis 教育插件
  src/index.ts         # Cordis 插件入口（name / inject / apply）
  src/dsh.ts           # 真实 cordis / dsh-tools 薄 authoring 适配层
  src/core/            # 门禁、孪生、FSRS、假设、诊断、干预包
  src/host/            # 内存同意 / HostContext / 孪生 / 交付适配器
  src/host/file-event-store.ts  # Step 5 默认关闭的文件事件存储
  src/host/evolution.ts         # Step 6 宿主侧受控自进化控制面（非工具）
  src/report.ts        # Step 5 聚合报告边界（对应 aeh/report.py）
  src/tools.ts         # 六个教育工具
  src/permissions.ts   # 默认最小权限
  scripts/             # 隔离 loader 加载证据脚本
  tests/               # Node 24 不变量 + 宿主适配器 + 报告 + 持久化 + 自进化 + 契约
  package.json         # 真实 @deepseek-ai/* 依赖（只装在本目录）
docs/
  dsh-integration.md   # Step 3+4+5+6 映射、权限与完成情况
  evaluation-report-template.md  # Step 5 评测报告模板
tests/                 # Python 标准库 unittest 测试
.github/workflows/ci.yml
spec/                  # 规范全文（只读，不修改）
references/            # 本地参考仓库（只读，已被 .gitignore 忽略，不提交）
TASKS.md
```

## 运行测试

要求 Python **3.11** 或 **3.12**，不需要安装依赖：

```bash
python -m unittest discover -s tests -v
```

如果本机只有 `python3` 命令：

```bash
python3 -m unittest discover -s tests -v
```

只跑 Step 2 的测试：

```bash
python3 -m unittest discover -s tests -p 'test_demo_session.py' -v
python3 -m unittest discover -s tests -p 'test_report.py' -v
```

只跑 Step 1 的某个测试文件：

```bash
python3 -m unittest discover -s tests -p 'test_twin.py' -v
```

Step 5 的独立评测（合成数据，离线，无外部服务）：

```bash
python3 -m aeh.eval_cli
python3 -m aeh.eval_cli --json
python3 -m unittest discover -s tests -p 'test_evaluation.py' -v
```

Step 6 的受控自进化骨架（合成数据，离线，纯内存）：

```bash
python3 -m unittest discover -s tests -p 'test_evolution.py' -v
```

Step 3+4+5+6 的插件测试要求 Node **>= 24**。Step 4 起使用真实 `@deepseek-ai/*`
依赖，只安装在 `dsh-plugin/` 内（独立缓存），不会加载进运行中的 dsh，也不读写
`~/.dsh/`：

```bash
cd dsh-plugin
npm install --cache .npm-cache
npm run typecheck          # tsc --noEmit
node --test tests/*.test.ts
npm run evidence:loader    # 隔离 Cordis loader 加载/卸载证据
```

Node 测试分六层：13 个离线不变量测试、12 个宿主适配器测试、8 个报告边界测试、
8 个文件事件存储测试、22 个宿主侧自进化测试、7 个真实 Cordis/dsh 运行时契约测试，
全部使用合成引用，共 70 个。Python 侧共 220 个测试。

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) 在 push 和 pull request 时运行：

- Python 3.11 与 3.12 矩阵：`python -m unittest discover -s tests -v`，以及离线
  `python -m aeh.eval_cli --json`（无外部服务）；
- Node 24 job（工作目录 `dsh-plugin/`，独立缓存）：`npm ci`、`npm run typecheck`、
  `node --test tests/*.test.ts`、`npm run evidence:loader`。

没有 `pip install` 步骤，也没有外部服务或密钥依赖；插件测试依赖公开的
`@deepseek-ai/*` npm 包，不接触任何用户 dsh 配置或运行中的 harness。

## 参考来源与许可证注意事项

`references/` 是本地只读参考目录，**已被 `.gitignore` 忽略，不进入版本库**：

- `references/deepseek-harness/`：DeepSeek Harness / dsh / Cordis 基座，MIT。Step 3
  仅参考其函数插件、`inject`、`ctx.effect` 和 `ctx.tools.register` 结构，本仓库未
  复制其代码。
- `references/MiroFish/`：多 Agent 仿真、GraphRAG、动态记忆的借鉴来源，AGPL-3.0。
  本项目只借鉴机制，不复制整套代码；若未来引入其代码，必须重新评估 AGPL 义务。
- `references/StudentSim/`：虚拟学生行为保真与教学提示响应的借鉴来源；其许可证与
  数据权利需分别核验。本仓库未复制其代码或数据。
- `references/awesome-fsrs/`：FSRS 算法说明与版本参考。本项目使用的是规范 §8.3 的
  示意公式，不绑定任何 FSRS 版本。

规范全文位于 `spec/`，只读；本仓库不修改 `spec/` 与 `references/`。生产实现若采用
特定 FSRS 版本，应按该版本优化器与参数重新校准，而不是把示意公式直接当作生产参数。

## 已知边界 / TODO

Step 1–6 有意不做以下内容，后续步骤再实现：

- 生产级持久化：Step 5 只提供默认关闭的本地文件最小模型（append-only、幂等、
  版本/回滚、保留期、同意撤回删除传播）；跨服务/备份/向量索引的删除传播、加密、
  事务并发、租户/学生访问边界、生产鉴权与审计日志仍未做。
- 真实 OCR、图片脱敏、真实 LLM 生成、真实评分器、数学正确性求解器与内容安全
  服务；演示只使用脚本化合成 fixture。
- 报告插件背后的可信身份网关、同意记录、访问审计与未成年人保护流程；Step 5 的
  报告工具只是策略骨架。
- 评测协议只保证冻结集分片隔离与模拟/真实分离；真实 RCT/对照组、延迟保持、
  跨知识迁移与不良效果测量未做，且本仓库只用合成数据。
- 生产 dsh 会话挂载、真实签名 attestation/KMS、真实交付通道与审批后台、沙箱与
  凭据撤销。Step 4/5/6 只在独立隔离的 Cordis/dsh 实例中完成加载与契约验证；内存
  `src/host/` 适配器、`FileEventStore` 与 `host/evolution.ts` 都不是生产实现。
- 孪生写工具与干预交付工具；它们被有意保留在宿主侧，默认插件不暴露。
- 自进化的真实候选来源检测器（漂移/回归/成本）与 PR/变更单生成、真实冻结评测
  服务、生产灰度/监控接入、跨服务防篡改审计与保留期、真实部署/回滚通道；Step 6
  只交付宿主侧内存/合成骨架。
- 真实学生迁移与延迟保持的校准；当前记忆参数为示意值，小样本仍保留高不确定性。
- 插件输出 schema 收紧、速率限制、locale 与跨进程并发控制；`Config` 尚未改用
  Schemastery 校验。

## 安全约定

- 不提交密钥、令牌、`.env` 或真实学生数据；相关文件已被 `.gitignore` 覆盖。
- 所有真实证据必须来自 `student` / `teacher` / `trusted_grader` / `assessment` 等
  可信来源；模拟来源只能进入隔离的 simulated 存储。
- 任何 mastery 更新必须引用已存在的真实证据 id；模拟事件不能被提升为真实证据。
- 演示只构造合成学生与合成事件；报告只接收聚合事件，不接收孪生原始事件、图片、
  题目或作答文本。
- Step 5 聚合报告工具的 schema 闭合且 `report.ts` 有运行时白名单，原始字段在
  编译与运行两层都被拒绝；输出不含事件引用或原始数据。
- Step 5 文件事件存储默认关闭，只接受 `synthetic.*` / `demo.*` 学生引用与
  `syntheticRoot` 内目录，持久化记录不含 payload；撤回 `twin:observe` 后读写与
  加载都 fail closed。
- Step 5 评测协议把模拟收益与真实迁移硬隔离：模拟数据不能进入真实通道，也不能
  用于自证真实学习效果；报告显式声明无真实证据。
- Step 6 自进化候选只能是声明式配置/策略/提示模板变更记录，不能触及课程门禁、
  权限、隐私、真实-模拟隔离等受保护不变量，不能写生产文件；审批默认拒绝、灰度仅
  合成会话比例、带熔断与回滚，全链路追加式审计不含原始学生数据。审批与回滚只在
  宿主侧调用，不新增模型工具。
- Step 3+4+5+6 插件只接收 opaque `studentRef` 与宿主授权快照；默认无原始数据、DB 写、
  凭据、文件或网络权限，observed 孪生写、干预交付与自进化审批/回滚不属于模型工具。
  隔离测试只使用合成引用，不读写 `~/.dsh/`，也不加载进运行中的 harness 会话。
