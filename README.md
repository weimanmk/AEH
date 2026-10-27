# AEH — Adaptive Cognitive Twin Education Harness

AEH 是一个**规范驱动**的自适应教育 Harness 核心骨架。本仓库对应
[`TASKS.md`](TASKS.md) 的 **Step 1 + Step 2 + Step 3 + Step 4**：Step 1 用 Python
标准库实现可测试的核心机制；Step 2 在核心之上增加一个完全离线的合成演示会话，
以及只消费已授权聚合事件的教师/家长报告；Step 3 增加一个 TypeScript 的 dsh /
Cordis 教育插件骨架；Step 4 把插件骨架的离线适配层替换为真实的
`@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools`，并在**独立隔离**的 Cordis/dsh
实例中完成加载、契约与卸载验证，同时补齐内存宿主适配器。

当前状态：**核心骨架 + 合成演示 + 已在隔离实例中验证的插件，不是生产系统**。
Python 模块无第三方依赖，CI 不需要 `pip install`；插件使用真实 `@deepseek-ai/*`
依赖，依赖只安装在 `dsh-plugin/` 内（独立缓存），不会加载进任何正在运行的 dsh
会话，也不读写 `~/.dsh/`。

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
  短期假设、诊断选择和干预包准备映射为五个默认最小权限工具；孪生写与干预交付
  仍由宿主负责，模型无法绕过门禁或直接发题。插件已用真实 cordis/dsh-tools 依赖
  在隔离实例中完成加载、schema、取消、超时与卸载契约测试。

## 这不是什么

- 不是完整的教学系统、App 或生产服务；没有数据库、生产鉴权、多租户隔离、真实
  LLM 或真实学生数据接入。Step 4 的插件只在**独立隔离**的 Cordis/dsh 测试实例中
  加载验证，没有加载进任何正在运行的 dsh 会话；内存宿主适配器不是生产实现。
- 不是真实 OCR、拍照 App 或通用数学判题器。演示中的“照片”、OCR、学生步骤和判题
  结果都是内存中的合成 fixture，不读文件、不连网、不调用模型。
- 报告生成器不是完整的同意管理或访问控制服务；它只实现“授权聚合事件进、
  最小化聚合报告出”的策略骨架，真实部署仍需服务端身份、同意、审计与保留期。
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
| 报告只用已授权聚合事件，不输出原始数据或事件 ID | `aeh/report.py` | `tests/test_report.py` |
| 插件默认最小权限；无原始数据、DB 写、凭据、文件或网络访问 | `dsh-plugin/src/permissions.ts` | `dsh-plugin/tests/invariants.test.ts` |
| 孪生写与干预交付属于宿主；模型不能绕过门禁或直接发题 | `dsh-plugin/src/tools.ts`、`dsh-plugin/src/core/twin.ts` | `dsh-plugin/tests/invariants.test.ts` |

另外，`tests/test_invariants.py` 用端到端断言直接命名并覆盖了 TASKS.md 要求的四条
Step 1 不变量。Step 2 的测试额外覆盖“演示不接真实数据”和“报告不泄露原始数据”；
Step 3 的离线测试覆盖插件侧的模拟隔离、证据绑定 mastery、门禁复检、FSRS 质量权重、
假设归一化、训练/迁移隔离和默认权限拒绝。

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
机制映射为教育服务与五个模型可调用工具。完整映射、权限表和接入清单见
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

五个工具都是“计算/准备”型：不写数据库、不写长期孪生、不直接交付题目。
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

13 个离线测试覆盖门禁拒绝、preview 锁定、模拟事件隔离、证据绑定 mastery、回滚、
阅读/提示/独立作答权重、FSRS 反解、假设归一化、诊断门禁复检与跳过、干预包
训练/迁移隔离、默认权限拒绝、插件注册与卸载，以及无宿主授权时的 fail-closed。

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
- 加载证据：`npm run evidence:loader` 在独立实例中打印挂载的 5 个工具、门禁决策
  与各错误码，卸载后工具归零。命令与完整输出见
  [`docs/dsh-integration.md`](docs/dsh-integration.md) 第 9 节。

**仍未完成**（文档中如实列出，未假装实现）：生产鉴权/KMS/签名 attestation、
持久化孪生存储、租户隔离、保留期与删除传播、真实交付 UI/LMS 与审批后台、独立
评测与回滚流水线、报告插件、自进化流水线、输出 schema 收紧、locale/速率限制、
FSRS 生产校准。本轮**只准备、不交付**，也不引入真实学生数据或密钥。

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
  demo.py              # Step 2 命令行入口（python -m aeh.demo）
dsh-plugin/            # Step 3+4 TypeScript dsh / Cordis 教育插件
  src/index.ts         # Cordis 插件入口（name / inject / apply）
  src/dsh.ts           # 真实 cordis / dsh-tools 薄 authoring 适配层
  src/core/            # 门禁、孪生、FSRS、假设、诊断、干预包
  src/host/            # 内存同意 / HostContext / 孪生 / 交付适配器
  src/tools.ts         # 五个教育工具
  src/permissions.ts   # 默认最小权限
  scripts/             # 隔离 loader 加载证据脚本
  tests/               # Node 24 不变量 + 宿主适配器 + 真实运行时契约测试
  package.json         # 真实 @deepseek-ai/* 依赖（只装在本目录）
docs/
  dsh-integration.md   # Step 3+4 映射、权限与 P0 完成情况
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

Step 3+4 的插件测试要求 Node **>= 24**。Step 4 起使用真实 `@deepseek-ai/*` 依赖，
只安装在 `dsh-plugin/` 内（独立缓存），不会加载进运行中的 dsh，也不读写 `~/.dsh/`：

```bash
cd dsh-plugin
npm install --cache .npm-cache
npm run typecheck          # tsc --noEmit
node --test tests/*.test.ts
npm run evidence:loader    # 隔离 Cordis loader 加载/卸载证据
```

Node 测试分三层：13 个离线不变量测试、12 个宿主适配器测试、6 个真实
Cordis/dsh 运行时契约测试，全部使用合成引用。

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) 在 push 和 pull request 时运行：

- Python 3.11 与 3.12 矩阵：`python -m unittest discover -s tests -v`；
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

Step 1/2/3/4 有意不做以下内容，后续步骤再实现：

- 持久化存储、租户/学生访问边界、数据删除向派生存储的传播、生产鉴权与审计日志。
- 真实 OCR、图片脱敏、真实 LLM 生成、真实评分器、数学正确性求解器与内容安全
  服务；演示只使用脚本化合成 fixture。
- 报告生成器背后的可信身份网关、同意记录、访问审计、保留期与删除传播。
- 生产 dsh 会话挂载、真实签名 attestation/KMS、真实交付通道与审批后台、沙箱与
  凭据撤销。Step 4 只在独立隔离的 Cordis/dsh 实例中完成加载与契约验证；内存
  `src/host/` 适配器不是生产实现。
- 孪生写工具与干预交付工具；它们被有意保留在宿主侧，默认插件不暴露。
- 自进化的候选—隔离评测—批准—灰度—回滚流水线。
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
- Step 3+4 插件只接收 opaque `studentRef` 与宿主授权快照；默认无原始数据、DB 写、
  凭据、文件或网络权限，observed 孪生写与干预交付不属于模型工具。隔离测试只使用
  合成引用，不读写 `~/.dsh/`，也不加载进运行中的 harness 会话。
