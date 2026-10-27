# AEH — Adaptive Cognitive Twin Education Harness

AEH 是一个**规范驱动**的自适应教育 Harness 核心骨架。本仓库对应
[`TASKS.md`](TASKS.md) 的 **Step 1 + Step 2 + Step 3 + Step 4 + Step 5 + Step 6 + Step 7 + Step 8 + Step 9 + Step 10 + Step 11 + Step 12 + Step 13 + Step 14 + Step 15 + Step 16 + Step 17 + Step 18**：
Step 1 用 Python 标准库实现可测试的核心机制；Step 2 在核心之上增加一个完全离线的
合成演示会话，以及只消费已授权聚合事件的教师/家长报告；Step 3 增加一个 TypeScript
的 dsh / Cordis 教育插件骨架；Step 4 把插件骨架的离线适配层替换为真实的
`@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools`，并在**独立隔离**的 Cordis/dsh
实例中完成加载、契约与卸载验证，同时补齐内存宿主适配器；Step 5 增加只接收已授权
聚合事件的报告工具、默认关闭的本地文件事件存储（保留期与同意撤回删除传播），
以及独立冻结的评测协议（模拟收益与真实迁移严格分离）；Step 6 增加**宿主侧**受控
自进化骨架（候选登记 → 隔离评测 → 默认拒绝审批 → 合成灰度/熔断 → 晋升/回滚 →
追加式审计），不新增模型可调用的自进化工具；Step 7 完成 P1 加固：Schemastery 配置
校验 fail loud、六个工具的闭合输出 schema、绑定 dsh session/agent scope 的假设快照
（TTL/隔离/清理，不写长期孪生），以及追加式脱敏审计（门禁拒绝原因、工具调用、审批
与交付回执，带不可反识别的学生/租户维度）；Step 8 在工具入口加固：提示注入/越权参数/
超大 payload/单实例速率限制 fail-closed 并记入审计，错误与日志脱敏；Step 9 增加课程知识
空间：版本化 KC 图（前置闭包/环检测/非法图拒绝）、带版本与审核记录的题库、本地内存
RAG 检索接口，以及“检索结果必须再过课程门禁 + 前置闭包”的候选准入；Step 10 增加习题
演化引擎（数值/情境/干扰项/难度/诊断指向性变式，每个候选带来源、声明式变更与受影响
KC，先过课程门禁再进隔离沙箱评测）与动态模拟实验室（独立会话状态与独立假设快照、
模拟事件永不写入 `observed`、实验配置与结果可用 seed/配置版本/结果摘要复现，模拟收益
与真实迁移分通道报告）。Step 9 与 Step 10 只使用合成标注，不包含真实题目原文、答案、
提示或学生数据；Step 11 增加 FSRS 参数校准（从合成 review 序列确定性拟合
stability/difficulty 动力学参数，带 seed/数据版本/参数版本可复现指纹、bootstrap 不
确定性与适用性声明，只产出参数候选，经隔离评测 + 显式宿主批准才激活，模拟收益与真实
迁移分通道报告，激活只返回冻结配置对象、绝不写掌握度或孪生）。Step 12 增加**长期
孪生体生命周期**：真实事件 append-only 事件溯源（版本/checkpoint/回滚/重放只回退推断
状态、不动真实证据）、观察与模拟严格隔离、多 KC FSRS 记忆（stability/difficulty 随
时间衰减 + 复习更新，逾期只升不确定性）、校准参数先挂起再显式批准、假设集随证据演化并
绑定孪生版本。Step 13 补全**虚拟学生群（规范 §6）**：生成/匹配/分裂/合并/淘汰的完整
规则、`unknown` 桶管理、假设保真度指标（规范 §19.3），以及假设快照的会话隔离与
“绝不写长期孪生”持久化边界；Python 与 TypeScript 双实现共享合成 fixture，行为一致。
Step 14 补全主动诊断（规范 §7）：从首个偏离步骤反向展开误解/先修/偶发失误解释、把
“不确定的答案”加入信息增益、以及带确定性终止原因的诊断会话状态机与负担上限。Step 15
增加教学策略层（规范 §10）：fail-closed 的策略路由（诊断题/最小提示/示范/微课/定向
练习/迁移/间隔复习/进度确认/直接回答）、预习—学校—AI 强化—复习的日常协同与动态时间
分配、可执行的检索/间隔/交错学习科学计划，以及学科无关的 KC/证据/策略接口与数学、
物理两个示例（规范 §17/§18）；仍是合成内容，不新增模型工具。Step 16 补齐数据模型、
存储服务与 Harness 状态机（规范 §12/§13/§15.3）：事件存储、Profile/Bundle、内容库、
评测服务的接口定义与内存/文件双实现，乐观并发、幂等键、写入协调，以及 23 状态学习
闭环与 12 条失败/退化分支。Step 17 补齐隐私、安全、未成年人保护与指标面板（规范
§20/§21）：追加式监护人/学生同意账本（fail-closed）、按受众收窄的访问范围、跨存储
保留期与删除传播回执、去标识审计导出与稳定摘要，以及学习/系统/成本指标注册表与
**从不接入真实计费**的合成成本估算接口。Step 18 做**独立隔离实例中的真实会话
验收**：在 `step18/` 下自建 `DSH_HOME`、profile 与 `@deepseek-ai/dsh@0.2.1-rc.3`
本地安装，用合成宿主入口把真实插件挂进 dsh，经 Sidrune `deepseek-v4-1-flash` 跑通
一次“门禁 → 诊断 → 复习 → 报告”六工具会话，命令/事件流/会话日志/摘要全部落盘。

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
- 一个版本化课程知识空间：KC 图只把审核通过的 `REQUIRES` 边当作先修关系，支持
  传递前置闭包、拓扑序、环检测与版本 diff；题库带结构化标注、版本历史与追加式审核
  记录；本地内存检索只返回 opaque `itemId` 与标注摘要，命中后仍必须通过课程门禁和
  前置闭包检查才能成为候选。
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
- 一个习题演化引擎（Python `aeh/exercise_evolution.py` + TypeScript
  `dsh-plugin/src/core/exercise-evolution.ts`）：五种受控算子（数值/情境/干扰项/难度/
  诊断指向性变式）只重采样合成参数与情境，不生成题干文本；每个候选都带来源 item 与
  版本、声明式变更、受影响 KC 和确定性 seed，先通过 fail-closed 课程门禁与前置闭包
  检查，再进入隔离沙箱评测；候选池只接受“沙箱筛查合格 + 题库审核通过”的候选。
- 一个动态模拟实验室：模拟会话使用独立状态与独立假设快照，事件日志只接受 simulated
  来源，`observedWrites` 恒为 0；配置（seed/版本/场景）与结果内容寻址，可用整数微单位
  指纹复现；模拟收益与真实迁移分开报告，模拟收益永不支撑真实学习或迁移结论。

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
| KC 图拒绝环/自环/未知端点/重复边；只有 approved `REQUIRES` 进入前置闭包 | `aeh/curriculum_graph.py`、`dsh-plugin/src/core/curriculum-graph.ts` | `tests/test_curriculum_graph.py`、`dsh-plugin/tests/curriculum-graph.test.ts` |
| 题库版本化、审核记录追加、缺失标注不可批准；低置信度仍被门禁拒绝 | `aeh/curriculum_graph.py`、`dsh-plugin/src/core/curriculum-graph.ts` | 同上 |
| 检索只返回 opaque id + 标注摘要；命中必须再过门禁与前置闭包，前置未满足不交付 | `aeh/curriculum_graph.py`、`dsh-plugin/src/core/curriculum-graph.ts`、`dsh-plugin/src/service.ts` | 同上 + `dsh-plugin/tests/curriculum-graph.test.ts` 的 HostContext/loader 绑定用例 |
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
| 演化候选带来源/变更/受影响 KC，先过课程门禁与前置闭包再进隔离沙箱 | `aeh/exercise_evolution.py`、`dsh-plugin/src/core/exercise-evolution.ts` | `tests/test_exercise_evolution.py`、`dsh-plugin/tests/exercise-evolution.test.ts` |
| 模拟会话隔离、模拟事件绝不写入 `observed`；配置与结果可复现 | `aeh/exercise_evolution.py`、`dsh-plugin/src/core/exercise-evolution.ts` | 同上 |
| 模拟收益与真实迁移分通道报告；候选池不能绕过沙箱筛查与题库审核 | `aeh/exercise_evolution.py`、`dsh-plugin/src/core/exercise-evolution.ts` | 同上 |

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
（Step 9 后 `node --test tests/*.test.ts` 共 131 个测试，见下文。）

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
独立评测与回滚通道、locale、跨进程分布式限流、FSRS 生产校准。报告工具与
独立冻结评测协议已在 Step 5 完成最小实现，宿主侧受控自进化骨架已在 Step 6 完成
（均仍为合成/内存实现）；输出 schema 收紧、会话状态与脱敏审计在 Step 7 完成，
工具入口的注入/越权/payload/单实例限流/错误脱敏在 Step 8 完成（见下文，仍是
内存/合成实现）。本轮**只准备、不交付**，也不引入真实学生数据或密钥。

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

## Step 7：P1 加固——配置与输出 schema、会话状态、审计

Step 7 只在 `dsh-plugin/` 与文档内工作，不修改运行用 dsh（`~/.dsh/`、
`~/workspace/deepseek-harness` 克隆、npx 安装的 dsh），不把插件加载进正在执行本任务的
harness 会话，全部使用合成数据；`references/` 与 `spec/` 只读。

### 7.1 Schemastery 配置校验（fail loud）

`dsh-plugin/src/config.ts` 用 Schemastery 定义 `AEH_CONFIG_SCHEMA`（`profile`、
`targetRetention ∈ (0,1)`、`allowedModes`），插件入口把同一个 schema 导出为 Cordis 的
`Config`：

- Cordis / Cordis loader 在 `apply` 运行前校验并填默认值；非法值抛 `ValidationError`
  （如 `$.targetRetention expected number <= 1`、非法 `profile`），**不会**静默回退默认值；
- `apply` 与 `AehEducationService` 通过 `resolveAehConfig` 复用同一 schema，直接/嵌入式
  调用也只有一条校验路径；
- 显式 `undefined` 视为未提供并使用默认值；越界值仍 fail loud；
- `host` / `permissions` 是宿主注入的不可序列化对象，按 `any()` 透传，不写入 YAML。

### 7.2 六个工具的闭合输出 schema

`dsh-plugin/src/output-schemas.ts` 为六个工具各定义一个顶层
`type: 'object'` + `additionalProperties: false` 的输出 schema，替换原先宽松的
`type: 'json'`。dsh-tools 在执行每个工具后用该 schema 校验返回值，越界返回变成
`INVALID_TOOL_OUTPUT`（`tests/step7.test.ts` 用真实 ToolRuntime 验证），而不是静默
到达模型。动态 key 的映射（假设权重、预测、`itemDecisions`）在嵌套层使用
`additionalProperties: true`（该 JSON Schema 子集不支持带类型的
`additionalProperties`），但每个声明对象本身的字段集仍闭合。

### 7.3 会话级假设快照（session/agent scope + TTL + 清理）

`dsh-plugin/src/host/session-state.ts` 的 `SessionSnapshotStore`：

- 每个快照绑定 `(sessionId, agentId)`；不同 session 或不同 agent 读取一律
  `undefined`，不会被“领养”；
- 明确 TTL（默认 15 分钟，可注入时钟与 id 工厂用于确定性测试），过期即删除，并有
  `sweep()` / `cleanupExpired()` 与每 scope / 全局限额（淘汰最旧，容量约束 fail loud
  而非静默丢弃）；
- `endSession(sessionId)` 清除该 session 的所有 agent scope；插件入口把
  `session/disposed` 桥接到 `endSession` 并写一条 `session.cleanup` 审计，卸载时
  `clear()` 丢弃全部快照；
- 存储与 `StudentTwin` / `MemoryHostTwin` 没有读写路径，测试断言快照往返后孪生
  `version` 与 `evidenceRevision` 不变；
- 工具 `aeh_update_hypotheses` 在缺少 `exec.agent.id` 时拒绝 `snapshotRef` 复用
  （fail closed），有 scope 时返回 `snapshotRef` / 过期时间 / TTL / scope 标记。

### 7.4 追加式脱敏审计

`dsh-plugin/src/host/audit-log.ts` 的 `AehAuditLog` 是 append-only（无 update/delete
API，容量满时 fail loud）：

- 记录 `gate.decision`（含机器可读拒绝原因码）、`tool.call`（只记工具名与
  accepted/rejected，不记参数）、`approval.record`、`delivery.receipt`、
  `session.cleanup`；
- `detail` 只允许标量或标量数组，并递归拒绝 `answer` / `question` / `image` /
  `payload` / `prompt` / `trace` / `studentName` 等原始学生数据键；工具调用审计不含
  参数（测试断言题目 id 不出现在审计 JSON 中）；
- 学生/租户维度以 `sha256(salt, tenantRef, ref)` 伪名存 `studentKey` / `tenantKey`，
  原始 `studentRef` / `tenantRef` 不落库；salt 由宿主注入（默认每进程随机），文档明确
  这是伪名化而非匿名化；
- `metrics()` 只输出计数与伪名 key，`ApprovalLedger` / `HostDeliveryAdapter` 接受可选
  audit，把审批与交付回执（含 idempotent 重放不重复计数）写入同一日志。

### 7.5 本地验证与隔离边界

- `python3 -m unittest discover -s tests -v`：220 通过（未改 Step 1–6 行为）；
- `cd dsh-plugin && npm run typecheck`：通过；
- `node --test tests/*.test.ts`：93 通过（新增 `tests/step7.test.ts` 23 个）；
- `npm run evidence:loader`：独立隔离实例中挂载/卸载 6 个工具，输出与 Step 4 一致；
- 隔离边界仍与 Step 4–6 相同：只在本目录安装依赖（`.npm-cache`），不读写 `~/.dsh/`，
  不改参考克隆或 npx dsh，不把插件加载进本任务会话；
- **未完成**：真实 KMS/签名 attestation 与不可篡改审计存储、跨进程/跨服务审计汇聚与
  保留期、法定监护人同意网关、真实多租户会话存储、locale 与速率限制（安全加固留待
  Step 8）。

## Step 8：工具入口安全加固（提示注入 / 越权 / payload / 限流 / 脱敏）

Step 8 只在 `dsh-plugin/` 与文档内工作，不修改运行用 dsh（`~/.dsh/` 配置与存储、
`~/workspace/deepseek-harness` 源码克隆、npx 安装的 dsh），不把 AEH 插件加载进正在
执行本任务的 harness 会话，全部使用合成数据；`references/` 与 `spec/` 只读，`aeh/`
的 Python 核心行为未改。新增 `dsh-plugin/src/security.ts` 与
`dsh-plugin/tests/security.test.ts`。

### 8.1 提示注入防护

`src/security.ts` 的 `INJECTION_PATTERNS` 与 `SecurityGuard.assertArgumentSafety`
在工具体运行前递归扫描参数中的字符串与键名，覆盖中英文的 prompt 覆盖、角色冒充、
门禁覆盖、权限提升、报告受众变更、审批绕过与密钥套取。命中即抛
`SecurityError(AEH_INJECTION_REJECTED)`，工具体不执行、决策状态不变，并把
`instruction_pattern:<category>` 与参数路径写入追加式审计（只记原因码与路径，
不记原文）。模式锚定“动词 + 受保护对象”，普通课程描述和 `kc.fraction.add` 这类
opaque id 不会误伤。

### 8.2 越权防护

伪造的进度、标注、scope、`studentRef` 仍然只经宿主 `HostContext.resolveProgress` /
`resolveItem` 解析，解析不到即 fail-closed；`security.test.ts` 断言伪造标注不能让
未知 item 通过门禁、另一学生引用得到 `progress_unavailable`、无宿主时内联 progress
仍拒绝、报告 scope 只能收窄且跨学生事件被排除。`SecurityGuard` 另外拒绝会冒充宿主
决策对象的参数键（`gateOverride` / `permissions` / `studentRawData` /
`audienceOverride` / `approvalId` 等），返回 `AEH_UNAUTHORIZED_ARGUMENT`。

### 8.3 超大 payload 拒绝

按 `config.ts` 中 Schemastery 校验的 `security.limits`（默认字符串 4096、数组 256、
对象键 128、深度 12、序列化 131072 字节）递归拒绝超长字符串/数组、过多键、过深嵌套、
总字节超限与循环引用，统一返回 `AEH_PAYLOAD_TOO_LARGE` +
`payload_too_large:<kind>`，错误不回显原始值。非法上限在 `apply` 前 fail loud。

### 8.4 速率限制

`SecurityGuard` 用两个固定窗口分别按 dsh session/agent scope 与 opaque `studentRef`
计数（默认每 60 秒 session 120 次、学生 240 次），超限返回 `AEH_RATE_LIMITED`；超限
只影响当前窗口的当前调用，其他 session/学生不受影响，窗口过期后自动恢复。限流桶只
保留会话/学生键，不写日志、不产出指标。

### 8.5 错误与日志脱敏

工具抛出的错误在离开 body 前由 `redactThrown` 去掉绝对路径、`file://` URL 与密钥
样式 token 并压平换行；`AehAuditLog` 继续只接受标量/原因码、递归拒绝题目/答案/图片/
prompt/payload/密钥类键，工具审计从不记录参数。`SecurityError` 继承 dsh
`HarnessError`，真实 `ToolRuntime` 会把稳定 `info.code` 暴露给调用方。

### 8.6 本地验证与隔离边界

- `python3 -m unittest discover -s tests -v`：220 通过（Step 8 未改 Python 行为）；
- `cd dsh-plugin && npm run typecheck`：通过；
- `node --test tests/*.test.ts`：112 通过（新增 `tests/security.test.ts` 19 个）；
- `npm run evidence:loader`：在独立隔离实例中新增 `AEH_INJECTION_REJECTED` 证据；
- 隔离边界与 Step 4–7 相同：只在本目录 `dsh-plugin/` 安装依赖（`.npm-cache`），
  不读写 `~/.dsh/`，不改参考克隆或 npx dsh，不把插件加载进本任务会话；
- **未完成**：跨进程/跨副本分布式限流、按工具/租户差异化配额、locale 展示、
  对抗性注入（同形字/编码混淆/多轮外泄）的持续红队，以及真实身份/同意网关。

## Step 9：课程图谱与题库（规范 §3）

Step 9 只在 `aeh/`、`dsh-plugin/`、`tests/` 与文档内工作，不修改运行用 dsh
（`~/.dsh/` 配置与存储、`~/workspace/deepseek-harness` 源码克隆、npx 安装的 dsh），
不把 AEH 插件加载进正在执行本任务的 harness 会话；`references/` 与 `spec/` 只读。
所有图节点、边、题目标注、审核人和学生引用均为合成内容；题库记录**不包含**题干、
答案、提示、解题步骤或图片，只保存结构化标注与版本/审核元数据。

### 9.1 Python 核心：`aeh/curriculum_graph.py`

- **KC 图**：`KnowledgeGraph` 是不可变、带版本号的图。节点与边先校验：未知节点类型/
  关系/边状态、重复节点、重复边、自环、未知端点、`confidence` 越界一律拒绝。
  `REQUIRES` 与 `PART_OF` 的 approved 边还要通过环检测；非法版本不会进入
  `KnowledgeGraphStore`。
- **边方向与可信度**：`A --REQUIRES--> B` 表示 A 需要先学 B，因此
  `prerequisite_closure(A)` 包含 B 及其传递前置。只有 `approved` 边是权威前置；
  LLM/统计产生的 `proposed` 边保留在图中供审核，但不进入闭包、不算先修、也不触发
  环拒绝。
- **版本化**：`KnowledgeGraphStore` append-only，版本必须严格递增；每个版本有
  SHA-256 内容摘要（完整性，不是签名），`diff(from, to)` 给出新增/删除的节点与边。
  Python 与 TypeScript 使用同一套 canonical JSON 规则，测试断言共享 fixture 的图哈希
  完全一致。
- **题库**：`ItemAnnotation` 覆盖规范 §3.3 的核心标签（source/license/stage/course、
  KC、Q-matrix、难度、题型、时长、verifier、安全/内容/正确性标注、置信度等）；
  `ItemBank` 保存不可变版本历史与追加式审核记录（submit/approve/reject/
  request_changes）。内容修订会产生新版本、版本号递增，并把审核状态重置为
  `draft`；旧版本的批准不能自动继承。缺失标注的条目可以被保存为草稿，但不能被
  批准，且 `to_curriculum_item()` 会显式标记 `annotations_complete=False`，课程门禁
  以 `incomplete_annotations` 拒绝。
- **低置信度**：批准不替代门禁；即使条目已批准，`annotation_confidence` 低于阈值
  仍会被 `allow()` 以 `low_annotation_confidence` 拒绝（fail-closed）。
- **本地内存 RAG**：`ItemBank.search(RetrievalQuery)` 只索引当前 approved 版本，按
  KC（required KC 与 Q-matrix）、难度区间/目标、题型做合取过滤，返回 opaque
  `itemId`、分数与标注摘要；`RetrievalHit.summary()` 没有题干/答案/提示/解法字段。
- **检索后门禁**：`plan_retrieval()` 先检索，再对每个命中重新解析当前 item、跑
  `allow()`，并检查传递前置闭包。只有同时通过两者的命中进入 `candidates`；前置
  未满足得到 `prerequisites_not_met:<kc>`，未知 KC 得到 `kc_not_in_graph:<kc>`，
  图缺失得到 `blocked_reason="graph_unavailable"`。因此**前置未满足的 KC 对应题目
  不会交付**。

### 9.2 TypeScript 对应实现与宿主边界

- `dsh-plugin/src/core/curriculum-graph.ts` 是 Python 模块的逐项对应：同样的常量、
  错误类别、图校验/闭包/拓扑序/版本 diff、题库版本与审核状态机、检索评分和拒绝
  原因字符串。
- `HostContext` 新增可选的 `resolveGraph()` 与 `retrieveItems(query)`；
  `MemoryHostContext` 可接收宿主构造的 `itemBank` 与 `graph`，把题库当前版本加入
  可读 catalog，并在撤回 `curriculum:read` 后让图、题库 item 与检索结果一起
  fail-closed。`toHostBinding()` 也显式转发这两个方法，保证 Cordis loader 只复制
  数据属性时授权闭包仍然有效。
- `AehEducationService.retrieveCandidatesFor(studentRef, query, mode)` 的流程是：
  宿主解析 progress → 宿主解析图/检索 → 逐条 `resolveItem` → 现有
  `checkCurriculum` 门禁 → 前置闭包检查。`hits` 只是不可交付的 opaque 摘要，
  `candidates` 才是可进入后续准备流程的子集；没有图、没有检索适配器、未知 item、
  未知 KC 或前置未满足都只产生拒绝，不会产生候选。
- 未新增模型可调用工具：Step 9 的检索接口是宿主/服务层 API，插件工具目录仍是六个。
  这避免模型直接控制题库、图或绕过门禁；真实部署中“把候选转成工具输出”仍需宿主
  审批与交付流程。

### 9.3 测试与隔离验证

- Python：`tests/test_curriculum_graph.py`（22）覆盖闭包/拓扑序、环/自环/重复/未知
  端点拒绝、proposed 边不入闭包、版本 append-only 与 diff、题库修订/审核状态机、
  缺失标注不可批准与门禁 fail-closed、检索过滤、前置未满足拒绝、缺失图/未知 KC
  拒绝，以及共享 fixture 的哈希/顺序/分数/候选/拒绝原因。
- TypeScript：`dsh-plugin/tests/curriculum-graph.test.ts`（19）覆盖同一组行为，并
  额外覆盖 `MemoryHostContext` 的图/题库解析、`toHostBinding()` 闭包、同意撤回、
  服务层检索后门禁与未知命中拒绝。
- 共享 fixture：`tests/fixtures/curriculum_step9.json`（合成）同时被 Python 与
  TypeScript 读取；图内容哈希、前置闭包、拓扑序、检索分数、候选与拒绝原因必须
  完全一致。
- 全量结果：`python3 -m unittest discover -s tests -v` 242 通过；
  `node --test tests/*.test.ts` 131 通过；`npm run typecheck` 通过；
  `npm run evidence:loader` 仍在独立隔离 Cordis/dsh 实例中成功（仅加载既有六个工具，
  未把插件加载进本任务会话）。
- **未完成/残留**：真实教材/文档索引、BM25/向量/交叉编码重排、生产图数据库与题库
  服务、真实教师审核工作流与权限、真实题目文本/答案/图片的存储与版权/安全审核、
  跨租户图谱隔离、图变更的审批与回滚流程、把检索候选接入真实交付/UI。当前实现是
  合成数据上的内存模型，不宣称生产可用。

## Step 10：习题演化引擎与动态模拟实验室（规范 §9、§11）

Step 10 继续只在 `aeh/`、`dsh-plugin/`、`tests/` 与文档内工作，不修改运行用 dsh
（`~/.dsh/` 配置与存储、`~/workspace/deepseek-harness` 源码克隆、npx 安装的 dsh），
不把 AEH 插件加载进正在执行本任务的 harness 会话；`references/` 与 `spec/` 只读。
演化只操作结构化的合成标注与受控参数，**不生成题干、答案、提示或图片文本**；模拟
实验室只在内存中对合成行为模型采样，不写任何 `observed`/真实存储。

### 10.1 Python 核心：`aeh/exercise_evolution.py`

- **五种受控算子**：`numeric`（在同一 KC 与年级带内重采样数值参数）、`context`
  （替换表层情境，结构不变）、`distractor`（仅限 `multiple_choice`，重生干扰项并
  保持正确项与所需推理不变）、`difficulty`（在 [0,1] 内调节难度并按比例缩放预计
  时长）、`diagnostic`（把变式指向某个误区，使两个假设产生不同的可观察步）。
- **来源与可追溯**：`EvolutionCandidate` 携带 `provenance`（来源 item id 与版本、
  算子、声明式 `changes`、受影响 KC、确定性 seed、生成器版本）；候选
  `candidate_id = cand.<source>.<operator>.<seed>`、`proposed_item_id =
  evo.<source>.<operator>.<seed>`，演化后的标注 `source` 标记为
  `synthetic.evolved.<operator>`、`exposure_count` 归零，并冻结为内容寻址哈希。
- **fail-closed 校验**：`ExerciseEvolutionEngine.validate()` 复用课程门禁 `allow()`
  并检查缺失标注、缺失图与传递前置闭包；未授/超前 KC、低进度置信度、缺失前置、
  未知 KC、标注不完整或图缺失都使候选无效。
- **隔离沙箱**：只有通过门禁的候选才进入 `EvolutionSandbox`。沙箱用独立假设快照
  跑模拟，产出 `simulated_benefit`（永远 `is_causal_evidence=false`）与独立的
  `real_transfer` 通道；没有真实冻结迁移集与独立观测就永远是
  `promotion_blocked:real_transfer_evidence_missing`，绝不把模拟收益当作真实效果。
- **候选池**：`EvolutionCandidatePool.admit()` 要求候选可交付（沙箱筛查通过）、
  item-bank 记录为同一 `proposed_item_id` 且已 `approved`、`observed_writes == 0`；
  否则抛 `CandidatePoolError`。演化**不能绕过**课程门禁或题库审核。

### 10.2 动态模拟实验室

- **会话隔离**：每个 `SimulationSession` 从快照构造**私有** `HypothesisSet`，对
  会话重加权不会改动源假设；事件日志 `SimulationEventLog` 只接受
  `simulated`/`virtual_student`/`simulation` 来源，任何真实来源都抛
  `SimulationIsolationError`；`observedWrites` 恒为 0。
- **可复现**：`SimulationConfig`（config 版本、场景、候选、seed、阶段计划、
  maxSteps）与 `HypothesisSnapshot` 都做 canonical JSON 内容寻址；结果指纹只对整数
  微单位（概率、正确率、增益、置信区间）与逐步 `phase/item/hypothesis/correct`
  计算，因此 Python 与 TypeScript 在相同 seed/配置/快照上得到**逐字节一致**的结果
  指纹。
- **分通道报告**：`SimulationResult.real_transfer` 恒为 `null`，`simulated_benefit`
  显式标注 `channel="simulated"` 与 `is_causal_evidence=false`；真实迁移只能来自
  可信来源（`student`/`teacher`/`trusted_grader`/`assessment`）与冻结的 unseen
  迁移集，且仍然只作描述性结论（`causal_claim_supported=false`）。

### 10.3 TypeScript 对应实现与确定性

- `dsh-plugin/src/core/exercise-evolution.ts` 与 Python 版逐项对应：同样的算子集合、
  错误类别、候选哈希、沙箱裁决、候选池准入规则与模拟指纹；因 TS 侧没有评测模块，
  真实迁移通道在该文件内联实现（冻结迁移集 + 可信来源 + unseen + 单来源校验）。
- **确定性原语双实现**：`mulberry32`（用 `Math.imul` 模拟 32 位运算）、FNV-1a 32、
  JS 舍入语义 `jsRound(x)=floor(x+0.5)`、四位小数 `round4` 与整数微单位
  `quantizeMicros` 在 Python/TypeScript 两侧行为一致。
- **未新增模型工具**：Step 10 的引擎与实验室是核心/宿主侧 API，插件工具目录仍是六个。

### 10.4 测试与隔离验证

- Python：`tests/test_exercise_evolution.py`（48）覆盖 RNG/哈希原语、五种算子、
  provenance、门禁/前置/缺失图 fail-closed、沙箱独立通道、真实迁移 gating、候选池
  必须“沙箱合格 + 审核通过”、模拟隔离与不可复现 seed 的区分，以及共享 fixture
  的哈希/指纹一致性。
- TypeScript：`dsh-plugin/tests/exercise-evolution.test.ts`（21）覆盖同一组行为与
  共享 fixture 逐字节一致性。
- 共享 fixture：`tests/fixtures/exercise_evolution_step10.json`（合成）同时被 Python
  与 TypeScript 读取；RNG 微单位、FNV 哈希、候选哈希、模拟结果指纹/会话 id/逐步
  正确性与假设 id 必须完全一致。
- 全量结果：`python3 -m unittest discover -s tests` 290 通过（Step 10 新增 48）；
  `node --test tests/*.test.ts` 152 通过（Step 10 新增 21）；`npm run typecheck` 通过；
  `npm run evidence:loader` 仍在独立隔离 Cordis/dsh 实例中成功（仅既有六个工具，未把
  插件加载进本任务会话）。
- **未完成/残留**：真实题目文本/答案/图片生成与安全审核、真实内容库/题型模板、
  真实学生行为校准（当前模拟是合成行为模型）、真实对照/延迟保持迁移实验、跨进程
  模拟调度与持久化、把演化候选接入真实交付/UI。当前实现是合成数据上的
  Python/TypeScript 双实现骨架，不宣称生产可用。

## Step 11：FSRS 参数校准（规范 §8）

Step 11 继续只在 `aeh/`、`dsh-plugin/`、`tests/` 与文档内工作，不修改运行用 dsh
（`~/.dsh/` 配置与存储、`~/workspace/deepseek-harness` 源码克隆、npx 安装的 dsh），
不把 AEH 插件加载进正在执行本任务的 harness 会话；`references/` 与 `spec/` 只读。
校准只用**合成** review 序列，不接触真实学生数据；校准只产出参数**候选**，激活只返回
冻结的参数配置对象，**绝不**写 `MemoryState` 或 `StudentTwin`。

### 11.1 Python 核心：`aeh/fsrs_calibration.py`

- **确定性拟合**：沿用规范 §8.3 的示意曲线
  `R = (1 + 19/81 · t / S_eff)^(-1/2)`，`S_eff = max(0.4, S · (10-D)/5)`；拟合 6 维
  动力学参数（初始 stability、成功增长、失败收缩、初始 difficulty、成功/失败对
  difficulty 的增量）。优化器是从四个确定性起点出发的坐标下降（best-of multi-start），
  目标为 Brier 分数 + 向规范先验的 ridge 收缩；拟合路径只用 `+ - * / sqrt`，避免
  `pow`/libm 跨语言舍入差异。
- **可复现**：`CalibrationConfig`（seed、data_version、parameter_version、rounds、
  step_fraction、bootstrap_resamples、ridge、confidence、阈值）与数据摘要、报告
  payload 全部 canonical JSON 内容寻址；相同输入得到相同 `report_fingerprint`，只改
  seed 只改变 bootstrap 区间而不改变点估计。
- **不确定性与适用性**：bootstrap 复用共享 `mulberry32`，给出每个参数的置信区间与
  `identified()` 判定、Brier 区间、ECE、log loss 与 10 个可靠性分箱；`Applicability`
  声明 scope、观测数、elapsed-day 范围、独立/提示观测数与 out-of-scope 清单，弱辨识
  参数被如实列出。
- **候选边界**：`CalibrationService.propose_candidate()` 只生成声明式
  `Candidate`（`kind="config"`、基线 `fsrs_illustrative_19_81`、影响面
  `review_scheduling`/`simulation_parameters`）；`PRODUCTION_MUTATION_ENABLED=False`。
- **隔离评测与门禁**：`CalibrationActivationGate` 状态机
  `registered → evaluated/rejected → approved → activated → rolled_back`；`activate()`
  需要隔离评测通过**且**显式宿主审批（默认拒绝、禁止自批、要求宿主角色），并只返回
  冻结配置；`rollback()` 回到上一稳定版本。
- **CLI**：`python -m aeh.fsrs_calibration_cli [--json]` 用固定 clock 跑完“合成数据 →
  校准 → 候选 → 无真实证据时晋升被阻止 → 显式批准后激活”的确定性演示。

### 11.2 模拟收益与真实迁移分通道

- `evaluate_candidate()` 在**不相交**合成 held-out 集上计算候选相对示意基线的 Brier
  改善，`simulated_benefit.is_causal_evidence=false`，并明确注释“非真实学习效果”。
- 真实迁移通道单独报告，只接受可信来源（`student`/`teacher`/`trusted_grader`/
  `assessment`）与 unseen 题项；没有真实证据时永远
  `promotion_blocked:real_transfer_evidence_missing`，`promotionReady=false`；`real_transfer`
  即使存在也只作描述性结论。激活并非真实效果声明，只是记录一次被批准的配置切换。

### 11.3 TypeScript 对应实现与确定性

- `dsh-plugin/src/core/fsrs-calibration.ts` 与 Python 版逐项对应：同样的参数向量/边界/
  先验、起点、坐标下降、ridge、bootstrap、metrics、适用性、候选与门禁状态机。
- **共享原语双实现**：`mulberry32`、`round4`、`quantizeMicros`、`contentHash`/
  `canonicalJson` 在两侧行为一致；共享 fixture 上 `datasetDigest`、`configFingerprint`、
  `reportFingerprint`、参数、估计区间、metrics 与 applicability **逐字节一致**。
- **未新增模型工具**：校准与门禁是核心/宿主侧 API，插件工具目录仍是六个。

### 11.4 测试与隔离验证

- Python：`tests/test_fsrs_calibration.py`（50）覆盖原语、模型数学、参数/数据/配置校验、
  报告复现与 seed 语义、bootstrap 区间、可靠性分箱、适用性/证据充分性、生成器确定性、
  候选边界、模拟/真实分通道、可信来源与 unseen gating、门禁状态机与拒绝路径、
  `MemoryState`/`StudentTwin` 隔离、共享 fixture 全量一致与 CLI 冒烟。
- TypeScript：`dsh-plugin/tests/fsrs-calibration.test.ts`（46）覆盖同一组行为与共享
  fixture 逐字节一致。
- 共享 fixture：`tests/fixtures/fsrs_calibration_step11.json`（合成）同时被 Python 与
  TypeScript 读取。
- 全量结果：`python3 -m unittest discover -s tests` 340 通过（Step 11 新增 50）；
  `node --test tests/*.test.ts` 198 通过（Step 11 新增 46）；`npm run typecheck` 通过；
  `npm run evidence:loader` 仍在独立隔离 Cordis/dsh 实例中成功（仅既有六个工具，未把
  插件加载进本任务会话）。
- **未完成/残留**：真实版本/人群校准、真实遗忘/保持数据、生产参数注册表与热切换、
  真实 held-out 冻结集、真实审批后台与持久审计存储。当前实现是合成数据上的
  Python/TypeScript 双实现骨架，`activation` 只返回冻结配置对象并记录决策，不宣称
  生产可用或真实效果。

## Step 12：长期孪生体完整生命周期（规范 §5）

Step 12 仍只在 `aeh/`、`dsh-plugin/`、`tests/` 与文档内工作，不修改运行用 dsh
（`~/.dsh/` 配置与存储、`~/workspace/deepseek-harness` 源码克隆、npx 安装的 dsh），
不把 AEH 插件加载进正在执行本任务的 harness 会话；`references/` 与 `spec/` 只读。
所有事件、观测、参数与假设都是**合成**内容，不引入真实学生数据。

### 12.1 事件溯源生命周期

`aeh/twin.py` 的 `StudentTwin` 现在把“真实证据”和“推断状态”彻底分层：

- `record_observed()` / `record_real_correction()` 只向 append-only 的真实事件日志追加，
  事件不可改、不可删；修正是一条新事件，而不是改历史。
- 每一步推断（mastery、memory review、memory decay、calibration activation、
  hypothesis binding）都写入统一推断日志并产生一个 `version`；`version` 等于已提交
  推断步数。
- `create_checkpoint(label)` 冻结当前版本的 knowledge / memory / hypothesis 权重 /
  参数版本 / 证据 revision；`restore_checkpoint(id)` 与 `rollback(version)` 只回退
  推断状态和推断日志，**真实证据与证据 revision 永远不变**。
- `rebuild()` / `replay()` 从真实事件日志 + 推断日志从头重算，结果与增量状态一致；
  重放会重新校验每条推断引用的证据 id 仍存在。
- 回滚同时截断 hypothesis binding 列表，并从截断后的推断日志重新推导“当前生效的
  校准”，避免出现“版本回到 baseline、但内存里仍在用校准参数”的错位。

### 12.2 观察 / 模拟硬隔离

- 模拟事件只能进入独立 simulated 存储；`record_observed()` 拒绝 simulated 来源，
  `record_simulated()` 拒绝真实来源，`promote_simulated()` 永远 fail closed。
- 隔离扩展到 Step 12 的新写入面：`record_memory_review()`、`bind_hypotheses()`、
  `evolve_hypotheses()` 只接受**已存在**的 observed evidence id；模拟 id 不在
  observed cursor 中，因此无法给记忆或假设提供证据。
- 模拟的高 mastery 事件不会改变真实 mastery；`assert_fresh_simulation()` 仍拒绝
  基于旧证据 revision 的模拟。

### 12.3 多 KC 长期记忆与 Step 11 校准候选

`aeh/memory.py` 新增 `MemoryParameters`（6 个 FSRS 动力学参数 + `parameter_version`），
默认值严格等于 Step 11 之前的示意公式，因此 baseline 行为不变：

- **多 KC 记忆**：`StudentTwin.record_memory_review(kc_id, observation, evidence_ids)`
  按 KC 维护独立的 stability / difficulty / counts / model_version；阅读类观测不产生
  版本；`memory_states()` 与 `memory_aggregate(now)` 给出跨 KC 的弱项、逾期与均值。
- **随时间衰减**：`apply_memory_forgetting(now)` 用
  `S_eff = max(0.4, S·(10-D)/5)` 与 `R = (1 + 19/81·t/S_eff)^(-1/2)` 计算逾期；
  逾期只**提高不确定性并标记 `needs_calibration`**，绝不降低 stability/difficulty，
  也不会得出“学生不会”的结论（规范 §5）。
- **校准候选**：`propose_memory_calibration()` /
  `propose_memory_calibration_from_candidate()` 只挂起候选，不改变当前生效参数；
  `activate_memory_calibration()` 必须同时提供非空 `approval_id` 与 `approved_by`，
  否则抛 `CalibrationApprovalRequired`；激活只切换参数版本与后续 review 的动力学；
  `rollback_memory_calibration()` 记录一次显式回滚并回到上一稳定版本。
- 校准值仍只通过 `MemoryParameters` 进入 `update_memory()`，Step 11 的
  `CalibrationActivationGate` 仍是独立控制面；本步不把候选直接写 mastery。

### 12.4 假设集随证据演化并绑定孪生版本

`aeh/hypothesis.py` 新增 `revision`、`active_evidence_refs()`、`prune_weak()`、
`bind_twin_version()` 与独立 `clone()`。`StudentTwin` 提供：

- `bind_hypotheses(set, evidence_ids=...)`：克隆并绑定到一个新版本，记录
  `HypothesisBinding`（权重、active id、证据、twin version、set revision）。
- `evolve_hypotheses(operation)`：支持 `spawn / split / reweight / merge / prune`；
  操作在克隆上执行，成功后绑定新版本，失败不会污染已绑定集合；除首次 `spawn` 外，
  没有已绑定集合就拒绝演化。
- 回滚/恢复 checkpoint 时，绑定集合与 `hypothesis_revision` 一起回到对应版本；
  模拟 evidence ref 无法进入绑定。

### 12.5 TypeScript 对应实现与共享 fixture

- `dsh-plugin/src/core/memory.ts` 增加 `MemoryParameters`、参数化 `updateMemory()`、
  `applyForgetting()`、`memoryHealth()`、`aggregateMemory()`；`MemoryState` 增加
  `lastObservedAt` / `needsCalibration`，`normalizeMemoryState()` 显式保留它们。
- `dsh-plugin/src/core/hypothesis.ts` 增加 `revision`、`boundTwinVersion`、
  `bindTwinVersion()`、`activeEvidenceRefs()`、`pruneWeak()`、`clone()`。
- `dsh-plugin/src/core/twin.ts` 与 Python 对齐：统一推断日志与版本、`TwinCheckpoint`
  与 `asDict()`、`restoreCheckpoint()` / `rollback()` / `replay()`、per-KC memory、
  候选激活门禁、五种假设操作与 binding；`snapshot()` 的既有 JSON 形状保持不变。
- `tests/fixtures/twin_step12.json`（合成）同时被
  `tests/test_twin_step12_fixture.py` 与 `dsh-plugin/tests/twin-step12.test.ts` 读取；
  两侧对 checkpoint 投影的 version / evidenceRevision / knowledge / memory /
  hypothesisRevision / hypothesisWeights / observedEvidenceIds / 参数版本逐值一致。

### 12.6 测试与隔离验证

- Python：`tests/test_memory_step12.py`（15）、`tests/test_hypothesis_step12.py`（8）、
  `tests/test_twin_step12.py`（26）、`tests/test_twin_step12_fixture.py`（2），
  共 51 个 Step 12 测试。
- TypeScript：`dsh-plugin/tests/twin-step12.test.ts`（23）覆盖同一组行为与共享 fixture。
- 全量结果：`python3 -m unittest discover -s tests` **391 通过**（Step 12 新增 51）；
  `node --test tests/*.test.ts` **222 通过**（Step 12 新增 24）；`npm run typecheck`
  通过；`npm run evidence:loader` 仍在独立隔离 Cordis/dsh 实例中成功（仅既有六个工具，
  未把插件加载进本任务会话）。
- **未完成/残留**：checkpoint / 校准审批 / 假设 binding 仍只在内存中，未接入真实
  持久化与跨进程并发控制；没有生产参数注册表、热切换与真实审批后台；pending 候选
  本身不占用推断版本（只有激活/回滚占用）；Python 与 TypeScript 的 ISO 时间戳拼写
  不同（`+00:00` vs `Z`），共享 fixture 因此不比较时间字段；真实长期保持/遗忘数据、
  真实人群校准与真实学习效果仍未验证。

## Step 13：虚拟学生群完整实现（规范 §6 / §19.3）

Step 13 把短期虚拟学生从“能增删改的假设权重表”补全为**有完整动力学规则、保真度度量
与会话边界的假设集合**。核心实现在 `aeh/hypothesis.py` 与
`dsh-plugin/src/core/hypothesis.ts`，两侧共享合成 fixture
`tests/fixtures/hypothesis_step13.json`。

### 13.1 生成 / 匹配 / 分裂 / 合并 / 淘汰规则

- **生成（Spawn / Generate）**：`spawn(..., trigger=...)` 记录规范 §6.2 的触发条件
  （步骤无解释、新题型、冲突证据、新学科范围、多样性塌缩）。`generate(observations,
  candidates)` 只对“当前没有任何候选把某行为预测到阈值以上”的行为，挑选至少提升
  `min_gain` 的候选生成，避免机械复制领先者；没有无解释行为时返回空。
- **匹配（Match）**：`match(observations)` 用每个假设自己的 `predicted_observable_behaviors`
  计算 Bernoulli 似然（`smoothing` 防止 0/1 概率），走带噪声的贝叶斯后验更新，并把没有
  任何候选建模的行为作为 `unexplained_behaviors` 返回。
- **分裂（Split）**：`split_distinguishable(...)` 先检查子假设两两相似度不超过阈值，
  不可区分则拒绝且父假设保持 `active`。相似度 = 0.6·行为预测 + 0.2·`bug_rules` Jaccard
  + 0.2·策略 Jaccard，缺失预测按 chance 处理。
- **合并（Merge）**：`merge_indistinguishable(...)` 合并相似度达到阈值的连通分量；
  新假设保留 `merged_from` 来源历史，规则/策略取并集、行为预测取均值。
- **淘汰（Prune / Archive）**：`prune_weak`（后验过低）、`prune_contradicted`（累计匹配
  平均似然过低）、`prune_uninformative`（与更强候选不可区分、没有独特解释力）都只把
  质量移入 `unknown`，绝不转给另一个候选。

### 13.2 unknown 桶管理与假设保真度（§19.3）

- `set_unknown()` / `request_real_evidence()` / `resolve_evidence_request()` /
  `unknown_reasons` / `needs_real_evidence` 显式管理“无法解释”的质量。`unknown` 领先
  （`dominant()` 为 `None`）时自动标记需要真实证据，而不是强行选一个候选。
- `fidelity(observations)` 输出 Brier、log loss、ECE、accuracy、coverage、`unknown`
  占比、有效假设数（1/Σw²）、最大权重，以及错误类型/错误步骤/策略与主导假设规则的一致率；
  传入 `recent_evidence_id` 时给出“新证据到达后是否仍固守旧状态”的 `anti_mismatch`。
  无法计算时返回 `None`，不会编造指标。

### 13.3 假设快照的会话隔离与持久化边界

- 工具边界仍只走最小 wire 形状 `{hypotheses, unknownWeight}`（六个工具输出 schema 不
  变）；`to_snapshot()` / `from_snapshot()` 额外携带 `unknown` 原因、匹配统计与
  `bound_twin_version`，并固定 `persistsToLongTermTwin: false`。
- `HypothesisSnapshotStore` 按 **session/agent scope** 隔离，带 TTL 与容量上限：跨会话
  读/删 fail-closed，过期与 `end_session` 后不可读，审计视图只给计数，
  `persist_to_twin()` 永远抛错——短期假设永远不能自动变成长期真实掌握。

### 13.4 TypeScript 对应实现与共享 fixture

- `dsh-plugin/src/core/hypothesis.ts` 增加与 Python 同名同义的
  `hypothesisSimilarity`、`generate`、`match`、`splitDistinguishable`、
  `mergeIndistinguishable`、`pruneContradicted`、`pruneUninformative`、`setUnknown`、
  `requestRealEvidence`、`resolveEvidenceRequest`、`fidelity`、`toSnapshot` /
  `fromSnapshot`、`persistToTwin`（抛错）与 `HypothesisSnapshotStore`；
  `toState()` 输出形状保持不变。新增符号从 `src/index.ts` 导出。
- `tests/fixtures/hypothesis_step13.json`（合成）同时被
  `tests/test_hypothesis_step13.py` 与 `dsh-plugin/tests/hypothesis-step13.test.ts`
  读取，两侧对初始权重、相似度、匹配似然/后验、generate/split/merge/prune 结果、
  fidelity 指标与快照权重逐值一致（浮点用 1e-9 容差，不比较 ISO 时间戳拼写）。

### 13.5 测试与隔离验证

- Python：`tests/test_hypothesis_step13.py` **30 个**测试（规则、unknown、保真度、
  快照边界与共享 fixture）。
- TypeScript：`dsh-plugin/tests/hypothesis-step13.test.ts` **30 个**测试（同一组行为）。
- 全量结果：`python3 -m unittest discover -s tests` **421 通过**（Step 13 新增 30）；
  `node --test tests/*.test.ts` **252 通过**（Step 13 新增 30）；`npm run typecheck`
  通过；`npm run evidence:loader` 仍在独立隔离 Cordis/dsh 实例中成功（工具目录仍为
  既有六个，未把插件加载进本任务运行中的 dsh 会话）。
- **未完成/残留**：生成触发只由调用者声明，没有真实的“新题型/冲突证据/步骤首次偏离”
  检测器；匹配是合成行为似然而非真实步骤级认知模型；保真度只跑合成观测，没有真实留出
  步骤、教师根因标签或人群校准；`HypothesisSnapshotStore` 是内存 session store，没有
  跨进程持久化与生产访问控制；规则层尚未暴露为 `aeh_update_hypotheses` 的新操作
  （需先做工具输出 schema 版本迁移与审批）。

## Step 14：主动诊断与反向溯源完整实现（规范 §7）

Step 14 把诊断从“给定假设权重选一道区分度最高的题”补全为**从错误步骤反向定位
认知机制 + 显式诊断会话状态机 + 学生负担上限**。核心实现在 `aeh/diagnosis.py` 与
`dsh-plugin/src/core/diagnosis.ts`，两侧共享合成 fixture
`tests/fixtures/diagnosis_step14.json`。

### 14.1 反向溯源：Observe → Localize → Expand

- **Localize**：`order_steps()` 按 `depends_on` 做稳定拓扑排序，
  `localize_first_deviation()` 返回依赖顺序上第一个 `correct=False` 的步骤；重复
  step id、未知依赖、依赖环一律抛 `BackwardTraceError`，不会给出不可信结论。
- **Expand**：`trace_backward()` 在局部错误规则图上展开四类上游解释：
  1. 偏离规则自带的 `misconception_ids`（误解/错误规则）；
  2. 规则 `requires_rules` 可达的先修规则缺口（按深度衰减，最多 `max_depth` 跳）；
  3. 误解声明的 `requires_kcs` 先修 KC 缺口；
  4. 偶发操作失误 `slip`：孤立错误（恰好一步错且至少一步对）会提升 slip 先验；
     反复出错则压低 slip、偏向系统性误解。
  已经观测为正确的上游规则乘 `contradiction_decay` 大幅降权，避免把“已经做对的前置”
  仍当成缺口。
- 结果 `BackwardTrace` 给出按可信度排序的 `explanations`、归一化后的 `weights`
  （含显式 `unknown`）与 `notes`；`to_hypotheses()` / `traceToHypotheses()` 可直接
  喂给 Step 13 的假设集合。

### 14.2 信息增益与“不确定的答案”惩罚

在原有 `IG(q) + α·TeachingValue − β·Time − γ·Risk − δ·Load` 之上增加
`ζ · predictive_uncertainty`：`predictive_uncertainty()` 是预测作答正确事件的伯努利
熵（0–1 bit），掷硬币式的候选（P≈0.5）被惩罚，预测明确的候选优先。`ProbeSelection`
增加 `answerUncertainty` 分解字段，工具输出 schema 同步增加该字段。

### 14.3 诊断会话状态机与终止条件

`DiagnosisSession` 是显式状态机 `idle → awaiting_answer → updated → … → terminated`：

- `select()` 出题（作答未决时再次调用会抛 `DiagnosisStateError`），`observe()` 作答并
  更新后验，记录实际信息增益与负担；
- `skip()` 学生随时跳过，`terminate()` 显式停止；
- `should_terminate()` 给出确定性的终止原因，优先级为：学生跳过/显式 >
  题数/时长/认知负担上限 > 置信度或熵收敛；`unknown` 领先时不允许判定“已解决”；
- `BurdenBudget{max_questions, max_total_minutes, max_total_load}` 是负担上限，
  `max_questions=0` 时拒绝开始。

### 14.4 TypeScript 对应实现与共享 fixture

- `dsh-plugin/src/core/diagnosis.ts` 增加 `makeTraceGraph`、`orderSteps`、
  `localizeFirstDeviation`、`isIsolatedError`、`traceBackward`、
  `explanationToHypothesis`、`traceToHypotheses`、`predictiveUncertainty`、
  `shouldTerminate` 与状态机 `DiagnosisSession`，以及同名 `STATE_*` /
  `TERMINATION_*` / `TRACE_*` 常量；原有 `selectProbe` / `scoreCandidate` 行为兼容。
- `tests/fixtures/diagnosis_step14.json`（合成）同时被
  `tests/test_diagnosis_step14.py` 与 `dsh-plugin/tests/diagnosis-step14.test.ts`
  读取；两侧对首次偏离步骤、解释集合与权重、逐候选信息增益/不确定度/分数、选中项、
  会话状态序列、终止原因与负担累计逐值一致（浮点 1e-9 容差）。
- 工具目录仍是既有六个：`aeh_select_probe` 现在返回 `answerUncertainty` 并接受可选
  `zeta`；反向溯源与状态机暂只在核心模块可用，**未**新增工具（避免输出 schema 版本
  迁移）。

### 14.5 测试与隔离验证

- Python：`tests/test_diagnosis_step14.py` **42 个**测试。
- TypeScript：`dsh-plugin/tests/diagnosis-step14.test.ts` **31 个**测试。
- 全量结果：`python3 -m unittest discover -s tests` **463 通过**（Step 14 新增 42）；
  `node --test tests/*.test.ts` **283 通过**（Step 14 新增 31）；`npm run typecheck`
  通过；`npm run evidence:loader` 仍在独立隔离 Cordis/dsh 实例中成功（工具目录仍为
  既有六个，未把插件加载进运行中的 dsh 会话）。
- **未完成/残留**：错误规则图、误解与先修关系目前由调用方提供合成标注，没有真实的
  步骤解析器/符号推理器与教师根因标签；`slip_likelihood`、衰减系数是策略先验而非
  校准参数；诊断题预测仍是合成概率，没有真实步骤级认知模型；状态机是内存会话，没有
  跨进程持久化与 dsh session 服务注入；反向溯源/负担上限尚未暴露为模型工具。

## Step 15：教学策略、日常协同、跨学科与学习科学（规范 §10 / §17 / §18）

Step 15 在“会不会/哪里不会”的诊断层之上增加“下一步怎么教、今天怎么排”的策略层。
核心实现在 `aeh/teaching_strategy.py` 与 `dsh-plugin/src/core/teaching-strategy.ts`，
两侧共享合成 fixture `tests/fixtures/teaching_strategy_step15.json`。这一层只做策略
选择与计划，不交付题目：任何实际干预仍必须经过 fail-closed 课程门禁与宿主审批。

### 15.1 教学策略路由器（规范 §10.1）

`select_strategy()` / `selectStrategy()` 接收知识状态、到期复习、学校上下文、学习者
约束与证据来源，输出一个 `StrategyDecision`：动作、目标 KC、方法、分钟数、理由、
护栏、是否需要确认、是否阻断，以及恒为 `true` 的 `delivery_requires_gate`。覆盖
规范中的九个动作：

- `ASK_DIAGNOSTIC_QUESTION`：假设冲突、证据互相矛盾时先问一个可跳过的探针；
- `GIVE_MINIMAL_HINT`：学习者在有效策略上卡住时只给最小提示；
- `SHOW_WORKED_EXAMPLE`：先修缺口或认知负荷过高时给示范例题；
- `TEACH_MICRO_LESSON`：概念误解或预习新概念时给 10–15 分钟微课；
- `ASSIGN_TARGETED_PRACTICE`：程序性错误、默认练习需求时给定向练习；
- `ASSIGN_TRANSFER_TASK`：已掌握且需要迁移时给未见过的迁移任务；
- `SCHEDULE_SPACED_REVIEW`：有到期复习时先复习再新内容；
- `REQUEST_PROGRESS_CONFIRMATION`：学校进度/预习范围/考试范围未确认，或没有足够
  证据时，先向学生/教师确认；
- `ANSWER_DIRECTLY`：学生显式要求答案或时间压力下直接回答（可被学习者关闭）。

规则顺序是确定的，并且 fail-closed：模拟证据不能驱动生产决策；评估进行中不提供
帮助；零时间预算不布置任务；学校进度未确认不推断“已学过”；预习只允许“下一课已确认
且该 KC 在允许范围内”的内容；未确认考试范围不按考试猜题；未知证据来源在入口直接
拒绝。所有决策都带“尊重学习者时间预算 / 不无界练习 / 独立先于提示 / 交付需门禁”等
护栏。

### 15.2 日常协同与动态时间分配（规范 §10.2 / §10.3）

`plan_daily_coordination()` / `planDailyCoordination()` 生成四阶段计划：

1. **preview（预习）**：只在下一课已确认、预习范围已确认、学校进度可用时出现；
2. **school（在校）**：固定 `0` AI 分钟与 `no_action`，显式记录“课堂时间未被观测、
   不自动推断掌握”；
3. **ai_reinforcement（课后强化）**：按最近错误、先修缺口、练习需求选择策略；
4. **review（复习）**：按到期记忆单元安排间隔复习，考试压力/复习积压会提高其权重。

总学习分钟数不超过学习者预算；若 `total_minutes` 大于
`constraints.available_minutes`，以后者封顶并记录
`daily_budget_capped_by_availability`。按 `max_block_minutes` 切块并插入休息，休息
时长按 `break_preference`（`short` / `balanced` / `long`）计算，休息分钟不计入学习
预算。
零预算、评估进行中或模拟证据用于生产时整份计划阻断。该计划不写长期孪生，也不把
“在校时间”当成掌握证据。

### 15.3 跨学科接口与两个示例（规范 §17）

`SubjectAdapter` 定义学科无关的共享契约：KC 前缀、证据种类、验证器、必需证据、
策略亲和度与高风险 KC 前缀。`SubjectRegistry` 默认拒绝重复注册与未知学科。

- **数学示例** `MathSubjectAdapter`：`kc.math.` 前缀；验证器 `answer_key` /
  `cas_step_equivalence` / `symbolic_equivalence`；证据种类含数值答案、符号答案、
  步骤等价与迁移；策略亲和度偏向示范与定向练习。
- **物理示例** `PhysicsSubjectAdapter`：`kc.physics.` 前缀；验证器 `answer_key` /
  `unit_check` / `dimensional_analysis` / `symbolic_check`；证据种类含单位检查、
  量纲检查、受力图与迁移；`kc.physics.electricity.` 为高风险前缀，适配结果带
  `safety_required=true`，提示需要电气/高压实践的安全审查。

适配失败一律 fail-closed：不支持的 KC、未知证据种类、未由该学科验证器验证的证据
都会返回拒绝原因；高风险标记不会自动生成危险实验步骤。

### 15.4 学习科学映射与三个可执行计划（规范 §18）

`LEARNING_SCIENCE_METHODS` 覆盖规范表 16 种方法，每种都记录适用动作、使用条件、
实现状态、验证方式与护栏。其中三种有可执行计划：

- `plan_retrieval_practice()`：先尝试后看答案，禁止答案预览；提示后正确不算独立
  检索；按可用分钟数与题数上限生成序列。
- `plan_spaced_review()`：按当前可提取性从低到高排序（同分按 KC 稳定排序），由
  stability 与目标保持率反解下一次间隔；逾期只提高不确定性，不直接降低掌握度。
- `plan_interleaved_practice()`：要求至少两个 KC 且达到基础理解门槛；优先打散
  同 KC 连续出现，按 `block_size` 分块；基础未稳时不强行交错。

其余 13 种方法只标注为 `mapped`，不宣称已有自动执行器；`learning_science_checklist()`
会如实返回每个方法的 `implemented` / `mapped` 状态。

### 15.5 测试与隔离验证

- Python：`tests/test_teaching_strategy.py` **54 个**测试。
- TypeScript：`dsh-plugin/tests/teaching-strategy-step15.test.ts` **54 个**测试。
- 共享 fixture 对策略动作/目标/方法/时长/护栏、日常阶段与预算、检索/间隔/交错序列、
  学科适配与证据拒绝逐值比对，Python 与 TypeScript 行为一致。
- 全量：Python **517 通过**（Step 15 新增 54）；Node **337 通过**（Step 15 新增 54）；
  `npm run typecheck` 通过；`npm run evidence:loader` 仍在独立隔离 Cordis/dsh 实例
  中成功，工具目录仍为六个。
- **未完成/残留**：学校日程、考试范围、任务意图、先修缺口与错误信号仍由调用方以
  合成标注传入，没有真实校历/LMS/作业系统、教师确认流程或课堂同步资料；策略效果
  没有真实对照/延迟保持实验；跨学科只有数学与物理两个示例，化学/编程/语言/专科
  实践课适配器与真实学科验证服务未实现；16 种学习科学方法中只有 3 种有执行计划。
  策略路由、日常计划与学科适配尚未暴露为模型工具，也未加载进任何正在运行的 dsh。

## Step 16：数据模型、存储服务与 Harness 状态机（规范 §12 / §13 / §15.3）

Step 16 把“状态放在哪里、谁可以写、写冲突怎么办、一次学习闭环怎么走”从隐含约定
变成显式的服务边界与状态机。Python 实现在 `aeh/services.py`，TypeScript 实现在
`dsh-plugin/src/core/services.ts`，两侧读取同一份合成 fixture
`tests/fixtures/services_step16.json`。这一层**不新增模型工具**（工具目录仍为六个），
不接入真实学生数据，也不修改运行中的 dsh。

### 16.1 四个服务边界与内存/文件双实现

- **事件存储**：`EventDraft` → `LearningEvent`，信封对齐规范 §22.1（event_id /
  stream_id / event_type / source_type / occurred_at / sequence / idempotency_key /
  session_id / provenance / payload / schema_version）。`EventStore` 是抽象边界，
  `InMemoryEventStore` 与 `FileEventStore`（append-only JSONL）行为一致；文件实现
  重开时逐条校验 SHA-256 内容摘要，篡改或混入其他存储域会 fail-closed。
- **Profile / Bundle**：`StudentProfile` 带 `version`、stage、guardian_consent 与
  合成 settings；`ProfileStore.update` 必须带 `expected_version`。`ProfileBundle`
  冻结 `student_ref + twin_version + school_progress_version + content_version +
  created_at` 的内容寻址摘要，同 id 同摘要幂等、同 id 不同摘要拒绝。
- **内容库**：`ContentRecord` 按 `contentId` 版本化，带 kcIds、difficulty、
  `draft/approved/retired` 审核状态与内容摘要；`put` 带 `expected_version`，
  `retrieve` 只返回 `approved` 且按 KC/难度过滤、稳定排序、默认上限 10，无批准内容
  时返回空而不是猜测。
- **评测服务**：`FrozenEvalSet` 不可变、内容寻址，要求 train 与 unseen transfer；
  `EvaluationService` 隔离模拟与真实通道——模拟只能走 train/explanation，真实迁移
  只接受可信来源、transfer 分片、unseen 且独立作答；模拟数据重标为真实证据会抛
  `SelfProofError`。运行结果幂等，并显式保存 claim / self-proof guard / limitations。
- **写入协调**：`WriteCoordinator` 按 `(stream, idempotency_key)` 记忆化
  `run_once`，重复操作只执行一次；事件存储自身再做一次幂等兜底。

### 16.2 乐观并发、幂等键与写入顺序

`append(draft, expected_version=N)` 在流版本不等于 N 时抛
`OptimisticConcurrencyError`；同一 `(stream, idempotency_key)` 重放返回原事件
（`deduplicated=true`，sequence 不变），但事件类型/时间/来源/payload 不一致时抛
`IdempotencyConflictError`。event_id 由 `stream + key` 稳定派生，因此重试不需要
调用方自己生成 id。内容库对“同一写入的重放”和“陈旧写入”做了区分：前者返回当前
版本，后者拒绝。

### 16.3 Harness 状态机（规范 §12.2）与失败/退化分支（§15.3）

`HarnessStateMachine` 覆盖规范全部 23 个状态；`Completed / Failed / Aborted` 是
终态且 fail-closed。正常转移按 `TRANSITIONS` 表校验，`advance` 支持幂等键与冲突
检测；`.snapshot()` 只含状态、转移理由、退化记录与计数，不含学生作答内容。

`EXCEPTION_BRANCHES` 把规范 §15.3 的失败/退化表映射为 12 条分支：OCR 不确定、
符号验证不确定、RAG 缺来源、学校进度不明、假设全不匹配、模拟超时、记忆数据稀疏、
策略低置信、学生拒绝诊断、异常压力、课程门禁拒绝、内容拒绝。每条分支带目标状态、
退化模式与说明；`rag_source_missing` / `low_confidence_strategy` /
`abnormal_pressure` 原地退化不改状态，其余按目标重路由。未知分支抛
`ValidationError`。返工循环有界：默认 `max_rejections=3`，第 4 次拒绝转 `Failed`
并记录 `rework_budget_exhausted`，不会无限循环。

### 16.4 测试与隔离验证

- Python：`tests/test_services_step16.py` **66 个**测试。
- TypeScript：`dsh-plugin/tests/services-step16.test.ts` **64 个**测试。
- 共享 fixture 对 append/幂等/并发冲突、Profile/Bundle、内容检索、评测均值/增益/
  真实准确率/来源/claim、状态机脚本/拒绝上限/异常目标逐值比对，Python 与
  TypeScript 行为一致。
- 全量：Python **583 通过**（Step 16 新增 66）；Node **401 通过**（Step 16 新增
  64）；`npm run typecheck` 通过；`npm run evidence:loader` 仍在独立隔离
  Cordis/dsh 实例中成功，工具目录仍为六个。
- **未完成/残留**：文件实现是单机单进程模型，没有跨进程锁、加密、保留期或压缩；
  Profile/Bundle 读取没有跨服务一致性快照；内容库没有真实版权/授权元数据与审核
  工作流；TypeScript 评测服务是 `aeh/evaluation.py` 的最小镜像而非完整协议；状态机
  没有接入真实 agent 编排、工具重试与检查点恢复；服务与状态机尚未暴露为模型工具，
  也未加载进任何正在运行的 dsh。

## Step 17：隐私、安全、未成年人保护与指标面板（规范 §20 / §21）

Step 17 把“谁能看什么、数据留多久、删除如何传播、未成年人怎么保护、成本怎么估”
做成可测试的显式边界。Python 实现在 `aeh/privacy.py`，TypeScript 实现在
`dsh-plugin/src/core/privacy.ts`，两侧读取同一份合成 fixture
`tests/fixtures/privacy_step17.json`。这一层**不新增模型工具**（工具目录仍为六个），
不接入真实学生数据，也不修改运行中的 dsh。

### 17.1 同意账本与未成年人保护（§21）

- `ConsentEvent` / `ConsentLedger` 是追加式账本：`grant` / `revoke` 永不覆盖历史，
  `consent_id` 重复、未知 scope/主体、过期时间早于授权时间或出现在撤回事件上都会
  fail-closed；`active_scopes(subject, at, age=...)` 只返回在 `at` 时刻有效（含未过期）
  的 scope。
- 九个受控 scope：`curriculum:read`、`twin:observe`、`twin:simulate`、
  `twin:rollback`、`intervention:deliver`、`report:aggregate`、`research:aggregate`、
  `audit:export`、`metrics:read`。
- 未成年人（`is_minor`，阈值 18）：`GUARDIAN_REQUIRED_SCOPES` 中的 `twin:observe`、
  `twin:simulate`、`twin:rollback`、`intervention:deliver` 只有监护人授权才对未成年人
  生效；`research:aggregate` 对所有未满 18 岁学生一律不可达（即使监护人同意），
  `research` 受众因此只能看到聚合、去标识的结果。
- 受众访问：`effective_audience_scopes` 只会在受众默认范围内**收窄**，
  `authorized_audience_scopes` 再与同意账本当前有效 scope 求交；未知受众/scope 抛
  `AudienceRestrictionError`。教师默认不含 `audit:export`，因此不能导出审计。
- `revoke_all` 幂等，返回本次新撤回的 grant 数；删除传播会顺带撤回该学生的全部同意。

### 17.2 保留期与跨存储删除传播（§21）

- `DATA_CLASSES` 覆盖 `raw_media`、`learning_events`、`derived_features`、`reports`、
  `audit_log`；`RetentionPolicy` 必须为**每个**数据类给出规则，否则 fail-closed；
  `RetentionRule` 支持 `hard_delete` / `tombstone` / `anonymize`。
- `expired_records` 的到期判定是闭区间（`created_at + retain_days <= now`），并按
  到期时间、学生、数据类稳定排序；`retention_requests` 为每类到期数据生成确定性的
  删除请求（`reason=retention_expiry`）。
- `DeletionCoordinator` 把 `DeletionRequest` 传播到所有已注册的 `DeletableStore`：
  逐存储返回删除计数与状态，生成 `DeletionReceipt`（总删除数、逐存储状态、
  撤回的同意数、是否阻断后续读取、是否幂等重放）。任一存储失败得到 `partial`，全部
  失败得到 `failed`，绝不谎报成功；删除后该学生的读取 `assert_readable` 直接
  `DeletionError`，其他学生不受影响。`SyntheticStore` 是只存放合成计数行的测试实现。

### 17.3 审计导出（§20.3）

`export_audit` 按时间窗（起点含、终点不含）与事件类型过滤，默认把伪名键
（`student_key` / `tenant_key`）重写为 `null`，只有显式
`include_pseudonymous_keys=True` 且受众被授权时才保留；`AuditEntry` 拒绝
`AUDIT_FORBIDDEN_DETAIL_KEYS`（作答、提示、答案等）以及任何非标量 detail 值。
导出得 `AuditExportBundle`：逐类型/逐结果计数、稳定排序的 payload、以及内容寻址的
`digest`（Python 与 TypeScript 对同一 fixture 产出相同摘要）。

### 17.4 指标面板与合成成本估算（§20）

- `METRIC_DEFINITIONS` 覆盖学习（独立正确率、步骤错误复发、近/远迁移、延迟保持、
  提示依赖、学习时间、虚拟-真实增益差）、系统（模型调用、工具耗时、缓存命中、
  工作流失败率、模拟 token）与成本（模拟 token 成本、工具调用成本、会话成本）三个
  维度，并声明聚合方式（ratio/mean/sum/gauge）与是否允许模拟来源。
- `MetricsDashboard` 只接受已注册指标；**模拟来源不得写入学习类指标**（抛
  `MetricsError`），观测/模拟分通道快照；`snapshot` 给出各指标聚合值与样本数，
  `cohort_view` / `student_cohorts` 对小于 `MIN_COHORT_SIZE`（默认 5）的群体做抑制计数。
- `CostModel` / `estimate_cost` / `CostEstimator` 是纯合成估算：按输入/输出 token、
  工具调用、模拟分钟计价，`billing_connected` 恒为 `False`，`BILLING_CONNECTED`
  常量为 `False`，`estimate_multi` 汇总多模型成本，`within_budget` 只做上限比较。

### 17.5 测试与隔离验证

- Python：`tests/test_privacy_step17.py` **58 个**测试。
- TypeScript：`dsh-plugin/tests/privacy-step17.test.ts` **62 个**测试。
- 共享 fixture 对同意生效 scope（未成年 vs 成年）、各受众可见范围、跨存储删除计数、
  保留期到期列表、审计计数/摘要/去标识、指标聚合与群体抑制、成本分项与总价逐值比对，
  Python 与 TypeScript 行为一致。
- 全量：Python **641 通过**（Step 17 新增 58）；Node **463 通过**（Step 17 新增
  62）；`npm run typecheck` 通过；`npm run evidence:loader` 仍在独立隔离 Cordis/dsh
  实例中成功，工具目录仍为六个。
- **未完成/残留**：没有真实数据主体请求流程（DSAR）、身份/年龄核验、监护人签署或
  DPO 工作流；保留期没有后台调度器，删除没有加密擦除、跨进程/跨副本一致性与备份
  回收；审计导出是内存 payload，没有对象存储、签名或 WORM 保管链；指标面板没有真实
  LLM 计费/配额/发票，也没有前端仪表盘；`research` 受众只保证授权收窄，未实现真正的
  差分隐私或 k-匿名发布；TypeScript 侧是 `aeh/privacy.py` 的行为镜像而非完整服务，
  隐私层尚未暴露为模型工具，也未加载进任何正在运行的 dsh。


## Step 18：真实会话端到端验收（隔离实例）

Step 18 把 Step 3–17 的核心与插件放进一个**真正独立**的 dsh 实例，跑一次真实模型
会话，证明“插件能被 dsh 加载、`aeh_*` 工具能被模型调用、门禁—诊断—复习—报告能产出
真实结果”，同时不修改正在执行任务的 harness。全部输入是合成数据，没有真实学生
数据，也没有把插件加载进运行中的 `~/.dsh` 会话。

### 18.1 隔离边界

| 维度 | 本步骤使用 | 未使用 / 未修改 |
|---|---|---|
| dsh 安装 | `step18/runtime` 内独立 `npm install @deepseek-ai/dsh@0.2.1-rc.3`，独立 `step18/.npm-cache` | npx 安装的 dsh |
| `$DSH_HOME` | `step18/home`（独立 profile、sessions、storages） | 运行中的 `~/.dsh/` |
| profile | `step18/home/profiles/aeh-e2e`（`dsh-base` + `dsh-headless` 后打补丁） | headless 运行配置 |
| 工作目录 | `step18/work` | 仓库根或 harness 源码目录 |
| 插件入口 | `dsh-plugin/e2e/aeh-e2e-entry.ts` | 执行本任务的 harness 会话 |
| 源码克隆 | 只读引用 | `~/workspace/deepseek-harness` |

运行中的 harness（`run_headless.py` → npx dsh）在本步骤期间未被重启、未被改配置、
未被写存储，也没有加载 AEH 插件。

### 18.2 合成宿主入口

插件 `src/index.ts` 的 `apply(ctx, config)` 只接受宿主注入的 `host`（`HostContext`
绑定），这是有意的信任边界：`host` 不是 YAML 可序列化字段，解析不到就全部
fail-closed。因此隔离实例需要一层很薄的入口 `dsh-plugin/e2e/aeh-e2e-entry.ts`：

- 复用真实插件的 `name` / `inject` / `Config` / `apply`，不新增工具或权限；
- 固定合成学生 `synthetic.student.step18`、session `session.aeh.step18`、
  tenant `tenant.aeh.step18`，只授予 `curriculum:read`；
- 固定合成进度（已教 `kc.fraction.add` / `kc.fraction.equiv`、在学
  `kc.fraction.compare`、先修 `kc.place.value`）与 5 道合成题；
- `item.fraction.multiply.001` 需要未教 KC，用来证明门禁会 fail-closed；
- 不写长期孪生、不访问网络或文件系统。入口被纳入 `tsconfig` 的
  `npm run typecheck`，但不注册到插件包导出，也不会被 `node --test tests/*.test.ts`
  或运行中的 harness 加载。

### 18.3 会话脚本与结果

隔离 profile 把 `llm-pi-ai` 指向 Sidrune（`baseURL=https://sidrune.ai/v1`，
`apiKeyEnv=SIDRUNE_API_KEY`），默认模型 `deepseek-v4-1-flash`；同时禁用 shell、
文件、网络、子代理等与本验收无关的工具，模型可调用的业务工具只剩六个 `aeh_*`
（运行时的 timeout/结果裁剪与 slash command 服务仍在）。一次运行的结果：

| 阶段 | 工具 | 结果 |
|---|---|---|
| 门禁 | `aeh_check_curriculum` | `item.fraction.add.001` → `allowed: true` |
| 门禁 | `aeh_check_curriculum` | `item.fraction.multiply.001` → `allowed: false`，`kcs_not_allowed:kc.fraction.multiply`（fail-closed） |
| 诊断 | `aeh_update_hypotheses` | 生成 1 个假设，`snapshotRef: hyp_1` |
| 诊断 | `aeh_select_probe` | 选中 `item.fraction.equiv.001`（score ≈ -0.2953） |
| 复习 | `aeh_schedule_review` | `nextIntervalDays: 3.2`，stability 3.2，difficulty 4.8，目标保持 0.9 |
| 报告 | `aeh_generate_report` | attempts 4、independent correct 3、hints 1、minutes 10；1 条授权事件，0 条排除，无原始数据/事件引用 |

运行退出码 **0**，**39** 个 JSON 事件，**6/6** 工具调用与结果，**0** 错误事件。
工具链：Node `v24.22.1`、`@deepseek-ai/dsh` 与 bundle 均 `0.2.1-rc.3`、Cordis
`4.0.5`。

### 18.4 证据

证据目录 `step18/evidence/20261027T110556Z/`：

- `summary.md` / `summary.json`：人读与机器可读摘要（隔离、工具链、六次调用、
  最终回答、错误）；
- `stdout.jsonl`：`dsh --json` 逐行事件流，含完整工具入参与结果；
- `stderr.log`：诊断输出（成功时为空）；
- `command.txt`：精确命令、cwd、环境变量（凭证已脱敏）；
- `task.md`：合成任务全文；
- `profile.cordis.patch.yml` / `profile.package.json`：实际使用的隔离 profile；
- `dump-config.txt`：`--dump-config` 组合结果，证明 `aeh-education-e2e` 行已插入；
- `metadata.json`：Node/dsh/bundle 版本、入口与补丁 sha256；
- `session-log/`：隔离 `$DSH_HOME` 下的会话日志（zstd 解压后的 JSONL）。

`custom.sidrune` 的 `hsurr:` 代理凭证只进入子进程的 `SIDRUNE_API_KEY`；证据中
不含 `hsurr:` / `sk-` 明文，命令记录写为 `[surrogate-redacted]`。

### 18.5 复现

```bash
# 首次：只在 step18/ 内安装独立运行时
mkdir -p step18/runtime
printf '%s\n' '{"name":"aeh-step18-isolated-dsh-runtime","private":true,"dependencies":{"@deepseek-ai/dsh":"0.2.1-rc.3"}}' > step18/runtime/package.json
npm install --prefix "$PWD/step18/runtime" --cache "$PWD/step18/.npm-cache" --no-audit --no-fund

python3 step18/run-e2e.py --dry-run   # 组合 profile，打印 --dump-config
python3 step18/run-e2e.py             # 真实会话 + 新证据目录
```

细节与隔离矩阵见 `step18/README.md`。凭证依赖本机已注册的 `custom.sidrune`
connector；换机器需要重新注册，否则无法完成模型调用。

### 18.6 未完成 / 残留

- 只验证一个合成会话与一个模型，不是生产流量、多租户或真实学生数据。
- 宿主绑定是代码级入口，不是可序列化的生产配置；生产接入需要真正的宿主插件提供
  `HostContext` 解析器。
- 未验证多进程/多副本、崩溃恢复、配额/计费、审批后台、LMS 交付或真实身份/同意网关。
- 没有修改 CI、没有 push、没有运行 GitHub Actions。


```text
aeh/
  __init__.py
  curriculum_gate.py   # 规范 §4.3 fail-closed 课程门禁
  curriculum_graph.py  # Step 9 版本化 KC 图 / 题库 / 本地 RAG / 检索后门禁
  twin.py              # Step 12 规范 §5 长期孪生：事件溯源 / checkpoint / 回滚 / 重放 / 记忆 / 假设绑定
  memory.py            # Step 12 规范 §8.3–8.6 FSRS 风格记忆模型 + MemoryParameters / 衰减 / 多 KC 聚合
  hypothesis.py        # Step 12+13 规范 §6 短期假设集合：完整生成/匹配/分裂/合并/淘汰规则、unknown 桶、保真度指标、会话快照边界
  diagnosis.py         # Step 14 规范 §7 反向溯源 + 信息增益 + 诊断会话状态机 / 负担上限
  teaching_strategy.py # Step 15 规范 §10/§17/§18 策略路由 / 日常协同 / 学习科学 / 学科适配
  services.py          # Step 16 规范 §12/§13/§15.3 服务边界 / 并发幂等 / Harness 状态机
  privacy.py           # Step 17 规范 §20/§21 同意账本 / 受众范围 / 保留期与删除传播 / 审计导出 / 指标与成本估算
  exercise.py          # 规范 §9.2/9.4 干预包与交付校验
  exercise_evolution.py # Step 10 习题演化引擎与隔离模拟实验室（规范 §9、§11）
  fsrs_calibration.py   # Step 11 FSRS 参数校准：拟合/不确定性/候选/门禁（规范 §8）
  fsrs_calibration_cli.py # Step 11 可运行校准演示入口（python -m aeh.fsrs_calibration_cli）
  demo_session.py      # Step 2 合成拍题/批改/诊断/复习闭环
  report.py            # Step 2 已授权聚合事件的教师/家长报告
  evaluation.py        # Step 5 独立冻结评测协议（规范 §19，防自证）
  eval_cli.py          # Step 5 可运行评测入口（python -m aeh.eval_cli）
  evolution.py         # Step 6 受控自进化骨架（规范 §27，宿主侧）
  demo.py              # Step 2 命令行入口（python -m aeh.demo）
dsh-plugin/            # Step 3+4+5+6+7+8+9+10+11+12+13+14+15+16+17+18 TypeScript dsh / Cordis 教育插件
  src/index.ts         # Cordis 插件入口（name / inject / Config / apply）
  src/dsh.ts           # 真实 cordis / dsh-tools 薄 authoring 适配层
  src/config.ts        # Step 7 Schemastery 配置校验（fail loud）+ Step 8 security 块
  src/security.ts      # Step 8 注入/越权/payload/限流/脱敏守卫
  src/output-schemas.ts # Step 7 六个工具的闭合输出 schema
  src/core/            # 门禁、孪生、FSRS、假设（含 Step 13 完整规则/保真度/快照）、Step 14 诊断（反向溯源/信息增益/状态机）、Step 15 策略/日常协同/学科适配/学习科学、Step 16 存储服务边界/Harness 状态机、Step 17 隐私同意/保留删除/审计导出/指标与成本、干预包、Step 9 课程图/题库/RAG、Step 10 演化/模拟、Step 11 校准、Step 12 长期孪生
  src/host/            # 内存同意 / HostContext / 孪生 / 交付适配器
  src/host/file-event-store.ts  # Step 5 默认关闭的文件事件存储
  src/host/evolution.ts         # Step 6 宿主侧受控自进化控制面（非工具）
  src/host/session-state.ts     # Step 7 session/agent 级假设快照（TTL/隔离/清理）
  src/host/audit-log.ts         # Step 7 追加式脱敏审计与伪名指标
  src/report.ts        # Step 5 聚合报告边界（对应 aeh/report.py）
  src/tools.ts         # 六个教育工具 + Step 8 安全/审计包装
  src/permissions.ts   # 默认最小权限
  scripts/             # 隔离 loader 加载证据脚本
  e2e/                 # Step 18 独立隔离实例的合成宿主入口（不注册到包导出）
  tests/               # Node 24 不变量 + 宿主 + 报告 + 持久化 + 自进化 + 契约 + Step 7 + Step 8 + Step 9 + Step 10 + Step 11 + Step 12 + Step 13 + Step 14 + Step 15 + Step 16 + Step 17
  package.json         # 真实 @deepseek-ai/* 依赖（只装在本目录）
step18/                # Step 18 独立隔离 dsh 实例：runner、离线安装、证据（runtime/home 不入库）
  run-e2e.py           # 组合 profile、取代理凭证、跑合成会话、脱敏并写证据
  README.md            # 隔离矩阵、合成场景、复现与未完成项
  evidence/            # 命令、事件流、会话日志、摘要（合成）
docs/
  dsh-integration.md   # Step 3+4+5+6+7+8+9+10+11+12+13+14+15+16+17+18 映射、权限与完成情况
  evaluation-report-template.md  # Step 5 评测报告模板
tests/                 # Python 标准库 unittest 测试
  fixtures/curriculum_step9.json  # Step 9 Python/TS 共享的合成图谱与题库 fixture
  fixtures/exercise_evolution_step10.json  # Step 10 Python/TS 共享的演化与模拟 fixture
  fixtures/fsrs_calibration_step11.json    # Step 11 Python/TS 共享的校准 fixture
  fixtures/twin_step12.json                # Step 12 Python/TS 共享的长期孪生 checkpoint fixture
  fixtures/hypothesis_step13.json          # Step 13 Python/TS 共享的虚拟学生群 fixture
  fixtures/diagnosis_step14.json           # Step 14 Python/TS 共享的反向溯源与诊断会话 fixture
  fixtures/teaching_strategy_step15.json   # Step 15 Python/TS 共享的策略/日常协同/学习科学/学科 fixture
  fixtures/services_step16.json            # Step 16 Python/TS 共享的存储/并发/评测/状态机 fixture
  fixtures/privacy_step17.json             # Step 17 Python/TS 共享的同意/删除/保留/审计/指标/成本 fixture
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

Step 11 的 FSRS 参数校准（合成数据，离线，纯内存，固定 clock）：

```bash
python3 -m aeh.fsrs_calibration_cli
python3 -m aeh.fsrs_calibration_cli --json
python3 -m unittest discover -s tests -p 'test_fsrs_calibration.py' -v
```

Step 12 的长期孪生生命周期（合成事件/观测/参数，固定 clock）：

```bash
python3 -m unittest discover -s tests -p 'test_twin_step12*.py' -v
python3 -m unittest discover -s tests -p 'test_memory_step12.py' -v
python3 -m unittest discover -s tests -p 'test_hypothesis_step12.py' -v
```

Step 13 的虚拟学生群完整规则 / 保真度 / 快照边界（合成观测与快照）：

```bash
python3 -m unittest discover -s tests -p 'test_hypothesis_step13.py' -v
```

Step 14 的反向溯源 / 信息增益 / 诊断会话状态机与负担上限（合成步骤与规则图）：

```bash
python3 -m unittest discover -s tests -p 'test_diagnosis_step14.py' -v
```

Step 15 的教学策略 / 日常协同 / 学习科学 / 学科适配（合成 KC、日程与证据）：

```bash
python3 -m unittest discover -s tests -p 'test_teaching_strategy.py' -v
```

Step 16 的服务边界 / 并发幂等 / Harness 状态机（合成事件、Profile、内容与评测数据）：

```bash
python3 -m unittest discover -s tests -p 'test_services_step16.py' -v
```

Step 17 的同意账本 / 未成年人保护 / 保留期删除 / 审计导出 / 指标与成本（合成 fixture）：

```bash
python3 -m unittest discover -s tests -p 'test_privacy_step17.py' -v
```

Step 3+4+5+6+7+8+9+10+11+12+13+14+15+16+17+18 的插件测试要求 Node **>= 24**。Step 4 起使用真实
`@deepseek-ai/*` 依赖，只安装在 `dsh-plugin/` 内（独立缓存），不会加载进运行中的
dsh，也不读写 `~/.dsh/`：

```bash
cd dsh-plugin
npm install --cache .npm-cache
npm run typecheck          # tsc --noEmit（含 e2e 合成入口）
node --test tests/*.test.ts
npm run evidence:loader    # 隔离 Cordis loader 加载/卸载证据
```

Node 测试分层：13 个离线不变量测试、12 个宿主适配器测试、8 个报告边界测试、
8 个文件事件存储测试、22 个宿主侧自进化测试、7 个真实 Cordis/dsh 运行时契约测试、
23 个 Step 7 加固测试、19 个 Step 8 安全测试、19 个 Step 9 课程图/题库/检索测试、
21 个 Step 10 演化/模拟测试、46 个 Step 11 校准测试、24 个 Step 12 长期孪生测试、
30 个 Step 13 虚拟学生群测试、31 个 Step 14 主动诊断测试、54 个 Step 15 教学策略/
日常协同/学习科学/学科适配测试、64 个 Step 16 存储/并发/评测隔离/状态机测试、
62 个 Step 17 隐私/删除/审计/指标/成本测试，全部使用合成引用，共 463 个。
Python 侧共 641 个测试（Step 9 新增 22 个，Step 10 新增 48 个，Step 11 新增 50 个，
Step 12 新增 51 个，Step 13 新增 30 个，Step 14 新增 42 个，Step 15 新增 54 个，
Step 16 新增 66 个，Step 17 新增 58 个）。

Step 18 的独立隔离端到端验收需要本机已注册的 `custom.sidrune` connector，且会真实
调用模型，因此**不放进 CI**，按需手动运行：

```bash
python3 step18/run-e2e.py --dry-run   # 组合 profile，打印 --dump-config
python3 step18/run-e2e.py             # 真实合成会话 + 证据
```

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) 在 push 和 pull request 时运行：

- Python 3.11 与 3.12 矩阵：`python -m unittest discover -s tests -v`，以及离线
  `python -m aeh.eval_cli --json` 与 `python -m aeh.fsrs_calibration_cli --json`
  （无外部服务）；
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

Step 1–7 有意不做以下内容，后续步骤再实现：

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
- 真实学生迁移与延迟保持的校准；Step 11 能在合成 review 序列上拟合出候选参数，但
  当前运行参数仍是示意值，真实人群/版本校准与小样本不确定性处理未做。
- 速率限制、locale 与跨进程并发控制：Step 8 已在工具入口实现单实例内存限流
  （按 session 与 `studentRef`）、提示注入/越权/超大 payload 拒绝与错误审计脱敏；
  跨进程/跨副本分布式限流、按工具/租户差异化配额、locale 展示与对抗性注入红队仍未做。
- 习题演化与模拟实验室仍是合成骨架：没有真实题目文本/答案/图片生成与安全审核、
  真实内容库/题型模板、真实学生行为校准、真实对照/延迟保持迁移实验、跨进程模拟
  调度与持久化，也没有把演化候选接入真实交付/UI。模拟实验室只在内存中对合成行为
  模型采样，不写任何真实存储。
- FSRS 校准仍是合成骨架：只在合成 review 序列上拟合 6 维动力学参数，`19/81` 示意
  曲线与线性难度项固定；没有真实版本/人群校准、生产参数注册表与热切换、真实 held-out
  冻结集、真实审批后台与持久审计存储。`activation` 只返回冻结配置对象并记录一次被
  批准的配置切换，既不写 `MemoryState`/`StudentTwin`，也不构成真实效果声明。
- 长期孪生的 checkpoint / 校准审批 / 假设 binding 仍只在内存中：没有真实持久化、
  跨进程并发控制、生产参数注册表与热切换、真实审批后台；pending 候选不占用推断版本
  （只有激活/回滚占用）；Python/TypeScript 的 ISO 时间戳拼写不同，所以共享 fixture
  不比较时间字段。真实长期保持/遗忘数据与真实学习效果未验证。
- 数据模型、存储服务与 Harness 状态机仍是单机骨架：`aeh/services.py` 与
  `src/core/services.ts` 的文件实现没有跨进程锁、加密、保留期或压缩，Profile/Bundle
  读取没有跨服务一致性快照，内容库没有真实版权/授权元数据与审核工作流，TypeScript
  评测服务是 `aeh/evaluation.py` 的最小镜像；状态机没有接入真实 agent 编排、工具重试
  与检查点恢复，也未暴露为模型工具。Step 16 的 `FileEventStore` 与 Step 5
  `src/host/file-event-store.ts` 同名但不同层，顶层 `index.ts` 仍导出后者，前者需从
  `core/services.ts` 引入。
- 主动诊断与反向溯源仍是合成骨架：错误规则图、误解与先修关系由调用方提供合成标注，
  没有真实步骤解析器/符号推理器、真实教师根因标签或真实步骤级认知模型；
  `slip_likelihood` 与深度/矛盾衰减是策略先验而非校准参数；诊断题预测是合成概率；
  诊断会话状态机是内存会话，没有跨进程持久化与真实 dsh session 服务注入；反向溯源
  与负担上限尚未暴露为模型工具（仍是既有六个工具，`aeh_select_probe` 只新增
  `answerUncertainty` / `zeta`），避免输出 schema 版本迁移。

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
- Step 3+4+5+6+7+8+9+10+11+12 插件只接收 opaque `studentRef` 与宿主授权快照；默认无原始数据、
  DB 写、凭据、文件或网络权限，observed 孪生写、干预交付与自进化审批/回滚不属于模型
  工具。隔离测试只使用合成引用，不读写 `~/.dsh/`，也不加载进运行中的 harness 会话。
- Step 10 演化只重采样结构化合成标注与受控参数，生成器与验证器分离（演化引擎先过
  课程门禁，候选池再要求沙箱筛查合格与题库审核通过，`observed_writes` 必须为 0）；
  模拟实验室的独立假设快照与只收 simulated 来源的事件日志保证模拟事件永不进入
  `observed`，模拟收益与真实迁移分通道报告。
- Step 11 校准只读合成 review 序列，只产出参数候选；候选登记为声明式配置变更，
  不能触及课程门禁/权限/隐私/真实-模拟隔离等受保护不变量。激活门禁默认拒绝、要求
  隔离评测通过 + 显式宿主审批、禁止自批，激活只返回冻结配置对象并记入 append-only
  审计，**绝不**写 `MemoryState`/`StudentTwin`；模拟收益恒为 `is_causal_evidence=false`，
  真实迁移只接受可信来源与 unseen 题项，且仍只作描述性结论。
- Step 16 的 observed / simulated 事件存储是两个独立边界：observed 拒绝 simulated 来源
  与模拟事件类型，simulated 拒绝 observed 来源；文件事件日志重开时校验逐条内容摘要，
  篡改或异域记录 fail-closed。内容库只返回 `approved` 记录，评测服务只允许可信来源的
  unseen transfer 进入真实通道，模拟数据不得重标为真实证据。
- Step 12 长期孪生把 checkpoint / 回滚 / 重放限制在推断状态，真实事件日志 append-only
  且证据 revision 不变；记忆 review、假设绑定与演化都只接受 observed evidence id，
  模拟 id 无法进入。校准候选必须显式审批后才能影响 review 动力学，回滚从截断后的
  推断日志重新推导生效参数；假设操作在 clone 上执行并绑定精确 twin version。
- Step 7 配置非法即 fail loud（不静默回退默认值）；六个工具输出 schema 顶层闭合，
  越界返回被 dsh 判为 `INVALID_TOOL_OUTPUT`；假设快照绑定 session/agent scope、带
  TTL 与清理且不写长期孪生；审计 append-only、只收标量与原因码、递归拒绝原始学生
  数据键，学生/租户维度只以盐化伪名出现在指标中（伪名化非匿名化，salt 需与身份数据
  同级的密钥存储保管）。
- Step 8 在每个工具 body 前运行 `SecurityGuard`：提示注入文本（改门禁/权限/受众/
  审批、角色冒充、套取密钥）与冒充宿主决策对象的参数键 fail-closed 并记入审计
  （只记原因码，不记原文）；超长字符串/数组/键数/深度/字节与循环引用返回
  `AEH_PAYLOAD_TOO_LARGE`；按 session 与 `studentRef` 的固定窗口限流返回
  `AEH_RATE_LIMITED` 且不影响其他会话；工具错误去掉绝对路径、`file://` URL 与密钥
  样式 token 后才离开 body。`SecurityError` 继承 dsh `HarnessError`，真实运行时
  以稳定 `info.code` 暴露。限流为单插件实例内存实现，跨进程分布式限流未完成。
