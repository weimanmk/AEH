import { useMemo, useState } from 'react'
import {
  Badge,
  KeyValues,
  Notice,
  PageHeader,
  Section,
  Stat,
  Tag,
} from '../components/ui'
import {
  buildAggregateReport,
  reportBundleToJson,
} from '../lib/reporting'
import { useStore } from '../store/useStore'
import { downloadJson } from '../lib/download'
import { formatDate, formatDateTime, percent } from '../lib/format'
import type { AggregateMetrics } from '../lib/core'

function accuracy(metrics: AggregateMetrics): number | null {
  return metrics.attempts === 0 ? null : metrics.independentCorrect / metrics.attempts
}

function metricCells(metrics: AggregateMetrics) {
  return (
    <>
      <td className="num">{metrics.attempts}</td>
      <td className="num">{metrics.independentCorrect}</td>
      <td className="num">{metrics.hintedCorrect}</td>
      <td className="num">{metrics.hintsRequested}</td>
      <td className="num">{percent(accuracy(metrics), 1)}</td>
      <td className="num">{metrics.minutes}</td>
    </>
  )
}

export default function ReportView() {
  const store = useStore()
  const [message, setMessage] = useState<string | null>(null)
  const now = useMemo(() => new Date().toISOString(), [store])
  const report = useMemo(() => buildAggregateReport(store, now), [store, now])

  const syntheticRefs = new Set(
    store.students.filter((student) => student.synthetic).map((student) => student.ref),
  )
  const syntheticIncluded = report.included.filter((entry) =>
    syntheticRefs.has(entry.studentRef),
  )
  const localIncluded = report.included.filter(
    (entry) => !syntheticRefs.has(entry.studentRef),
  )

  const gradeCounts = new Map<number, number>()
  for (const entry of report.included) {
    gradeCounts.set(entry.grade, (gradeCounts.get(entry.grade) ?? 0) + 1)
  }
  const grades = [...gradeCounts.entries()].sort((a, b) => a[0] - b[0])
  const scopes = report.included[0]?.report.authorizedScopes ?? []

  return (
    <div>
      <PageHeader
        eyebrow="报告 · report.ts 聚合边界"
        title="仅聚合的教师报告"
        lede="报告只接收 aggregateRef 级别的计数，不包含题目、答案、步骤或原始作答；撤销同意的学生会被边界自动排除。"
        actions={
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              downloadJson(
                `aeh-report-${now.slice(0, 10)}.json`,
                reportBundleToJson(report),
              )
              setMessage('已导出聚合报告 JSON（不含原始作答与事件 ID）。')
            }}
          >
            导出聚合报告 JSON
          </button>
        }
      />

      {message ? (
        <Notice tone="success" title="完成：">
          {message}
        </Notice>
      ) : null}

      <Notice tone="warning" title="模拟 / 真实严格分开：">
        本工具只做了本地 observed 聚合，<strong>没有</strong> L4（真实迁移/因果效果）
        证据，也不会把本地练习或合成示例当作真实迁移。下表分别标注“模拟（合成数据示例）
        ”与“真实（本地 observed 录入）”；两类都不展示原始作答。
      </Notice>

      <div className="grid grid-4" style={{ marginTop: 'var(--space-lg)' }}>
        <Stat
          label="纳入报告的学生"
          value={report.included.length}
          sub={`共 ${store.students.length} 人 · 排除 ${report.excluded.length} 人`}
        />
        <Stat
          label="聚合尝试"
          value={report.totals.attempts}
          sub={`独立正确 ${report.totals.independentCorrect} 次`}
        />
        <Stat
          label="独立正确率"
          value={percent(accuracy(report.totals), 1)}
          sub="按所有纳入学生的聚合计数"
        />
        <Stat
          label="聚合知识点"
          value={report.topics.length}
          sub={`窗口 ${formatDate(report.windowStart)} → ${formatDate(report.windowEnd)}`}
        />
      </div>

      <Section
        eyebrow="L3 模拟 vs. 本地 observed"
        title="数据来源分离"
        description="合成示例只用于演示报告边界；本地 observed 只代表本机录入的观察，不是外部测评或真实迁移证据。"
      >
        <div className="grid grid-3">
          <div className="card">
            <div className="spread">
              <h3 style={{ marginBottom: 0 }}>模拟（L3）</h3>
              <Badge tone={syntheticIncluded.length > 0 ? 'warning' : 'neutral'}>
                {syntheticIncluded.length} 名学生
              </Badge>
            </div>
            <p className="small muted">
              预置合成数据示例。它们不是真实学生，也不得作为教学效果证据。
            </p>
            {syntheticIncluded.length === 0 ? (
              <p className="tiny muted" style={{ marginBottom: 0 }}>
                当前没有合成学生进入报告。
              </p>
            ) : (
              <ul className="small" style={{ marginBottom: 0 }}>
                {syntheticIncluded.map((entry) => (
                  <li key={entry.studentRef}>
                    <span className="mono tiny">{entry.studentRef}</span> ·{' '}
                    {entry.grade} 年级 · {entry.reviewCount} 条聚合事件
                    <Badge tone="warning">模拟</Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card">
            <div className="spread">
              <h3 style={{ marginBottom: 0 }}>真实（本地 observed）</h3>
              <Badge tone={localIncluded.length > 0 ? 'success' : 'neutral'}>
                {localIncluded.length} 名学生
              </Badge>
            </div>
            <p className="small muted">
              本机录入的代号、进度与复习观察。只代表教师/学生在本机的记录，
              不等于外部效标。
            </p>
            {localIncluded.length === 0 ? (
              <p className="tiny muted" style={{ marginBottom: 0 }}>
                当前没有本地录入的学生进入报告。
              </p>
            ) : (
              <ul className="small" style={{ marginBottom: 0 }}>
                {localIncluded.map((entry) => (
                  <li key={entry.studentRef}>
                    <span className="mono tiny">{entry.studentRef}</span> ·{' '}
                    {entry.grade} 年级 · {entry.reviewCount} 条聚合事件
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card card-quiet">
            <div className="spread">
              <h3 style={{ marginBottom: 0 }}>L4 真实迁移</h3>
              <Badge tone="neutral">未提供</Badge>
            </div>
            <p className="small muted">
              真实迁移/因果效果需要独立的前测—干预—后测与对照设计，本前端不采集、
              不推断，也不把模拟收益写成真实迁移。
            </p>
            <KeyValues
              items={[
                { key: '真实迁移证据', value: '无（超出本工具范围）' },
                { key: '模拟收益替代', value: '不允许' },
                { key: '原始作答', value: '不进入报告' },
              ]}
            />
          </div>
        </div>
      </Section>

      <Section
        eyebrow="人数与分布"
        title="纳入学生的年级分布"
        description="只显示聚合人数；不显示姓名、账号或任何直接标识。"
      >
        {grades.length === 0 ? (
          <p className="small muted">当前没有可纳入报告的学生。</p>
        ) : (
          <div className="grid grid-4">
            {grades.map(([grade, count]) => (
              <Stat
                key={grade}
                label={`${grade} 年级`}
                value={count}
                sub={`占纳入学生 ${percent(count / report.included.length, 1)}`}
              />
            ))}
          </div>
        )}
      </Section>

      <Section
        eyebrow="各 KC 聚合 · report.ts"
        title="知识点的聚合计数"
        description="全部字段都是计数；没有单题文本、答案、步骤或原始事件 ID。"
      >
        {report.topics.length === 0 ? (
          <p className="small muted">
            还没有聚合事件。学生完成复习后，这里会出现按 KC 的计数。
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>知识点</th>
                  <th className="num">尝试</th>
                  <th className="num">独立正确</th>
                  <th className="num">提示后正确</th>
                  <th className="num">请求提示</th>
                  <th className="num">独立正确率</th>
                  <th className="num">分钟</th>
                  <th>关注原因</th>
                </tr>
              </thead>
              <tbody>
                {report.topics.map((topic) => (
                  <tr key={topic.kcId}>
                    <td>
                      {store.kcs.find((kc) => kc.id === topic.kcId)?.label ??
                        topic.kcId}
                      <div className="mono tiny muted">{topic.kcId}</div>
                    </td>
                    {metricCells(topic)}
                    <td className="small">
                      {topic.attentionReasons.length === 0
                        ? '—'
                        : topic.attentionReasons.join('、')}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>合计</th>
                  {metricCells(report.totals)}
                  <th />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <p className="tiny muted" style={{ marginTop: 'var(--space-sm)' }}>
          报告边界：audience=teacher；授权范围{' '}
          {scopes.length === 0 ? '（无纳入学生）' : scopes.join('、')}。
          窗口 {formatDateTime(report.windowStart)} → {formatDateTime(report.windowEnd)}。
        </p>
      </Section>

      <Section
        eyebrow="同意账本 · fail-closed"
        title="被排除的学生"
        description="未记录同意或同意已撤销的学生不会进入任何聚合；排除原因在界面明示。"
      >
        {report.excluded.length === 0 ? (
          <Notice tone="success">
            当前所有学生都有有效的本地聚合报告同意，没有被排除者。
          </Notice>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>学生代号</th>
                  <th>年级</th>
                  <th>排除原因</th>
                </tr>
              </thead>
              <tbody>
                {report.excluded.map((entry) => (
                  <tr key={entry.studentRef}>
                    <td className="mono">{entry.studentRef}</td>
                    <td>{entry.grade}</td>
                    <td>{entry.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Notice tone="plain" title="隐私说明：">
          报告只包含本地代号与聚合计数；导出 JSON 也遵循同一最小化口径
          （aggregateOnly=true、rawStudentDataIncluded=false、eventIdsIncluded=false）。
        </Notice>
      </Section>

      <Section
        eyebrow="导出内容"
        title="这份 JSON 里有什么"
        description="导出前先核对字段，避免把聚合报告误当原始数据。"
      >
        <div className="grid grid-2">
          <div className="card">
            <h3>包含</h3>
            <ul className="muted small">
              <li>生成时间与统计窗口</li>
              <li>每个纳入学生的本地代号、年级、聚合计数</li>
              <li>各 KC 的聚合计数与关注原因</li>
              <li>被排除学生及排除原因</li>
            </ul>
          </div>
          <div className="card">
            <h3>不包含</h3>
            <ul className="muted small">
              <li>题目原文、答案、解题步骤</li>
              <li>任何原始作答文本</li>
              <li>原始学习事件 ID</li>
              <li>真实姓名、账号、照片、模型会话</li>
            </ul>
          </div>
        </div>
        <div className="chip-row" style={{ marginTop: 'var(--space-md)' }}>
          <Tag tone="green">aggregateOnly: true</Tag>
          <Tag tone="green">rawStudentDataIncluded: false</Tag>
          <Tag tone="green">eventIdsIncluded: false</Tag>
          <Tag tone="green">revokedConsentExcluded: true</Tag>
        </div>
      </Section>
    </div>
  )
}
