# AEH — Adaptive Cognitive Twin Education Harness

AEH 是一个**规范驱动**的自适应教育 Harness 核心骨架。本仓库对应
[`TASKS.md`](TASKS.md) 的 **Step 1**：只使用 Python 标准库实现可测试的核心机制，
并为后续的 dsh / Cordis 教育插件提供领域边界。

当前状态：**Step 1 核心骨架，不是生产系统**。所有模块无第三方依赖，CI 不需要
`pip install`。

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

## 这不是什么

- 不是完整的教学系统、App 或生产服务；没有数据库、鉴权、多租户隔离、真实 LLM、
  插件运行时或真实学生数据接入。
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

另外，`tests/test_invariants.py` 用端到端断言直接命名并覆盖了 TASKS.md 要求的四条
Step 1 不变量。

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
tests/                 # 标准库 unittest 测试
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

只跑某个测试文件：

```bash
python3 -m unittest discover -s tests -p 'test_twin.py' -v
```

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) 在 push 和 pull request 时用
Python 3.11 与 3.12 矩阵运行：

```bash
python -m unittest discover -s tests -v
```

没有 `pip install` 步骤，也没有外部服务或密钥依赖。

## 与 dsh / Cordis 的映射方向（Step 3）

Step 1 不实现完整插件。后续映射方向如下：

| AEH 核心 | dsh / Cordis 中的位置 |
|---|---|
| `curriculum_gate` | 工具调用/内容交付前的策略检查；插件不能绕过，默认拒绝 |
| `twin` | Profile / Bundle 中的事件存储与推断状态；`observed` 与 `simulated` 分命名空间 |
| `memory` | 复习调度 Service，向调度器提供保持率与下次间隔 |
| `hypothesis` | 会话级临时状态；不写入长期真实证据 |
| `diagnosis` | 工具选择策略；按信息增益排序并允许学生跳过 |
| `exercise` | 干预生成流水线；生成器、校验器、评测器分权 |

插件默认最小权限：无学生原始数据、无数据库写权限、无凭据、无任意文件或网络访问；
只接收已授权的汇总事件。课程/安全门禁属于 Harness 侧不可绕过的约束。

## 参考来源与许可证注意事项

`references/` 是本地只读参考目录，**已被 `.gitignore` 忽略，不进入版本库**：

- `references/deepseek-harness/`：DeepSeek Harness / dsh / Cordis 基座，MIT。仅用于
  集成方向参考，本仓库未复制其代码。
- `references/MiroFish/`：多 Agent 仿真、GraphRAG、动态记忆的借鉴来源，AGPL-3.0。
  本项目只借鉴机制，不复制整套代码；若未来引入其代码，必须重新评估 AGPL 义务。
- `references/StudentSim/`：虚拟学生行为保真与教学提示响应的借鉴来源；其许可证与
  数据权利需分别核验。本仓库未复制其代码或数据。
- `references/awesome-fsrs/`：FSRS 算法说明与版本参考。本项目使用的是规范 §8.3 的
  示意公式，不绑定任何 FSRS 版本。

规范全文位于 `spec/`，只读；本仓库不修改 `spec/` 与 `references/`。生产实现若采用
特定 FSRS 版本，应按该版本优化器与参数重新校准，而不是把示意公式直接当作生产参数。

## 已知边界 / TODO

Step 1 有意不做以下内容，后续步骤再实现：

- 持久化存储、租户/学生访问边界、数据删除向派生存储的传播、鉴权与审计日志。
- 真实 LLM 生成、真实评分器、数学正确性求解器与内容安全服务；当前只校验显式标注。
- 插件安装/卸载、权限声明、沙箱与凭据撤销。
- 自进化的候选—隔离评测—批准—灰度—回滚流水线。
- 真实学生迁移与延迟保持的校准；当前记忆参数为示意值，小样本仍保留高不确定性。

## 安全约定

- 不提交密钥、令牌、`.env` 或真实学生数据；相关文件已被 `.gitignore` 覆盖。
- 所有真实证据必须来自 `student` / `teacher` / `trusted_grader` / `assessment` 等
  可信来源；模拟来源只能进入隔离的 simulated 存储。
- 任何 mastery 更新必须引用已存在的真实证据 id；模拟事件不能被提升为真实证据。
