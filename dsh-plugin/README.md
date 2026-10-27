# AEH dsh / Cordis 教育插件

这是 [`docs/dsh-integration.md`](../docs/dsh-integration.md) 对应的 TypeScript 插件。
它把 Step 1 的 Python 核心映射为 Cordis 函数插件和五个教育工具，默认最小权限，
不接入真实学生数据。

Step 4 已把离线适配层替换为真实的 `@deepseek-ai/cordis` 与
`@deepseek-ai/dsh-tools`，并在一个**独立隔离**的 Cordis/dsh 实例中完成
加载、schema 校验、取消、超时与卸载测试。它仍**未**接入真实学生数据，也**未**
加载进任何正在运行的 dsh 会话。

## 安装与验证

要求 Node **>= 24**。依赖只安装在本目录（使用本目录 `.npm-cache`），不会触碰
`~/.dsh/`、`~/workspace/deepseek-harness` 或 npx 安装的 dsh：

```bash
npm install --cache .npm-cache
npm run typecheck          # tsc --noEmit
npm test                   # node --test tests/*.test.ts（31 个）
npm run evidence:loader    # 隔离 loader 加载/卸载证据
```

## 工具

| 工具 | 作用 |
|---|---|
| `aeh_check_curriculum` | fail-closed 课程门禁检查 |
| `aeh_update_hypotheses` | 会话级假设 spawn/split/merge/prune/reweight |
| `aeh_select_probe` | 重新过门禁后的诊断题选择，支持学生跳过 |
| `aeh_schedule_review` | FSRS 风格复习调度计算 |
| `aeh_prepare_intervention` | 干预包校验与准备（不交付） |

没有孪生写工具、交付工具或门禁覆盖工具。门禁/诊断/干预工具只接收 opaque
`itemId` / `studentRef`；`HostContext` 由宿主适配器注入，默认 resolve-nothing，所以
未接宿主前这些工具会 fail closed，模型无法伪造进度或安全标注。

## 宿主适配器（内存/合成）

`src/host/` 提供 Step 4 的内存适配器，仅供测试与装配参考：

- `MemoryHostContext`：绑定单一 session/租户/学生；`toHostBinding()` 给只保留
  数据属性的 config 传输使用。
- `MemoryHostTwin`：来源认证接缝、`eventId` 幂等、版本/回滚、追加式审计、
  observed/simulated 隔离。
- `ApprovalLedger` / `HostDeliveryAdapter`：宿主审批与交付门，工具只准备不交付。

它们都**不是**生产鉴权、KMS、持久化或交付实现。

## 测试分层

- `tests/invariants.test.ts`：13 个离线不变量测试。
- `tests/host-adapters.test.ts`：12 个宿主适配器测试。
- `tests/contract.test.ts`：6 个真实 Cordis/dsh 运行时契约测试。

契约测试与 `scripts/loader-evidence.mjs` 都只使用合成引用（如
`synthetic.student.001`），不读文件、不连网、不写数据库。
