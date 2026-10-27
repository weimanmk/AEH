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

### Step 5（下一轮，不在本轮做）

- 报告插件：只接收已授权聚合事件的 dsh 工具，复用 Step 2 `report.py` 的边界；持久化与删除传播的最小模型（事件存储、保留期、同意撤回），仍用合成数据。
- 评测体系（规范 §19）：独立冻结评测集、模拟收益与真实迁移分离的评测脚本，不自证。

### Step 6（下一轮，不在本轮做）

- 受控自进化流水线骨架（规范 §27）：候选—隔离评测—批准—灰度—回滚，候选不能降低门禁，不能自行改写生产系统；仍为骨架与文档，不接真实生产。

## 工作方式

- 只在本目录内创建/修改文件。
- **改造的 dsh 与运行代码的 dsh 必须分开**：AEH 的插件工作只在本目录（`dsh-plugin/`、`docs/`）内进行，参考资料只读；绝对禁止修改运行用 harness —— `~/.dsh/` 的配置与存储、`~/workspace/deepseek-harness` 源码克隆、npx 安装的 dsh；绝对禁止把 AEH 插件加载进正在执行本任务的 harness 会话。Step 4 的 loader/契约测试必须用独立的、隔离的 Cordis/dsh 测试实例（独立配置与工作目录、独立 npm 安装），不得复用 headless 运行配置。
- 每一步完成后用一句话总结改了什么、测试结果是什么。
- 如果某项规范在本轮无法用标准库安全实现，写成 `TODO` 并说明原因，不要假装已实现。
