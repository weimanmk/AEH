import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Badge,
  KeyValues,
  Meter,
  Notice,
  PageHeader,
  Section,
  Stat,
} from '../components/ui'
import { buildMetrics } from '../lib/metrics'
import { setConsent } from '../lib/store'
import { useStore } from '../store/useStore'
import { STORAGE_KEY, consentFor } from '../lib/model'
import { formatDateTime, percent } from '../lib/format'

export default function MetricsView() {
  const store = useStore()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  )
  const now = useMemo(() => new Date().toISOString(), [store])
  const metrics = useMemo(() => buildMetrics(store, now), [store, now])

  const excludedRefs = new Set(metrics.exclusions.map((entry) => entry.studentRef))

  return (
    <div>
      <PageHeader
        eyebrow="指标 · 全部由本地 store 实时计算"
        title="覆盖率、到期负担、回忆率与同意账本"
        lede="没有静态仪表盘数字：每个值都由 store 的 observed 进度/复习与真实 FSRS 参数在渲染时算出。"
        actions={
          <Link className="btn btn-secondary" to="/report">
            查看聚合报告
          </Link>
        }
      />

      {message ? (
        <Notice tone={message.ok ? 'success' : 'warning'} title={message.ok ? '已更新：' : '未更新：'}>
          {message.text}
        </Notice>
      ) : null}

      <div className="grid grid-4">
        <Stat
          label="知识点覆盖率"
          value={percent(metrics.kcCoverage, 1)}
          sub={`${metrics.kcCount} 个 KC 中已有 observed 记录`}
        />
        <Stat
          label="今日到期 / 逾期"
          value={`${metrics.dueCount} / ${metrics.overdueCount}`}
          sub={`纳入 ${metrics.studentsIncluded} 名学生`}
        />
        <Stat
          label="FSRS 回忆率估计"
          value={percent(metrics.fsrsRecallMean, 1)}
          sub="按当前时间与记忆状态预测"
        />
        <Stat
          label="日均复习负担"
          value={metrics.dailyReviewBurden.toFixed(2)}
          sub={`最近 14 天 ${metrics.reviewsLast14Days} 次`}
        />
      </div>

      <Section
        eyebrow="口径"
        title="这些数字是怎么算出来的"
        description="每个指标都注明分子/分母与数据来源；没有数据时显示“—”，不补零冒充有证据。"
      >
        <div className="grid grid-2">
          <div className="card">
            <h3>覆盖率</h3>
            <KeyValues
              items={[
                {
                  key: '知识点覆盖',
                  value: `${percent(metrics.kcCoverage, 1)} = 有 observed 进度或复习的 KC ÷ ${metrics.kcCount}`,
                },
                {
                  key: '题目覆盖',
                  value: `${percent(metrics.itemCoverage, 1)} = 必需 KC 全部存在的题目 ÷ ${metrics.itemCount}`,
                },
                {
                  key: '计算范围',
                  value: `仅纳入同意有效的 ${metrics.studentsIncluded} 名学生（撤销/缺失同意者排除）`,
                },
              ]}
            />
            <Meter
              value={metrics.kcCoverage}
              tone="navy"
              label={`KC 覆盖 ${percent(metrics.kcCoverage, 1)}（${metrics.studentsIncluded} 名学生）`}
            />
          </div>

          <div className="card">
            <h3>到期与排程</h3>
            <KeyValues
              items={[
                {
                  key: '今日到期',
                  value: `${metrics.dueCount} 个记忆单元（预计可提取性低于目标保持率 0.9）`,
                },
                {
                  key: '已逾期',
                  value: `${metrics.overdueCount} 个（到期时间早于当前时间）`,
                },
                {
                  key: '未来 7 天计划',
                  value: `${metrics.scheduledNext7Days} 个记忆单元将到期`,
                },
                {
                  key: '纳入学生的复习记录',
                  value: `${metrics.reviewCount} 条 observed_review（撤销同意者不计）`,
                },
              ]}
            />
          </div>

          <div className="card">
            <h3>FSRS 回忆率估计</h3>
            <p className="small muted">
              对每个有记忆状态的 KC，用真实 `MemoryParameters.predict(elapsed, S, D)`
              计算当前可提取性，再对有状态单元取均值。没有状态时显示“—”，
              不把“没复习”当成“已掌握”。
            </p>
            <Meter
              value={metrics.fsrsRecallMean ?? 0}
              tone="green"
              label={
                metrics.fsrsRecallMean === null
                  ? '暂无记忆状态'
                  : `平均预计可提取性 ${percent(metrics.fsrsRecallMean, 1)}`
              }
            />
          </div>

          <div className="card">
            <h3>负担</h3>
            <p className="small muted">
              日均复习量 = 最近 14 天 observed 复习次数 ÷ 14。它度量本机实际记录到的
              负担，不预测未来作业量，也不包含模型会话。
            </p>
            <KeyValues
              items={[
                {
                  key: '最近 14 天',
                  value: `${metrics.reviewsLast14Days} 次复习`,
                },
                { key: '日均', value: `${metrics.dailyReviewBurden.toFixed(2)} 次/天` },
                {
                  key: '已准备干预',
                  value: `${metrics.interventionsPrepared} 个（均未交付）`,
                },
              ]}
            />
          </div>
        </div>
      </Section>

      <Section
        eyebrow="同意账本 · 本地版 privacy.ts 思路"
        title="撤销同意后，聚合自动排除"
        description="同意状态按学生记录在 store；报告与指标在计算前检查，撤销或缺失都 fail-closed 排除。"
      >
        <Notice tone="warning" title="当前排除：">
          共 {metrics.exclusions.length} 名学生被排除（
          {metrics.exclusions.length === 0
            ? '无'
            : metrics.exclusions
                .map((entry) => `${entry.studentRef}：${entry.reason}`)
                .join('；')}
          ）。聚合报告会使用同一规则，不会把被排除学生的数据计入总数。
        </Notice>

        <div className="table-wrap" style={{ marginTop: 'var(--space-lg)' }}>
          <table>
            <thead>
              <tr>
                <th>学生代号</th>
                <th>年级</th>
                <th>同意状态</th>
                <th>更新时间</th>
                <th>备注</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {store.students.length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted">
                    还没有学生。新增学生时默认记录本地聚合报告同意，可随时撤销。
                  </td>
                </tr>
              ) : null}
              {store.students.map((student) => {
                const consent = consentFor(store, student.ref)
                const granted = consent?.granted === true
                return (
                  <tr key={student.ref}>
                    <td>
                      <span className="mono">{student.ref}</span>
                      {student.synthetic ? (
                        <div>
                          <Badge tone="warning">合成数据示例</Badge>
                        </div>
                      ) : null}
                    </td>
                    <td>{student.grade}</td>
                    <td>
                      {consent === undefined ? (
                        <Badge tone="error">未记录（排除）</Badge>
                      ) : granted ? (
                        <Badge tone="success">已授予</Badge>
                      ) : (
                        <Badge tone="error">已撤销（排除）</Badge>
                      )}
                      {excludedRefs.has(student.ref) ? (
                        <div className="tiny muted">当前被聚合排除</div>
                      ) : null}
                    </td>
                    <td className="small nowrap">
                      {formatDateTime(consent?.updatedAt)}
                    </td>
                    <td className="small">{consent?.note ?? '—'}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          const result = setConsent(
                            student.ref,
                            !granted,
                            granted
                              ? '教师在本机撤销聚合报告同意；报告将自动排除该生'
                              : '教师在本机恢复聚合报告同意',
                          )
                          setMessage({
                            ok: result.ok,
                            text: result.ok
                              ? granted
                                ? `已撤销 ${student.ref} 的同意；聚合报告与指标将自动排除该生。`
                                : `已恢复 ${student.ref} 的同意；该生可重新进入聚合。`
                              : (result.error ?? '更新同意失败'),
                          })
                        }}
                      >
                        {granted ? '撤销同意' : '授予同意'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {metrics.exclusions.length > 0 ? (
          <div className="callout" style={{ marginTop: 'var(--space-md)' }}>
            <strong>排除名单：</strong>
            {metrics.exclusions.map((entry) => (
              <div key={entry.studentRef}>
                <span className="mono tiny">{entry.studentRef}</span> · {entry.grade}{' '}
                年级 · {entry.reason}
              </div>
            ))}
            <div style={{ marginTop: 8 }}>
              这不是删除数据：学生的进度与复习仍在本地；只是不再进入聚合。
              如需彻底删除，请在学生视图删除该学生。
            </div>
          </div>
        ) : null}
      </Section>

      <Section
        eyebrow="本地隐私边界"
        title="数据不出浏览器"
        description="前端运行期零网络调用；存储与导出都由你手动控制。"
      >
        <div className="grid grid-2">
          <div className="card">
            <h3>会</h3>
            <ul className="muted small">
              <li>
                只写浏览器 localStorage 键 <span className="mono">{STORAGE_KEY}</span>
              </li>
              <li>学生只用本地代号 + 年级</li>
              <li>掌握度写入只接受 observed_* 观察</li>
              <li>导出/导入由你手动选择 JSON 文件</li>
              <li>撤销同意后自动从聚合报告与指标排除</li>
            </ul>
          </div>
          <div className="card">
            <h3>不会</h3>
            <ul className="muted small">
              <li>不发起任何网络请求（无 HTTP API、无实时连接），运行期零网络</li>
              <li>不收集真实姓名、账号、照片或设备指纹</li>
              <li>不把 simulated_* 写入真实掌握度</li>
              <li>不运行或记录模型会话（模型会话仍在 dsh 插件侧）</li>
              <li>不自动上传、同步或备份到任何服务器</li>
            </ul>
          </div>
        </div>
        <div className="chip-row" style={{ marginTop: 'var(--space-md)' }}>
          <Badge tone="success">零网络</Badge>
          <Badge tone="neutral">本地存储</Badge>
          <Badge tone="neutral">observed only</Badge>
          <Badge tone="warning">合成数据可删除</Badge>
        </div>
        <p className="tiny muted" style={{ marginTop: 'var(--space-md)', marginBottom: 0 }}>
          提示：浏览器隐私模式或清除站点数据会一起清除本工具数据。重要数据请先在首页导出 JSON；
          导入格式错误时不会覆盖现有数据。
        </p>
      </Section>
    </div>
  )
}
