# Step 18 — 真实会话端到端验收（隔离实例）

本目录只服务 `TASKS.md` 的 Step 18：在**独立隔离**的 dsh 实例中加载 AEH 插件，用
Sidrune 的 `deepseek-v4-1-flash` 跑一次合成会话（门禁 → 诊断 → 复习 → 报告），并把
命令、事件流、会话日志与摘要完整留在 `step18/evidence/`。全部数据为合成数据，没有
真实学生数据，也没有把 AEH 插件加载进正在执行任务的 harness 会话。

## 1. 隔离边界

| 维度 | 本步骤使用 | 明确未使用 / 未修改 |
|---|---|---|
| dsh 安装 | `step18/runtime/node_modules`（`@deepseek-ai/dsh@0.2.1-rc.3`，独立 `npm install`，独立 `step18/.npm-cache`） | npx 安装的 `~/.npm/_npx/.../dsh` |
| `$DSH_HOME` | `step18/home`（独立 profile、sessions、storages） | 运行中的 `~/.dsh/` 配置与存储 |
| profile | `step18/home/profiles/aeh-e2e`（`dsh-base` + `dsh-headless` 组合后打补丁） | headless 运行配置 |
| 工作目录 | `step18/work` | 仓库根或 harness 源码目录 |
| 插件入口 | `dsh-plugin/e2e/aeh-e2e-entry.ts`（只被本隔离实例加载） | 正在执行本任务的 harness 会话 |
| 源码克隆 | 只读引用，未改 | `~/workspace/deepseek-harness` |

运行中的 harness（`run_headless.py` → npx dsh）在本步骤期间未被重启、未被修改配置、
未被写入存储，也没有加载 AEH 插件。

## 2. 为什么需要 `dsh-plugin/e2e/aeh-e2e-entry.ts`

插件入口 `src/index.ts` 的 `apply(ctx, config)` 接受一个**宿主注入**的 `host`
（`HostContext` 绑定）。这是有意的信任边界：`host` 不是 YAML 可序列化字段，插件
默认“解析不到宿主就全部 fail-closed”。因此隔离实例不能只写一行 `insert` 就得到
可用的门禁/诊断/复习/报告；需要一个很薄的入口把**合成的** `MemoryHostContext`
绑定进去：

- 固定合成学生 `synthetic.student.step18`；
- 只授予 `curriculum:read`；
- 固定合成进度与 5 道合成题（含一道需要未教 KC、应被门禁拒绝的题）；
- 复用真实 `src/index.ts` 的 `name` / `inject` / `Config` / `apply`，不新增工具、
  不新增权限、不写长期孪生、不访问网络或文件系统。

## 3. 合成会话（六个工具，四段）

| 阶段 | 工具 | 合成输入要点 |
|---|---|---|
| 门禁 | `aeh_check_curriculum` | `item.fraction.add.001`（应允许） |
| 门禁 | `aeh_check_curriculum` | `item.fraction.multiply.001`（未教 KC，应拒绝） |
| 诊断 | `aeh_update_hypotheses` | `spawn` 一个 `hyp.adds_ok` 假设 |
| 诊断 | `aeh_select_probe` | 两个候选，按显式权重选探针 |
| 复习 | `aeh_schedule_review` | `difficulty=5`、`stabilityDays=2`、目标保持 0.9 |
| 报告 | `aeh_generate_report` | 教师受众，1 条授权聚合事件 |

任务文本完整保存在证据目录的 `task.md`；`run-e2e.py` 内置同一份默认任务。

## 4. 已验证结果（run `20261027T110556Z`）

- 退出码 **0**，JSON 事件 **39**，工具调用/结果 **6/6**，错误事件 **0**。
- 门禁：`item.fraction.add.001` → `allowed: true`；
  `item.fraction.multiply.001` → `allowed: false`，原因
  `kcs_not_allowed:kc.fraction.multiply`（fail-closed）。
- 诊断：生成 1 个假设（`snapshotRef: hyp_1`）；选中
  `item.fraction.equiv.001`（score ≈ -0.2953）。
- 复习：`nextIntervalDays: 3.2`，`stabilityDays: 3.2`，
  `difficultyState: 4.8`，目标保持 0.9。
- 报告：attempts 4、independent correct 3、hints requested 1、minutes 10、
  independent accuracy 0.75；使用 1 条授权聚合事件，排除 0 条，不输出原始数据或
  事件引用。

## 5. 复现

前置：Node >= 24；本机已注册 `custom.sidrune` connector（用于取 `hsurr:` 代理
凭证；凭证只进入子进程环境，不落盘、不打印）。首次需要先安装独立运行时：

```bash
cd /path/to/AEH
mkdir -p step18/runtime
printf '%s\n' '{"name":"aeh-step18-isolated-dsh-runtime","private":true,"dependencies":{"@deepseek-ai/dsh":"0.2.1-rc.3"}}' > step18/runtime/package.json
npm install --prefix "$PWD/step18/runtime" --cache "$PWD/step18/.npm-cache" --no-audit --no-fund
```

然后：

```bash
python3 step18/run-e2e.py --dry-run   # 只组合 profile 并打印 --dump-config
python3 step18/run-e2e.py             # 真实跑一次，写入新的 evidence/<UTC 时间戳>/
```

脚本会：

1. 生成 `step18/home/profiles/aeh-e2e/{package.json,cordis.patch.yml}`（补丁里
   的 `llm-pi-ai` 指向 `sidrune`，默认模型 `deepseek-v4-1-flash`；禁用 shell/文件/
   网络/子代理等与本验收无关的工具；`insert` AEH host 入口）；
2. 从 `custom.sidrune` 取代理凭证，仅设置到子进程的 `SIDRUNE_API_KEY`；
3. 以 `DSH_HOME=step18/home`、`cwd=step18/work`、`DSH_PERMISSION_MODE=read-only`
   运行本地 `dsh --profile aeh-e2e --json "<task>"`；
4. 对输出做 `hsurr:` / `sk-` 脱敏，写 `command.txt`、`stdout.jsonl`、`stderr.log`、
   `exit-code.txt`、`task.md`、`summary.json`、`summary.md`、`metadata.json`、
   `dump-config.txt`、profile 副本，并把隔离会话的 zstd 日志解压成可读 JSONL。

`--task-file` 可替换合成任务，`--run-id` 可指定证据目录名。每次真实运行前只清理
`step18/home/{sessions,storages}`，不触碰 `~/.dsh`。

## 6. 证据目录

以 `step18/evidence/20261027T110556Z/` 为例：

| 文件 | 内容 |
|---|---|
| `summary.md` | 人读摘要：隔离、工具链、六次调用、最终回答 |
| `summary.json` | 机器可读摘要（调用、结果、最终回答、错误） |
| `stdout.jsonl` | `dsh --json` 的逐行事件流（含完整工具入参/结果） |
| `stderr.log` | 诊断输出（成功时为空） |
| `command.txt` | 精确命令、cwd、环境变量（凭证已脱敏） |
| `task.md` | 合成任务全文 |
| `profile.cordis.patch.yml` / `profile.package.json` | 实际使用的隔离 profile |
| `dump-config.txt` | `--dump-config` 组合结果，证明 AEH 行已插入 |
| `metadata.json` | Node/dsh/bundle 版本与入口、补丁的 sha256 |
| `session-log/` | 隔离 `$DSH_HOME` 下的会话日志（zstd 解压后的 JSONL） |

## 7. 未声称 / 未完成

- 只验证了**一个合成会话**与**一个模型**（Sidrune `deepseek-v4-1-flash`），
  不是生产流量、不是多租户、不是真实学生数据。
- 宿主绑定仍是代码级入口（`aeh-e2e-entry.ts`），不是可序列化的生产配置；生产接入
  需要把 `HostContext` 解析器作为真正的宿主插件提供。
- 凭证路径依赖本机已注册的 `custom.sidrune` connector；换机器需要重新注册，否则
  本步骤无法取得模型访问。
- 没有验证真实 dsh 的多进程/多副本、崩溃恢复、配额/计费、审批后台或 LMS 交付。
- 没有修改 CI、没有 push、没有运行 GitHub Actions。
