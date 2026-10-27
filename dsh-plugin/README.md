# AEH dsh / Cordis 教育插件骨架

这是 [`docs/dsh-integration.md`](../docs/dsh-integration.md) 对应的 TypeScript 插件
骨架。它把 Step 1 的 Python 核心映射为 Cordis 函数插件和五个教育工具，默认最小
权限，不接入真实学生数据。

**当前不能在真实 dsh 运行时直接使用。** `src/dsh.ts` 是离线结构适配层；接入前要
替换为 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-tools`，并完成文档中的 P0 清单。

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

## 测试

要求 Node >= 24：

```bash
node --test tests/*.test.ts
```

可选类型检查：

```bash
npm install
npm run typecheck
```

测试通过一个内存 `HostContext` 提供合成引用（例如 `synthetic.student.001`），
不读文件、不连网、不写数据库。
