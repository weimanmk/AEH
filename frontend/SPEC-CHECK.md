# AEH 规范对照自查（SPEC-CHECK.md）

- **对照对象**：`spec/Adaptive_Cognitive_Twin_Education_Harness_v1.1.md`（只读，未修改）。
- **被检查对象**：`frontend/src` 下的首页与 4 个视图，以及唯一数据源 `frontend/src/data/synthetic.ts`。
- **方法**：通读规范 §3/§5/§6/§7/§8/§9/§10/§11/§12/§13/§17/§18/§19/§20/§21，逐项对照五个视图，
  记录「规范条款 / 现状 / 处理」。处理只有两类：**已补**（在演示范围内补齐，位置可追）或
  **演示范围外**（说明理由，不编造后端能力）。
- **硬规则遵守**：只写 `frontend/`；未修改 `frontend/DESIGN.md` 的设计语言；未触碰 `~/.dsh/`、
  `~/workspace/deepseek-harness`、npx 安装的 dsh、`references/`、`spec/`；只用合成数据；
  未把 AEH 插件加载进当前 harness 会话。
- **章节号说明**：规范中 **§20 是「指标面板、运行成本与可观测性」，§21 是「隐私、安全、未成年人保护与内容治理」**。
  任务描述写作“§20 隐私、§21 指标”，本文件按规范实际章节编号处理（两个章节都已覆盖）。
- **第 2 轮复核对齐**：第 3 节的 14 项范围外事项已与
  [`../docs/remaining-gaps.md`](../docs/remaining-gaps.md) 第 3 节逐条对齐（同一事项、同一理由，
  以 remaining-gaps.md 为准），修订记录见 §5；新增的后端能力交叉引用见 §4。

## 0. 结论摘要

| 项 | 数量 |
|---|---|
| 对照检查点 | 80 |
| 已补（演示范围内） | 66 |
| 演示范围外（附理由） | 14 |
| 无法补齐而需诚实报告 | 0（范围外项已在下方逐条说明） |

- **构建**：`npm run build` 通过（`tsc --noEmit` + `vite build`），见 [`BUILD.md`](BUILD.md)。
- **设计语言**：未改 `DESIGN.md`；构建后 CSS 体积与第一阶段一致（15.82 kB），新增内容全部复用既有组件与 CSS 类。
- **数据边界**：新增内容全部是 `synthetic.ts` 中的合成 fixture + 浏览器内存状态，无网络请求、无后端、无真实接口。
- **后端边界（第 2 轮补）**：前端演示仍然无后端；本仓库 `aeh/`（Python）与 `dsh-plugin/`（TypeScript）
  另有**独立后端实现**，逐项见 §4。§4 只陈述后端已有能力及其边界，**不计入前端功能**，
  也不改变第 3 节 14 项“演示范围外”的前端结论。

## 1. 逐章对照

### §0–§2 全局架构、决策优先级与真实/模拟隔离

| # | 规范条款 | 现状 | 处理 |
|---|---|---|---|
| 1 | §2.3 真实世界与模拟世界严格隔离 | 指标视图原先只分「L3 模拟收益 / L4 真实迁移」两栏 | 已补：模拟运行记录显式标注 `source_type=simulated`、`is_real_student_evidence=false`；`MetricsView` 新增「模拟实验室（严格隔离）」 |
| 2 | §2.2 决策优先级 / 受限决策器 | 前端无流程呈现 | 已补：`TeacherView` 新增工作流状态机与 Agent 禁止行为表；教学策略路由只能从 9 类动作中选择 |
| 3 | §0.2 不可妥协不变量（模拟不得写成真人数据） | 仅有文案声明 | 已补：模拟记录结构化字段 + 防刷分约束（`rewardHackGuards`） |

### §3 课程与学习知识空间（Graph + RAG + 题库）

| # | 规范条款 | 现状 | 处理 |
|---|---|---|---|
| 4 | §3.1 学段→课程→知识点完整本体层级 | 只有 5 条合成 KC（`kcCatalog`），无真实课标/教材库 | 演示范围外：需要真实课标与教材数据源，前端不编造课程本体。【后端对应：见 §4 第 1 条（仅后端能力）】 |
| 5 | §3.1 关系类型全集（SUPPORTS/PART_OF/ASSESSES/USES_STRATEGY/REMEDIATES/TRANSFERS_TO/IN_TEXTBOOK…） | 实际 `curriculumEdges` 边实例只有 `REQUIRES` / `CAN_FAIL_AS` + `reviewState`（`EdgeType` 类型联合另声明了 `SUPPORTS`/`ASSESSES`，但没有边实例） | 演示范围外：新增边类型需真实课标/教师审核与图存储；本题库已用 `qMatrix`/`strategyIds`/`misconceptionTargets` 承载 ASSESSES/USES_STRATEGY 语义。【后端对应：见 §4 第 2 条（仅后端能力）】 |
| 6 | §3.1 proposed_edge 经校验才能成为正式边 | `curriculumEdges.reviewState` 已区分 approved/proposed | 已补（保留并展示）：教师视图先修关系显示 `reviewState` |
| 7 | §3.2 文档索引与多路检索（BM25+向量+图谱+重排） | 无 | 演示范围外：需教材库、向量库与重排服务，前端不伪造检索能力。【后端对应：见 §4 第 3 条（仅后端能力）】 |
| 8 | §3.3 题库结构化标签（item_id/source/license/q_matrix/strategy_ids/misconception_targets/verifier/answer_spec/hint_leakage_level/near·far_transfer/approval/exposure…） | 原 `StudentItem` 仅含少量字段 | 已补：新增 `itemStructuredTags` 覆盖三段式标签全集；`StudentView` 展示 |
| 9 | §3.3 核心 KC 是“求解实际必需”而非题面关键词 | 原无 Q-matrix | 已补：`qMatrix` 带 `weight` 与 `required` 标记并在学生视图展示 |

### §4 学校进度驱动的三相学习系统

| # | 规范条款 | 现状 | 处理 |
|---|---|---|---|
| 10 | §4.1 三条彼此独立的进度轴 | `progressAxes` 已有（School/Cognitive/AIAugmentation） | 已补（保持）：教师视图三轴卡片 |
| 11 | §4.1 分别保存 `progress_source` / `confirmed_at` / `confidence` | 原只有 confidence + note | 已补：新增 `progressAxisMeta`，教师视图以表格展示来源、确认时间与置信度 |
| 12 | §4.2 预习/同步/复习三场景准入约束 | 原无；仅 trace 文本提及 allowed_kcs | 已补：`allowedKcSets`（preview/learn/review，含 `depthLimitedKcs`） |
| 13 | §4.3 课程门禁六条件合取算法 | 原无独立呈现 | 已补：`curriculumGateResults`；`StudentView` 新增「课程门禁状态（本题 · mode=learn）」逐条件展示 |
| 14 | §4.3 fail-closed（置信度低/隐藏未教方法时转更安全题或请确认） | 原无 | 已补：两条 fail-closed 示例（预习模式下的异分母加法、未教授的分数乘法候选题） |
| 15 | §4.4 课堂作为外生事件（讲过≠掌握） | 原无 | 已补：`exogenousEvents`（`SCHOOL_LESSON_REPORTED`）在 `StudentView` 展示 |

### §5 长期认知孪生体

| # | 规范条款 | 现状 | 处理 |
|---|---|---|---|
| 16 | §5.1 多层状态（curriculum/knowledge_state/strategy_state/misconception_beliefs/review_state/pedagogical_preferences/model_meta） | 原缺 `review_state` / `pedagogical_preferences` / `model_meta` | 已补：`twinMeta`（含记忆模型版本、待处理复习事件、教学偏好、校准配置、未决假设）；教师视图展示 |
| 17 | §5.2 认知状态不能压缩为一个掌握率（概念/程序/策略迁移/检索） | 原 `knowledgeState` 每 KC 只有单一 `masteryPosterior.mean` | 已补：`knowledgeFacets` 四维估计（含不确定性）；教师视图新增四维表 |
| 18 | §5.3 可观察思路表示（步骤节点+操作规则+依赖+校验+置信度） | 原仅诊断 trace 的文本 payload | 已补：`observableTrace` 有向步骤图（含 invalid 步骤与置信度）；教师视图展示 |
| 19 | §5.3 不补造思维轨迹、不读心 | 原学生视图已有文案 | 已补（保持并强化）：步骤图旁给出读心边界说明 |
| 20 | §5.4 事件溯源与版本化状态（原始事件不可改，推断状态可重建/回滚） | 原仅学生视图“重做追加事件” | 已补：`twinVersionHistory`（commit/rebuild/rollback + evidence_hash）与 `twinMeta.eventSourcing`；教师视图展示 |

### §6 动态短期虚拟学生群

| # | 规范条款 | 现状 | 处理 |
|---|---|---|---|
| 21 | §6.1 虚拟学生 = 结构化认知假设（非性格标签） | `hypotheses` 字段齐全 | 已补（保持）：教师视图假设卡片 |
| 22 | §6.2 Spawn/Split/Reweight/Merge/Prune/Resample/Unknown 与动态 N_active | 原缺 | 已补：`hypothesisLifecycle`（事件日志）与 `hypothesisBudget`（N_active、信息增益、预算） |
| 23 | §6.3 观测匹配 Bayesian / particle-style 及噪声/校准要求 | 原只有 `posteriorShifts` | 已补：`beliefUpdate`（公式 + 4 条落地要求） |
| 24 | §6.4 约束式行为模拟（状态引擎约束、验证器判定） | 无真实学生模拟器；界面仅有受 `bug_rules` 约束的 `Student Behavior Model` 合成说明 | 演示范围外：状态引擎与验证器判定未实现，前端不伪造模拟器。【后端对应：见 §4 第 4 条（仅后端能力）】 |
| 25 | §6.2 清晰任务可 N_active=0 | 原无 | 已补（说明）：`hypothesisBudget.rationale` 明确“不要求每次都启动多 Agent” |

### §7 反向溯源与主动诊断

| # | 规范条款 | 现状 | 处理 |
|---|---|---|---|
| 26 | §7.1 Observe→Localize→Expand→Simulate→ChooseProbe→Update | `diagnosticTrace` 已有 | 已补（保持）：教师视图诊断追溯链 |
| 27 | §7.2 期望信息增益 IG(q) 与 q\* 优化目标（含惩罚项） | 原仅 trace 中一句 IG≈0.31 | 已补：`diagnosisObjective`（公式与 α/β/γ）+ `probeCandidates`（IG/教学价值/用时/风险/score/门禁） |
| 28 | §7.2 少问、问得准、随时可跳过 | 原无 | 已补：目标说明 + 教学动作含 `ANSWER_DIRECTLY`（学生要答案时不强迫诊断） |
| 29 | §7.3 区分性诊断示例（H1/H2/H3） | `diagnosticTrace` 已有 | 已补（保持） |

### §8 遗忘曲线拟合与复习调度

| # | 规范条款 | 现状 | 处理 |
|---|---|---|---|
| 30 | §8.1 目标与边界（记忆保持≠概念理解） | 指标视图有留存分节 | 已补（保持并分节）：复习事件质量 / 记忆单元 / 复习调度在教师视图独立成节 |
| 31 | §8.2 候选模型层级选型（Leitner/SM-2、FSRS/DSR、BKT、IRT、HLR、DKT） | 仅 FSRS 示意式 | 演示范围外：不实现多模型选型，需真实复习序列与题目标定；仅标注 `model_family=fsrs_compatible`。【后端对应：见 §4 第 5 条（仅后端能力）】 |
| 32 | §8.3 检索概率示意式与 `memory_state` 字段 | 已有 `retrievability` + `retentionUnits` | 已补（保持） |
| 33 | §8.3 稀疏观测不得拟合成高精度个人曲线 | 原已有说明 | 已补（保持） |
| 34 | §8.4 复习事件质量字段（independent/hint_level/success/latency/self-report/transfer/context/difficulty/KCs/strategies） | 原缺 | 已补：`reviewEventSamples`（含“提示后才改对不计为独立检索成功”） |
| 35 | §8.5 真正的拟合过程（先验/真实观测/参数估计/收缩/时间外验证/重估） | 仅 `parameterPosterior=cohort_regularized` | 演示范围外：无真实复习观测，无法做参数拟合与时间外验证。【后端对应：见 §4 第 6 条（仅后端能力）】 |
| 36 | §8.6 由目标保持概率反解下次间隔 | 原缺（只有 nextReviewAt 静态值） | 已补：`nextIntervalDays()`（Δt=(81/19)·S·(r_target⁻²−1)）+ `reviewTargets`；教师视图展示 |
| 37 | §8.7 复习队列统一调度优先级 | 原缺 | 已补：`reviewQueue` + `reviewQueueWeights` + 逐项权重与优先级 |
| 38 | §8.8 虚拟学生三种机制（遗忘 vs 未建立 vs 缺迁移） | 原缺 | 已补：`virtualStudentMechanisms` |
| 39 | §8.8 虚拟学生成功率不能充当真实遗忘样本 | 原无显式约束 | 已补：`rewardHackGuards` 与本文件/指标视图的模拟隔离声明 |

### §9 习题演化引擎

| # | 规范条款 | 现状 | 处理 |
|---|---|---|---|
| 40 | §9.1 从“当前可观察误区→目标规则”反推出题 | 原缺 | 已补：`interventionPackage.objective`（目标 KC、当前误区、目标行为、评估类型） |
| 41 | §9.2 InterventionPackage 八要素 | 原缺 | 已补：学习目标/训练题组/提示阶梯/反馈模板/讲解资源/独立迁移测试/完成判据/进度证明 |
| 42 | §9.3 按教学目的的题型生成器 | 原缺 | 已补：`itemTypeGenerators`（11 类，标注“本演示/范围外”） |
| 43 | §9.4 生成→门禁→校验→模拟→筛选→真实验证 | 原缺 | 已补：`evolutionPipeline`（真实验证标注“待真实观测”） |
| 44 | §9.5 教学价值 U(a)（增益 − 时间 − 不确定性 − 负荷 − 泄露风险） | 原缺 | 已补：`candidateInterventions` + `teachingValueWeights` + 排名（诊断题按 IG、增强题按教学增益分流） |
| 45 | §9.5 增益由与生成器隔离且经真实数据校准的流程估计；含最坏情况后悔值 | 已有 `candidateInterventions`/`teachingValueWeights` 的合成 U(a) 排序；无真实校准增益、无最坏情况后悔值 | 演示范围外：需真实校准数据与独立评测流水线，前端不伪造该结论；`evolutionPipeline` 的 rank 步骤已如实标注“最坏情况后悔值与真实校准未计算”。【后端对应：见 §4 第 7 条（仅后端能力）】 |
| 46 | §9.6 防模拟刷分 / reward hacking | 原缺 | 已补：`rewardHackGuards`（同快照起跑、训练/测试隔离、验证器独立等） |

### §10 教学策略与日常协同

| # | 规范条款 | 现状 | 处理 |
|---|---|---|---|
| 47 | §10.1 教学策略路由器 9 类动作 | 原缺 | 已补：`policyActions` + `teachingPolicy`（含选择理由与约束） |
| 48 | §10.2 学校学习节奏全态协调 | 教师视图有进度轴 | 已补：进度来源/确认时间 + 课堂外生事件；“每周总结/假期换学期”等完整日程调度演示范围外 |
| 49 | §10.3 每次会话时间分配（preview/current/review/diagnostic/transfer） | 原缺 | 已补：`teachingPolicy.timeBudget`（按课堂压力动态分配，非固定模板） |
| 50 | §10.4 教学提示梯度 | 学生视图只有递增提示 | 已补：`hintGradient` 六级梯度（激活→小问→指向错步→对比→局部示范→完整讲解） |

### §11 动态模拟实验室

| # | 规范条款 | 现状 | 处理 |
|---|---|---|---|
| 51 | §11.1 模拟环境七组件 | 原缺 | 已补：`simulationLabComponents`（Scenario/Snapshot/Environment/Behavior Model/Tutor Policy/Verifier/Outcome Evaluator） |
| 52 | §11.2 试学=前测→干预→后测（近/远迁移），不是“做对一道题” | 原缺 | 已补：`simulationRun.stages`（含未运行的远迁移，诚实标注可选/未运行） |
| 53 | §11.3 多候选集成（后验采样、误差独立、不确定性传播、MODEL_MISMATCH、能力边界） | 原缺 | 已补：`simulationRun.integrationRules` + 80% 增益区间 + mismatch 状态 |
| 54 | §11.4 可借鉴开源项目（MiroFish / StudentSim） | `references/` 为只读参考 | 演示范围外：不复制、不修改 `references/`；未做第三方代码/许可复用。【后端对应：见 §4 第 8 条（仅后端能力）】 |

### §12 Harness 执行框架、状态机与 Agent/工具边界

| # | 规范条款 | 现状 | 处理 |
|---|---|---|---|
| 55 | §12.1 Orchestrator 职责与“LLM 不得直接写库/不得把模拟当真人” | 原仅文案 | 已补：状态机 + Agent 禁止行为表 + 明确边界说明 |
| 56 | §12.2 工作流状态机 | 原缺 | 已补：`workflowNodes` / `workflowEdges` / `workflowCurrentPath`（当前演示路径） |
| 57 | §12.3 Agent 逻辑角色与禁止行为 | 原缺 | 已补：`agentRoles`（11 条，输入/输出/禁止行为） |
| 58 | §12.4 工具调用目录 | 原缺 | 已补：`toolCatalogSample`（10 个工具签名） |
| 59 | §12.5 结构化 API 与 illustrative 标注 | 原有报告/评测结构 | 已补：`recommendationAudit` + 模拟记录 `illustrative_only` 声明 |
| 60 | §12.4 幂等键、事务/Outbox、超时与审计日志 | 无 | 演示范围外：无后端与消息系统，前端不伪造事务能力。【后端对应：见 §4 第 9 条（仅后端能力）】 |

### §13 数据模型、存储与服务边界

| # | 规范条款 | 现状 | 处理 |
|---|---|---|---|
| 61 | §13.1 核心实体与表 | 无数据库；以合成结构体现 | 演示范围外：前端无持久层，不建真实表。【后端对应：见 §4 第 10 条（仅后端能力）】 |
| 62 | §13.2 存储分层（PostgreSQL/pgvector/图库/对象存储/Redis/MQ） | 无 | 演示范围外：前端演示不连接任何存储。【后端对应：见 §4 第 11 条（仅后端能力）】 |
| 63 | §13.3 权限域划分（五域） | 报告视图原只有教师/家长范围收窄 | 已补：`permissionDomains` 五域；`ReportView` 展示 |

### §17 跨学科适配层

| # | 规范条款 | 现状 | 处理 |
|---|---|---|---|
| 64 | §17 跨学科共享架构与差异（数/理/化/编程/语言/实践） | 原缺 | 已补（结构说明）：`crossSubjectAdapters` 六学科对照表；`MetricsView` 展示 |
| 65 | §17 非数学学科验证器与高风险场景安全过滤的实现 | 无 | 演示范围外：仅覆盖分数知识点；高风险实践内容与专业监管未实现。【后端对应：见 §4 第 12 条（仅后端能力）】 |

### §18 学习科学方法如何进入 Harness

| # | 规范条款 | 现状 | 处理 |
|---|---|---|---|
| 66 | §18 教学法工具箱（16 类方法 + 条件 + 验证） | 原缺 | 已补：`learningMethods`（含“本演示启用/未启用”） |
| 67 | §18.1 组合规则而非“拼盘” | 原缺 | 已补：`methodCombinationRule`（概念误解 → 对比反例+自我解释+示范 → 迁移验证） |
| 68 | §18.2 以教学目标定义评估单位 | 原缺 | 已补：干预包 `completionCriteria` + 独立未见迁移题 |

### §19 评测体系

| # | 规范条款 | 现状 | 处理 |
|---|---|---|---|
| 69 | §19.1 四级评测结构（L1–L4） | 指标视图原有 L3/L4 分节 | 已补（保持并扩展）：分维度指标含 L3/L4 口径 |
| 70 | §19.2 遗忘模型专属评测（Brier/Log loss/ECE/时间外留出/稀疏分层） | 指标视图给 Brier/Log loss/校准误差（属 §19.3 诊断假设保真度）；§20.1 另有遗忘模型合成字段；§19.2 自身无独立面板 | 已补（部分）：保留 §19.3 诊断保真度与 §20.1 遗忘模型合成字段；§19.2 的时间外留出与稀疏分层演示范围外（需真实时间序列）。Brier/Log loss/校准误差属 §19.3，不冒充 §19.2 评测。【后端对应：见 §4 第 15 条（仅后端能力）】 |
| 71 | §19.3 虚拟学生拟合与认知假设评测（行为保真/教学响应/假设校准） | `diagnosticFidelity` 已有 | 已补（保持） |
| 72 | §19.4 真实教学因果效果（随机对照/离线策略评估） | 无 | 演示范围外：无真实学生与对照实验，不得声称因果效果。【后端对应：见 §4 第 13 条（仅后端能力）】 |
| 73 | §19.5 上线前安全门槛 | 原仅有文案 | 已补（声明层）：门禁无绕过路径提示、模拟污染禁令；独立安全审查演示范围外 |

### §20 指标面板、运行成本与可观测性

| # | 规范条款 | 现状 | 处理 |
|---|---|---|---|
| 74 | §20.1 七维度关键运行指标 | 原仅留存/诊断覆盖 | 已补：`metricsByDimension`（学生学习/课程同步/认知拟合/习题生成/遗忘模型/基础设施/公平与安全） |
| 75 | §20.2 控制成本原则（题型路由、expected value of computation、缓存） | 原缺 | 已补（指标层）：基础设施指标（模型调用、token 成本、耗时、缓存命中、失败率）；成本控制算法本身演示范围外。【后端对应：见 §4 第 16 条（仅后端能力）】 |
| 76 | §20.3 每条推荐的可解释审计记录 | 原缺 | 已补：`recommendationAudit`（为什么现在发/属于哪章/证据/备选假设/模拟不确定性/如何检验）；教师视图展示，学生视图只给一句话解释 |

### §21 隐私、安全、未成年人保护与内容治理

| # | 规范条款 | 现状 | 处理 |
|---|---|---|---|
| 77 | §21.1 最小化采集原则 | 原仅有合成数据声明 | 已补：`privacyMinimization.principles`（学习事件为中心、进度由本人/教师确认、虚拟学生仅学习特征、拍题信息遮蔽） |
| 78 | §21.2 数据治理与模型隔离 | 原报告视图有部分字段 | 已补：`privacyMinimization.governance`（监护同意、加密审计、保留期、导出/纠错/删除、禁止高风险标签） |
| 79 | §21.3 学术诚信与教师权责 | 原缺 | 已补：`privacyMinimization.academicIntegrity`（教师可覆盖、申诉复评、提示/引导/完整讲解模式） |
| 80 | §21.4 开源许可合规评估 | README/报告已有边界声明 | 演示范围外：未做法律合规评估、未复制第三方代码；`references/` 保持只读。【后端对应：见 §4 第 14 条（仅后端能力）】 |

## 2. 新增内容在代码中的位置

- 数据：`frontend/src/data/synthetic.ts` 末尾「第二阶段：v1.1 规范自查补齐」区块（§3.3/§4.3/§4.4/§5/§6/§7/§8/§9/§10/§11/§12/§13.3/§17/§18/§20/§21），以及 `progressAxisMeta`。
- 视图：
  - `StudentView.tsx`：课程门禁（§4.3）、题目标签与推荐依据（§3.3/§20.3）、课堂外生事件（§4.4）。
  - `TeacherView.tsx`：孪生生命周期（§5.1/§5.4）、四维认知（§5.2）、可观察步骤图（§5.3）、假设生命周期（§6.2/§6.3）、诊断目标（§7.2）、复习事件/间隔/队列（§8.4/§8.6/§8.7）、教学策略（§10）、习题演化（§9）、状态机（§12）、学习科学（§18）、审计记录（§20.3）。
  - `ReportView.tsx`：权限域（§13.3）、隐私最小化与治理（§21）。
  - `MetricsView.tsx`：模拟实验室隔离（§11）、分维度指标（§20.1）、跨学科适配层（§17）。
  - `HomeView.tsx`：规范覆盖地图与「演示范围外」声明。
- 未改动：`frontend/DESIGN.md`、`frontend/src/styles/*`、`package.json` 依赖。

## 3. 演示范围外清单（与逐章表的 14 条范围外项一一对应，并与 `docs/remaining-gaps.md` 第 3 节对齐）

每条同时给出「现状」与「需要的外部条件」，措辞以 `docs/remaining-gaps.md` 第 3 节为准。

1. §3.1 完整课程本体层级 —— 现状：只有 5 条合成 KC；需要：真实课标/教材与教师审核数据。
2. §3.1 关系类型全集（SUPPORTS/PART_OF/TRANSFERS_TO…） —— 现状：边实例只有 `REQUIRES`/`CAN_FAIL_AS`；需要：真实课标与教师审核 + 图存储。
3. §3.2 多路检索 RAG / 向量库 / 重排 —— 现状：无；需要：教材索引与检索服务。
4. §6.4 真实约束式学生模拟器 —— 现状：只有受 `bug_rules` 约束的合成说明；需要：经真实数据校准的模拟器。
5. §8.2 多遗忘模型选型（BKT/IRT/HLR/DKT） —— 现状：仅 FSRS 示意；需要：题目标定与充足真实复习序列。
6. §8.5 真实参数拟合与时间外验证 —— 现状：仅 `cohort_regularized` 后验；需要：真实复习观测。
7. §9.5 经校准的增益估计与最坏情况后悔值 —— 现状：无；需要：独立评测流水线与真实数据。
8. §11.4 开源项目代码复用 —— 现状：`references/` 只读；需要：许可评估（MiroFish AGPL 等）。
9. §12.4 幂等/事务/Outbox —— 现状：无后端与消息系统；需要：后端、事务存储、消息系统。
10. §13.1 核心实体数据库表 —— 现状：前端无持久层；需要：数据库与迁移。
11. §13.2 存储分层（PG/pgvector/图库/对象存储/Redis/MQ） —— 现状：未连接任何存储；需要：各类生产存储。
12. §17 非数学学科验证器与高风险安全过滤实现 —— 现状：仅分数知识点；需要：学科验证服务与专业监管。
13. §19.4 真实随机对照与因果效果 —— 现状：无真实学生与对照组；需要：真实学生、对照实验、伦理/合规审批。
14. §21.4 开源许可法律合规评估 —— 现状：前端演示范围外；需要：法律合规审查。

> 说明：第 3 节与 `docs/remaining-gaps.md` 第 3 节逐条对齐（14 项、同一事项、同一理由），
> 本清单额外标出「现状 / 外部条件」便于回查。另有两项「部分已补」，不计入范围外：
> §19.2 的指标层（Brier/Log loss/校准误差）实际属 §19.3 诊断假设保真度，§19.2 自身的时间外留出
> 与稀疏分层未做（需真实时间序列）；§20.2 只到指标层，成本控制算法本身未实现。

## 4. 后端能力交叉引用（仅后端，不是前端功能）

> 本节只回答一个问题：这 14 项“前端演示范围外”里，哪些能力其实已由本仓库的**独立后端**
> （`aeh/` Python 与 `dsh-plugin/` TypeScript）实现。所有条目均为**后端能力**，前端视图不调用它们，
> 也**不把后端能力算作前端功能**；§1 中对应项的“演示范围外”前端结论不变。
> 测试名格式：Python 为 `tests/test_*.py::Class::test_method`，TypeScript 为
> `dsh-plugin/tests/*.test.ts` → `test('...')` 名称。判断依据见各条“后端边界”。

| 第 3 节 # | 规范条款（逐章表 #） | 后端实现（文件 / 符号） | 后端测试 | 后端边界（仍未实现的部分） |
|---|---|---|---|---|
| 1 | §3.1 完整课程本体层级（#4） | `aeh/curriculum_graph.py::KnowledgeGraph` / `NODE_TYPES`；`dsh-plugin/src/core/curriculum-graph.ts::KnowledgeGraph` | `tests/test_curriculum_graph.py::KnowledgeGraphTests::test_version_store_is_append_only_and_traceable`；`dsh-plugin/tests/curriculum-graph.test.ts` → `graph versions are append-only, hashed, and diffable` | 只有扁平 KC/子技能节点 + 通用 `PART_OF` 边；`stage`/`course` 只是题目注解（`ItemAnnotation`）字段，不是层级节点；无真实课标/教材数据 |
| 2 | §3.1 关系类型全集（#5） | `aeh/curriculum_graph.py::RELATION_TYPES`（9 种）；`dsh-plugin/src/core/curriculum-graph.ts::RELATION_TYPES` | `tests/test_curriculum_graph.py::KnowledgeGraphTests::test_duplicate_nodes_edges_and_unknown_relation_are_rejected`；`dsh-plugin/tests/curriculum-graph.test.ts` → `cycles, self loops, unknown endpoints, duplicates and bad relations are rejected` | 9 种关系都能声明/校验；只有 `REQUIRES`/`PART_OF` 有遍历与先修语义，其余 7 种仅存储校验；无图存储与真实教师审核 |
| 3 | §3.2 多路检索 RAG/向量/重排（#7） | `aeh/curriculum_graph.py::ItemBank.search` / `plan_retrieval`；`dsh-plugin/src/core/curriculum-graph.ts::ItemBank.search` / `planRetrieval` | `tests/test_curriculum_graph.py::RetrievalTests::test_search_filters_by_kc_difficulty_and_type`、`::RetrievalTests::test_retrieval_plan_requires_gate_and_prerequisite_closure`；`dsh-plugin/tests/curriculum-graph.test.ts` → `retrieval filters by KC, difficulty and item type and returns summaries only` | 只有按 KC/难度/题型的确定性内存检索 + 课程门禁/先修闭包；无文档索引、BM25、向量、图扩展、交叉编码重排 |
| 4 | §6.4 约束式学生模拟器（#24） | `aeh/hypothesis.py::Hypothesis`；`aeh/exercise_evolution.py::SimulationSession`；`dsh-plugin/src/core/hypothesis.ts::Hypothesis`、`dsh-plugin/src/core/exercise-evolution.ts::SimulationSession` | `tests/test_exercise_evolution.py::TestSimulationIsolation::test_events_are_simulated_only_and_never_observed`；`dsh-plugin/tests/exercise-evolution.test.ts` → `simulation events are simulated-only and observedWrites stays zero` | 只有假设参数化的“对/错”伯努利采样 + 隔离沙箱（`observedWrites=0`）；无状态引擎、无步骤/答案生成、无验证器判定 |
| 5 | §8.2 多遗忘模型选型（#31） | 无对应实现；参考 `aeh/fsrs_calibration.py::calibrate`、`dsh-plugin/src/core/fsrs-calibration.ts::calibrate` | `tests/test_fsrs_calibration.py::ModelTests::test_retention_uses_illustrative_formula`（仅 FSRS） | 后端同样只有 FSRS 兼容模型；无 BKT/IRT/HLR/DKT/Leitner/SM-2 的实现或选型/对比 |
| 6 | §8.5 真实参数拟合与时间外验证（#35） | `aeh/fsrs_calibration.py::calibrate` / `_objective`（ridge-to-prior 收缩）/ `_bootstrap` / `evaluate_candidate` / `CalibrationActivationGate`；`dsh-plugin/src/core/fsrs-calibration.ts::calibrate` | `tests/test_fsrs_calibration.py::CalibrationReportTests::test_every_parameter_has_a_bootstrap_interval`、`::CalibrationReportTests::test_metrics_and_reliability_bins`；`dsh-plugin/tests/fsrs-calibration.test.ts` → `every parameter has a bounded bootstrap interval` | 有先验、合成数据参数估计、ridge 收缩、bootstrap 置信区间、合成 held-out 筛选与显式审批/激活/回滚；无真实观测、无时间外验证、无增量重估 |
| 7 | §9.5 校准增益与最坏情况后悔值（#45） | `aeh/exercise_evolution.py::SimulationSession` / `EvolutionSandbox` / `SimulationEventLog`；`aeh/evaluation.py::EvaluationProtocol`；`dsh-plugin/src/core/exercise-evolution.ts::EvolutionSandbox` | `tests/test_exercise_evolution.py::TestSandboxAndCandidatePool::test_sandbox_reports_separated_channels`；`tests/test_evaluation.py::ReportingTests::test_report_separates_simulated_benefit_and_real_transfer`；`dsh-plugin/tests/exercise-evolution.test.ts` → `sandbox reports separated channels and never promotes on simulation alone` | 有生成器隔离、模拟/真实分道、真实迁移证据才允许晋级；增益仍是合成估计，无真实数据校准、无最坏情况后悔值 |
| 8 | §11.4 开源项目代码复用（#54） | 无 | — | `aeh/`、`dsh-plugin/src` 均无 MiroFish/StudentSim 代码引用或移植；`references/` 保持只读 |
| 9 | §12.4 幂等/事务/Outbox（#60） | `aeh/services.py::WriteCoordinator` / `EventStore`（幂等键 + `expected_version` 乐观并发）、`aeh/evolution.py::AuditLog`；`dsh-plugin/src/core/services.ts::EventDraft` / `IdempotencyConflictError`、`dsh-plugin/src/host/audit-log.ts::AehAuditLog`、`dsh-plugin/src/tools.ts::AEH_TOOL_TIMEOUT_MS` | `tests/test_services_step16.py::EventStoreTests::test_idempotent_replay_returns_same_event`、`::EventStoreTests::test_optimistic_concurrency_conflict`、`tests/test_evolution.py::AuditTests::test_audit_is_append_only_and_ordered`；`dsh-plugin/tests/services-step16.test.ts` → `step16: idempotent replay returns same event`；`dsh-plugin/tests/step7.test.ts` → `the audit log is append-only and has the documented event kinds`；`dsh-plugin/tests/contract.test.ts` → `declared cooperative timeout is enforced by the dsh timeout policy` | 有幂等键、乐观并发、append-only 审计、TS 工具协作超时；无事务、无 Outbox、无消息系统、无跨服务回滚 |
| 10 | §13.1 核心实体与表（#61） | `aeh/services.py::LearningEvent` / `StudentProfile` / `ProfileBundle` / `ContentRecord` / `EvaluationService` / `HarnessStateMachine`；`dsh-plugin/src/core/services.ts` 同名类 | `tests/test_services_step16.py::EventStoreTests::test_append_assigns_sequence_and_version`、`::ProfileAndBundleTests::test_profile_create_and_duplicate`；`dsh-plugin/tests/services-step16.test.ts` → `step16: append assigns sequence and version`、`step16: profile create and update` | 有内存/JSON 文件实体与服务边界；无数据库 schema、迁移或真实表，规范中多数表未建 |
| 11 | §13.2 存储分层（#62） | `aeh/services.py::InMemoryEventStore` / `FileEventStore` 等文件变体；`dsh-plugin/src/core/services.ts::InMemoryEventStore` / `FileEventStore`、`dsh-plugin/src/host/file-event-store.ts` | `tests/test_services_step16.py::EventStoreTests::test_file_event_store_persists_and_reloads`；`dsh-plugin/tests/services-step16.test.ts` → `step16: file event store persists and reloads`；`dsh-plugin/tests/persistence.test.ts` → `file store is disabled by default and inert until enabled` | 只有单机内存/JSON 文件存储；无 PostgreSQL/pgvector/图库/对象存储/Redis/MQ |
| 12 | §17 非数学学科验证器与高风险安全过滤（#65） | `aeh/teaching_strategy.py::SubjectAdapter` / `MathSubjectAdapter` / `PhysicsSubjectAdapter` / `SubjectRegistry`；`dsh-plugin/src/core/teaching-strategy.ts::SubjectAdapter` / `PhysicsSubjectAdapter` | `tests/test_teaching_strategy.py::CrossSubjectTests::test_physics_adapter_and_safety_review`、`::CrossSubjectTests::test_evidence_validation`；`dsh-plugin/tests/teaching-strategy-step15.test.ts` → `step15: physics adapter carries unit checks and safety review`、`step15: subject evidence validation` | 只有物理学科的声明式验证器名称 + KC 前缀安全标志（`safety_required`）；无实际单位/量纲/受力验证计算、无高风险内容过滤；化学/编程/语言适配器未实现 |
| 13 | §19.4 真实随机对照与因果效果（#72） | `aeh/evaluation.py::EvaluationProtocol` / `RealTransferResult`（显式 `causal_claim_supported=False`）；`dsh-plugin/src/host/evolution.ts::RealTransferSummary.causalClaimSupported`、`dsh-plugin/src/core/fsrs-calibration.ts::CalibrationEvaluation` | `tests/test_evaluation.py::ReportingTests::test_real_transfer_is_computed_only_from_the_observed_channel`；`dsh-plugin/tests/evolution.test.ts` → `real transfer above threshold marks promotion ready`（断言 `causalClaimSupported=false`） | 只有描述性真实迁移统计并显式拒绝因果主张；无随机化、对照组、倾向得分/IPW/离线策略评估 |
| 14 | §21.4 开源许可法律合规评估（#80） | 无 | — | 只有题目注解里的 `license` 字符串必填校验（`aeh/curriculum_graph.py::ItemAnnotation`；`dsh-plugin/src/core/curriculum-graph.ts::ItemAnnotation`）；无许可策略/SPDX/AGPL 扫描或合规报告 |
| 15 | §19.2 时间外留出与稀疏分层（#70，部分已补） | `aeh/fsrs_calibration.py::CalibrationMetrics`（Brier/log loss/ECE/可靠性分箱）/ `evaluate_candidate`（独立合成 held-out）；`dsh-plugin/src/core/fsrs-calibration.ts::CalibrationMetrics` / `evaluateCandidate` | `tests/test_fsrs_calibration.py::CalibrationReportTests::test_metrics_and_reliability_bins`、`::EvaluationAndGateTests::test_simulated_and_real_channels_are_separate`；`dsh-plugin/tests/fsrs-calibration.test.ts` → `metrics include ten reliability bins covering every observation`、`held-out evidence without improvement is rejected` | 有 Brier/log loss/ECE/可靠性分箱与“独立合成 held-out”筛选；held-out **不是时间外留出**（无按时间切分），也**没有稀疏分层**（1–3/4–10/10+）评测。前端 §20.1 面板原“时间外 Brier”标签已据此改为“Brier（合成示意，非时间外）” |
| 16 | §20.2 成本控制算法（#75，部分已补） | `aeh/privacy.py::CostModel` / `CostEstimate` / `estimate_cost` / `CostEstimator`；`dsh-plugin/src/core/privacy.ts::CostModel` / `estimateCost` / `CostEstimator`；`cache_hit_rate` 指标（`MetricDefinition` / `METRIC_DEFINITIONS`） | `tests/test_privacy_step17.py::CostEstimationTests::test_estimate_matches_fixture_components_and_total`、`::CostEstimationTests::test_cost_is_never_connected_to_real_billing`；`dsh-plugin/tests/privacy-step17.test.ts` → `cost: estimate matches fixture components and total`、`cost: never connected to real billing` | 只有对显式合成价格簿的成本估算与预算检查（明确 `billing_connected=false`）及 `cache_hit_rate` 指标；无题型→工具路由、无 expected value of computation、无缓存实现——不是 §20.2 的控制成本算法 |

## 5. 第 2 轮复核修订记录

复核对象：第 1 轮完成的 `SPEC-CHECK.md` 中 14 项“演示范围外”与“已补（部分）”的边界；同步对象：
`docs/remaining-gaps.md` 第 3 节（权威）；渲染验证记录见 [`BUILD.md`](BUILD.md) §8。

1. **第 5 行（§3.1 关系类型全集）现状精确化**：原写“只有 `REQUIRES`/`CAN_FAIL_AS`”，未说明
   `EdgeType` 类型联合另声明了 `SUPPORTS`/`ASSESSES`。现改为“边实例只有 `REQUIRES`/`CAN_FAIL_AS`，
   `EdgeType` 另声明 `SUPPORTS`/`ASSESSES` 但无边实例”。
2. **第 24 行（§6.4）现状补全**：原写“无”，易被读成界面没有任何相关内容；现说明界面确实有
   “受 `bug_rules` 约束的 `Student Behavior Model` 合成说明”，但不含状态引擎/验证器。
3. **第 45 行（§9.5）现状修正**：原写“无”，但前端已有 `candidateInterventions`/`teachingValueWeights`
   的合成 U(a) 排序；真实校准增益与最坏情况后悔值仍无。同步修正 `src/data/synthetic.ts` 中
   `evolutionPipeline` 的 `rank` 文案：原“叠加不确定性惩罚与最坏情况后悔值”会让人以为后悔值已实现，
   现改为“按 U(a) 叠加不确定性/负荷/泄露惩罚排序；最坏情况后悔值与真实校准未计算（演示范围外）”。
4. **第 70 行（§19.2）“部分”边界改准**：原写“指标视图展示 Brier/Log loss/校准”，但这些数字实际属于
   §19.3 诊断假设保真度；§20.1 的遗忘模型维度另有合成字段。现明确区分 §19.3 与 §19.2，并保留
   “时间外留出与稀疏分层未做”。同步修正 `src/data/synthetic.ts` 中原指标名“时间外 Brier”为
   “Brier（合成示意，非时间外）”（状态由 `ok` 改为 `watch`），避免把未实现的评测方法说成已实现。
5. **与 `docs/remaining-gaps.md` 第 3 节对齐**：第 3 节 14 项补齐权威侧的「现状 / 外部条件」措辞——
   第 8 条加“MiroFish AGPL 等”，第 9 条加“事务存储”，第 10 条加“数据库与迁移”，第 12 条加
   “学科验证服务与专业监管”，第 13 条加“伦理/合规审批”，第 14 条加“法律合规审查”。保持不变：
   14 项事项与顺序与剩余缺口文档一一对应，未新增或删除范围外事项。
6. **新增 §4 后端能力交叉引用**：逐项列出 `aeh/` 与 `dsh-plugin/` 的对应实现、测试与边界，并明确
   “仅后端能力，不是前端功能”。后端**部分实现**的是第 1/2/3/4/6/7/9/10/12 条及 §19.2/§20.2；
   后端**也未实现**的是第 5/8/11/13/14 条（第 11/13 条列出最接近的实现并说明差距）。
7. **渲染验证**：`npm run build` 重建后以 `vite preview` + `curl` 复核 `/`、`/student`、`/teacher`、
   `/report`、`/metrics` 全部 200；`BUILD.md` §8 如实记录方法与局限（**仍无无头浏览器 DOM 渲染断言**，
   200 只证明服务可达）。
