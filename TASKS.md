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

### Step 3（下一轮，不在本轮做）

- dsh Cordis 插件骨架（TypeScript），把 Step 1 的核心映射为教育插件与工具，见 `docs/dsh-integration.md`（Step 1 不必写完整插件，只需在 README 中说明映射方向）。

## 工作方式

- 只在本目录内创建/修改文件。
- 每一步完成后用一句话总结改了什么、测试结果是什么。
- 如果某项规范在本轮无法用标准库安全实现，写成 `TODO` 并说明原因，不要假装已实现。
