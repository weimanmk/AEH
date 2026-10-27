# AEH 独立冻结评测报告模板

> 使用方式：复制本模板，用一次 `aeh.evaluation.EvaluationProtocol.run(...)` 的
> 结果填充 `{{...}}` 占位符，或直接运行 `python3 -m aeh.eval_cli` 生成填好的示例。
> **模拟收益与真实迁移必须分节报告**；没有真实迁移观测时写“未提供”，不得用模拟
> 数据替代。本模板对应规范 §19。

## 0. 元信息

| 字段 | 值 |
|---|---|
| 数据集 ID | `{{dataset_id}}` |
| 数据集版本 | `{{dataset_version}}` |
| 冻结摘要（SHA-256） | `{{dataset_digest}}` |
| 冻结时间（UTC） | `{{frozen_at}}` |
| 报告生成时间（UTC） | `{{generated_at}}` |
| 数据来源 | 仅合成 fixture（`synthetic_fixtures_only=true`） |
| 评测代码版本 | `{{evaluation_code_version}}` |

### 0.1 冻结集分片隔离核对

- [ ] `train` / `explanation` / `transfer` 三片 item id 互不重叠
- [ ] `transfer` 片全部 `seen_before=false`（unseen）
- [ ] 冻结后未修改任何 item（摘要与上次报告一致或已显式升版本）
- [ ] 训练题、讲解资源、迁移题在数据流上物理隔离

分片计数：train `{{train_count}}` / explanation `{{explanation_count}}` /
transfer `{{transfer_count}}`。

## 1. 模拟收益（L3，**非因果证据**）

| 指标 | 值 |
|---|---|
| 评测分片 | `{{simulated_split}}` |
| 题数 | `{{simulated_item_count}}` |
| 模拟平均预测正确率 | `{{simulated_mean}}` |
| 参考基线 | `{{reference_accuracy}}` |
| 模拟收益 | `{{simulated_gain}}` |
| 是否因果证据 | **否** |

> 说明：本节只用于候选策略的离线筛选。模拟收益 **不能** 作为真实学习效果
> 的证据，也不能通过与第 2 节拼接来推断因果关系。

## 2. 真实迁移（L4，独立观测）

| 指标 | 值 |
|---|---|
| 未见迁移题数 | `{{real_item_count}}` |
| 独立正确数 | `{{real_correct}}` |
| 迁移正确率 | `{{transfer_accuracy}}` |
| 参考基线 | `{{reference_accuracy}}` |
| 观测差值（描述性） | `{{observed_delta}}` |
| 观测来源 | `{{real_sources}}` |
| 全部 unseen | `{{all_items_unseen}}` |
| 是否支持因果结论 | `{{causal_claim_supported}}`（无对照组） |

如果本项为“未提供真实迁移观测”：

- 必须写：`{{no_real_transfer_reason}}`
- 禁止写：任何基于第 1 节模拟数据的“真实提升”结论。

## 3. 防自证约束（逐条确认）

- [ ] 模拟结果只进入第 1 节，未参与第 2 节任何计算
- [ ] 第 2 节只使用可信来源（`student` / `teacher` / `trusted_grader` /
      `assessment`）的独立作答
- [ ] 迁移题未出现在训练/讲解分片
- [ ] 没有把 `simulated_*` 事件重新标记为真实证据
- [ ] 若真实迁移缺失，报告显式声明“无真实证据”，未用模拟数据填充

## 4. 已知限制

- 合成数据，样本量小，未随机化，无对照组；
- 参考基线是预注册常数，不是实测对照条件；
- 模拟预测可能过乐观，且依赖虚拟学生保真度；
- 本模板不覆盖长期延迟保持、跨知识迁移与不良效果（过度提示、挫败感）的完整测量。

## 5. 结论

`{{claim}}`

> 规范 §19：L4 是最高标准。L2/L3 分数即使很好，若真实学习效果没有提升，也不能
> 称为优秀的学习 Harness。模拟收益与真实迁移必须分开报告。
