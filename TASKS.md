# AEH 任务拆分

目标仓库：https://github.com/weimanmk/AEH
本地工作目录：本目录（DeepSeek Harness headless 的工作目录，所有内容必须在这里可见）
规范全文：`spec/Adaptive_Cognitive_Twin_Education_Harness_v1.1.md`（v1.1，完整目标架构，不是 MVP 承诺）
参考资料（本地只读，**不要**提交到 Git 仓库，见 `.gitignore`）：
- `references/deepseek-harness/`：DeepSeek Harness dsh / Cordis 基座，MIT
- `references/MiroFish/`：多 Agent 仿真、GraphRAG、动态记忆的借鉴来源，AGPL-3.0，**只借鉴机制，禁止整套复制代码到本项目**
- `references/StudentSim/`：个体虚拟学生行为保真与教学提示响应的借鉴来源，许可证与数据权利需分别核验
- `references/awesome-fsrs/`：FSRS 算法说明与版本参考

## 不可妥协的不变量（每一步都要满足）

1. 真实/模拟隔离：`observed_*` 只能由真实学生/教师/可信判题写入；`simulated_*` 永远不能直接改变真实掌握度。
2. 课程门禁优先：发题前必须通过进度、安全、正确性门禁，fail-closed；未授知识默认不推送。
3. 可观察性优先：不宣称读心，只能用证据支持的认知机制。
4. 独立评测：训练题、解释、迁移评测隔离；模拟收益不能自证真实效果。
5. 插件最低权限：默认无学生原始数据、无数据库写权限、无凭据、无任意文件与网络访问。
6. 自进化受控：候选必须经隔离评测、批准、可回滚；不能自行改写生产系统，不能降低门禁。

## 步骤

### Step 1（本轮执行）：核心骨架 + 本地测试 + CI

用 Python 标准库（不引入外部依赖，CI 不需要 pip 安装）实现：

- `aeh/curriculum_gate.py`：实现规范 §4.3 的 `allow(q, u, m)`，模式为 `preview` / `learn` / `review`，缺失或低置信度标注时 fail-closed。
- `aeh/twin.py`：长期学生孪生体，事件溯源、版本化、可回滚；真实事件不可改，推断状态可重建；`simulated` 事件写入必须被拒绝写入 `observed`。
- `aeh/memory.py`：FSRS 风格记忆模型，规范 §8.3 的示意式 `R = (1 + 19/81 * t/S)^(-1/2)`，以及由目标保持概率反解间隔；独立作答权重高于提示后作答，阅读讲解不算独立检索成功。
- `aeh/hypothesis.py`：短期虚拟学生假设集合，支持 spawn / split / reweight / merge / prune，贝叶斯后验更新含噪声项，允许 unknown。
- `aeh/diagnosis.py`：区分性诊断题选择，信息增益减去时间、风险与认知负担惩罚，学生可跳过。
- `aeh/exercise.py`：干预包结构与验证，未通过课程门禁的候选一律不交付。
- `tests/`：用标准库 `unittest` 覆盖以上每一条不变量，至少包括：模拟不能改真实掌握、超前知识被门禁拒绝、提示后正确不等于独立检索成功、假设权重更新后归一化。
- `README.md`：说明本项目是什么、不是什么、如何运行测试、参考来源与许可证注意事项。
- `.github/workflows/ci.yml`：在 GitHub Actions 上运行 `python -m unittest discover -s tests -v`，Python 3.11 与 3.12。
- `.gitignore`：必须忽略 `references/`、`__pycache__/`、`.pytest_cache/` 等。

完成标准：你在本目录运行 `python -m unittest discover -s tests -v` 全部通过；不修改 `references/` 与 `spec/`；不提交任何密钥；不把参考仓库代码整段复制进来。

### Step 2（下一轮，不在本轮做）

- 命令行演示会话：拍题/批改/诊断/复习的最小闭环，用 Step 1 的核心，不接真实学生数据。
- 教师/家长报告生成（仅用已授权汇总事件）。

### Step 3（已完成）

- dsh Cordis 插件骨架（TypeScript），把 Step 1 的核心映射为教育插件与工具，见 `docs/dsh-integration.md`。离线结构适配层 `dsh-plugin/src/dsh.ts`，尚未在真实 dsh 运行时加载，`tsc --noEmit` 尚未在本地跑过。

### Step 4（本轮执行）：P0 真实 dsh 接入

按 `docs/dsh-integration.md` §9 P0 清单，把离线骨架变成能在真实 dsh / Cordis 运行时加载的插件，仍不接真实学生数据：

- 替换 `dsh-plugin/src/dsh.ts` 离线适配层为真实 `@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools` 导入；`package.json` 声明真实依赖，`npm install` 后 `npm run typecheck`（`tsc --noEmit`）必须通过；Node 测试 `node --test dsh-plugin/tests/*.test.ts` 仍全部通过。
- 实现一个内存 `HostContext` 适配器（仅合成/测试授权快照）：`resolveProgress` / `resolveItem` 绑定授权 session，未授权请求 fail-closed；再实现一个内存宿主孪生适配器：事件 append-only、幂等、版本/回滚、来源认证、审计可查，模拟事件仍隔离。
- 在真实 Cordis loader / dsh tool testkit 中做契约测试：工具 schema 校验、取消（`exec.signal`）、超时、卸载可清理；记录加载成功的证据（命令与输出），不要假装已加载。
- 交付适配器与审批仍保持分离：`aeh_prepare_intervention` 只准备不交付，交付必须经宿主审批记录；身份/租户/同意作用域用最小可行的授权快照建模，撤回时拒绝后续读取。
- 更新 `docs/dsh-integration.md`：把 P0 项逐项标记为已完成/未完成并写明证据；更新 `README.md` Step 4 一节；更新 `.github/workflows/ci.yml`，在 CI 中加入 Node 24 的插件测试与 `tsc --noEmit`（注意：CI 文件走 API 推不上去时，需走网页方式补推，见 Step 1/3 的经验）。
- 不引入真实学生数据，不写密钥，不修改 `references/` 与 `spec/`，不破坏 Step 1/2 的 Python 测试与 Step 3 的 TS 测试。

完成标准：`npm run typecheck` 通过；`node --test` 通过；`python3 -m unittest discover -s tests -v` 全部通过；有一份真实 loader 加载/卸载的运行证据；P0 清单中仍未完成项在文档中如实列出，不假装已实现。

### Step 5（本轮）

- 报告插件：新增只接收已授权聚合事件的 dsh 工具 `aeh_generate_report`，复用 Step 2 `report.py` 的边界（固定字段、受众 scope 收窄、跨学生/窗口/授权/重复排除），输出最小化聚合报告，不接受也不输出原始题目/答案/图片/事件 id；dsh schema 闭合 + 运行时字段白名单双重拒绝。
- 持久化与删除传播的最小模型：在 Step 4 内存孪生适配器之上增加默认关闭的文件事件存储 `FileEventStore`（本地合成目录，`enabled: false` 默认）；append-only、按事件幂等、SHA-256 完整性校验（非签名）、版本/回滚、保留期墓碑，以及同意撤回后的读写 fail-closed 与删除传播；持久化记录不含 payload。
- 评测体系（规范 §19）：`aeh/evaluation.py` 提供不可变、内容寻址的冻结评测集，train/explanation/transfer 分片隔离、迁移题强制 unseen；模拟收益与真实迁移分通道计算并分开报告，模拟数据不能进入真实通道或自证真实学习效果；`aeh/eval_cli.py` 可运行，`docs/evaluation-report-template.md` 为报告模板，`tests/test_evaluation.py` 覆盖隔离与防自证。
- 更新 `docs/dsh-integration.md`（Step 5 完成情况、P1、TODO）与 `README.md`（Step 5 一节、目录结构、测试与 CI 说明）；更新 `.github/workflows/ci.yml` 增加离线评测脚本步骤（无新增外部服务）。
- 不引入真实学生数据，不写密钥，不修改 `references/` 与 `spec/`，不破坏既有 Python / TS 测试；`tsc --noEmit` 与 loader 契约测试（独立隔离实例）继续通过。

完成标准：`python3 -m unittest discover -s tests -v` 全部通过；`python3 -m aeh.eval_cli` 可运行；`npm run typecheck` 通过；`node --test tests/*.test.ts` 全部通过；`npm run evidence:loader` 仍在独立实例中成功；未完成项在文档中如实列出，不假装已实现。

### Step 6（已完成）

- 受控自进化流水线骨架（规范 §27）：候选—隔离评测—批准—灰度—回滚，候选不能降低门禁，不能自行改写生产系统；宿主侧内存/合成实现，不接真实生产。Python `aeh/evolution.py` + TypeScript `dsh-plugin/src/host/evolution.ts`，无新增模型可调用工具。

## 第二阶段：完整实现（Step 7–19，每步只做一件事，做完即验）

第二阶段把 v1.1 规范中仍为骨架/未做的部分逐项落到可运行、可测试的实现。仍只用合成数据；需要真实外部系统（身份提供方、LMS、真实 LLM/OCR、真实学生数据）才能完成的部分，只做宿主适配器接口与文档，**不伪造**，并在文档中如实列为未完成。所有步骤共享 Step 1–6 的不变量与 dsh 分离规则。

### Step 7（本轮执行）：P1 加固——配置与输出 schema、会话状态、审计

- 用 Schemastery 定义插件 `Config`，替换 `normalizeConfig` 的运行时校验，非法配置 fail loud；把 6 个工具的宽松 `type: 'json'` 输出换成各自明确的 object schema。
- 会话状态：假设快照绑定 dsh session/agent scope，明确 TTL、隔离与清理，不得写入长期孪生；会话结束/超时后快照不可再被另一会话读取。
- 审计与可观察性：追加式审计记录门禁拒绝原因、工具调用、审批与交付回执，不记录原始题目/答案/图片；指标带学生/租户维度但不可反识别。
- 完成标准：`tsc --noEmit` 通过；TS 测试全部通过；Python 测试全部通过；非法配置与越界输出 schema 的测试覆盖；`docs/dsh-integration.md` 更新 P1 完成情况。

### Step 8：安全加固——注入、越权、限流与脱敏

- 提示注入防护：工具参数中的指令式文本不得改变门禁/权限/报告受众决策；越权参数（伪造进度、标注、scope）一律 fail-closed；超大 payload 拒绝；速率限制（按 session/studentRef）；错误信息不泄露内部细节；日志脱敏审查。
- 完成标准：上述每项有测试；TS/Python 测试全部通过；`docs/dsh-integration.md` 安全一节更新。

### Step 9：课程图谱与题库（规范 §3）

- KC 图（节点/边/前置关系、版本化）、题库结构（item + 标注 + 版本 + 审核状态）、本地内存 RAG 检索接口（按 KC/难度/题型检索，返回 opaque itemId 与标注摘要，不返回原文给模型侧以外的调用方）；检索结果必须再过课程门禁。
- 完成标准：图谱与题库模块 + 测试（前置未满足时检索/交付拒绝、版本变更可追溯）；Python/TS 测试全部通过。

### Step 10：习题演化引擎与模拟实验室（规范 §9、§11）

- 演化算子：变式生成（数值/情境/干扰项）、难度调节、诊断指向性变式；每个演化候选必须标注来源与变更，演化题进入隔离沙箱评测后才能进入候选池。
- 模拟实验室运行机制：模拟会话隔离运行、模拟事件永不写入 observed、实验配置与结果可复现记录。
- 完成标准：演化与实验室模块 + 测试；Python/TS 测试全部通过；模拟隔离不变量测试覆盖。

### Step 11：FSRS 校准（规范 §8）

- 个体—知识—任务条件的记忆模型：在示意公式之上实现参数拟合（仅合成数据）、稳定性/难度更新、不确定性区间、模型版本记录；校准脚本可运行，输出参数与拟合报告（合成数据，明确非生产校准）。
- 完成标准：校准模块 + 测试 + 可运行脚本；Python/TS 测试全部通过。

### Step 12：长期孪生体完整实现（规范 §5）

- 事件溯源完整语义：append-only、幂等、快照与重建、版本化、回滚（真实证据不被回滚删除）、证据绑定 mastery、observed/simulated 硬隔离、隐私字段最小化。
- 完成标准：孪生模块扩展 + 测试覆盖上述每条；Python/TS 测试全部通过。

### Step 13：虚拟学生群完整实现（规范 §6）

- 生成/匹配/分裂/合并/淘汰的完整规则、假设保真度指标、unknown 桶管理、假设快照的会话隔离与持久化边界。
- 完成标准：假设模块扩展 + 测试；Python/TS 测试全部通过。

### Step 14：主动诊断与反向溯源完整实现（规范 §7）

- 反向溯源（从错误步骤回溯 KC/误解）、信息增益计算、诊断会话状态机（出题—作答—更新—终止条件）、学生跳过与负担上限。
- 完成标准：诊断模块扩展 + 测试；Python/TS 测试全部通过。

### Step 15：教学策略与日常协同、跨学科与学习科学（规范 §10、§17、§18）

- 策略编排：预习—学校学习—AI 强化—复习的日常协同流程、策略选择规则与护栏；跨学科适配层（学科无关的 KC/策略接口 + 两个学科示例）；学习科学方法落地清单（检索练习、间隔、交错）的实现映射。
- 完成标准：策略模块 + 测试；Python/TS 测试全部通过。

### Step 16：数据模型、存储服务与 Harness 状态机（规范 §12、§13）

- 服务边界：事件存储、Profile/Bundle、内容库、评测服务的接口定义与内存/文件双实现；乐观并发、幂等键、写入协调；Harness 状态机（学习闭环状态与转移、异常分支）。
- 完成标准：服务与状态机模块 + 测试（含并发/幂等）；Python/TS 测试全部通过。

### Step 17：隐私、安全、未成年人保护与指标面板（规范 §20、§21）

- 同意记录模型、保留期与删除传播（跨存储）、未成年人保护流程（监护人 scope、受众限制）、审计导出；指标面板数据模型（学习、系统、成本）与成本估算接口（不接真实计费）。
- 完成标准：隐私/指标模块 + 测试；Python/TS 测试全部通过；文档更新。

### Step 18：真实会话端到端验收（隔离实例）

- 在一个**独立隔离**的 dsh 实例（独立配置/home、独立 profile、独立 npm 安装，绝不复用运行用 `~/.dsh/` 与 headless 配置）中加载 AEH 插件，用 Sidrune 模型跑一次合成会话（门禁—诊断—复习—报告），记录完整证据；若 dsh 运行时无法隔离或无法在独立实例中加载，必须如实报告为未完成，不得伪造证据、不得把插件加载进正在执行任务的 harness 会话。
- 完成标准：有可复现的运行证据（命令、输出、日志摘要）或明确的未完成报告；Python/TS 测试全部通过。

### Step 19：生产接入收尾

- 部署文档、配置示例、运维手册（启动、升级、回滚、备份）、剩余未完成项总清单（需要真实身份提供方、LMS、LLM/OCR 服务、真实学生数据的部分，逐项说明需要什么外部条件）；全量测试与 CI 绿；README 与 docs 定稿。
- 完成标准：文档齐全；全量测试通过；CI 绿；未完成项清单如实无遗漏。

## 工作方式

- 只在本目录内创建/修改文件。
- **改造的 dsh 与运行代码的 dsh 必须分开**：AEH 的插件工作只在本目录（`dsh-plugin/`、`docs/`）内进行，参考资料只读；绝对禁止修改运行用 harness —— `~/.dsh/` 的配置与存储、`~/workspace/deepseek-harness` 源码克隆、npx 安装的 dsh；绝对禁止把 AEH 插件加载进正在执行本任务的 harness 会话。Step 4 的 loader/契约测试必须用独立的、隔离的 Cordis/dsh 测试实例（独立配置与工作目录、独立 npm 安装），不得复用 headless 运行配置。
- 每一步完成后用一句话总结改了什么、测试结果是什么。
- 如果某项规范在本轮无法用标准库安全实现，写成 `TODO` 并说明原因，不要假装已实现。
