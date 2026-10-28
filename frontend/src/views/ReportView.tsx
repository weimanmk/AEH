import { useState } from 'react'
import {
  permissionDomains,
  privacyMinimization,
  reports,
} from '../data/synthetic'
import type { AggregateMetrics, AttentionReason, LearningReport } from '../data/synthetic'
import { Badge, KeyValues, Notice, PageHeader, Section, Tag } from '../components/ui'
import { formatPercent } from '../lib/fractions'

const ATTENTION_LABEL: Record<AttentionReason, string> = {
  low_independent_accuracy: '独立正确率偏低',
  reviews_not_completed: '复习未完成',
}

function independentAccuracy(metrics: AggregateMetrics): number | null {
  return metrics.attempts === 0 ? null : metrics.independentCorrect / metrics.attempts
}

function hintsPerAttempt(metrics: AggregateMetrics): number | null {
  return metrics.attempts === 0 ? null : metrics.hintsRequested / metrics.attempts
}

function reviewCompletion(metrics: AggregateMetrics): number | null {
  return metrics.reviewsDue === 0 ? null : Math.min(1, metrics.reviewsCompleted / metrics.reviewsDue)
}

/** 提示次数/尝试 是计数比值，不按百分比呈现。 */
function formatRatio(value: number | null): string {
  return value === null ? '—' : value.toFixed(2)
}

function ReportBody({ report }: { report: LearningReport }) {
  const totals = report.totals
  const windowStart = report.windowStart
  const windowEnd = report.windowEnd

  return (
    <div className="stack">
      <div className="grid grid-4">
        <div className="stat">
          <div className="stat-label">纳入聚合事件</div>
          <div className="stat-value">{report.dataMinimization.sourceEventsUsed}</div>
          <div className="stat-sub">
            排除 {report.dataMinimization.sourceEventsExcluded}（未授权/越界/重复）
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">学习尝试</div>
          <div className="stat-value">{totals.attempts}</div>
          <div className="stat-sub">
            独立正确 {totals.independentCorrect} · 提示后正确 {totals.hintedCorrect}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">独立正确率</div>
          <div className="stat-value">{formatPercent(independentAccuracy(totals))}</div>
          <div className="stat-sub">每尝试提示数 {formatRatio(hintsPerAttempt(totals))}</div>
        </div>
        <div className="stat">
          <div className="stat-label">复习完成率</div>
          <div className="stat-value">{formatPercent(reviewCompletion(totals))}</div>
          <div className="stat-sub">
            {totals.reviewsCompleted}/{totals.reviewsDue} · 累计 {totals.minutes.toFixed(1)} 分钟
          </div>
        </div>
      </div>

      <div className="card">
        <div className="spread">
          <h3 style={{ marginBottom: 0 }}>报告窗口与数据最小化</h3>
          <Badge tone="lavender">{report.reportType}</Badge>
        </div>
        <div style={{ marginTop: 'var(--space-md)' }}>
          <KeyValues
            items={[
              { key: '学生引用（伪匿名）', value: <span className="mono">{report.studentRef}</span> },
              {
                key: '统计窗口',
                value: (
                  <>
                    {windowStart} — {windowEnd}
                    <div className="tiny muted">
                      边界：{report.windowBoundary}（含起点，不含终点）
                    </div>
                  </>
                ),
              },
              { key: '生成时间', value: report.generatedAt },
              {
                key: '授权范围',
                value: (
                  <div className="chip-row">
                    {report.dataMinimization.authorizedScopes.map((scope) => (
                      <Tag key={scope} tone="gray">
                        {scope}
                      </Tag>
                    ))}
                  </div>
                ),
              },
              {
                key: '仅聚合事件',
                value: report.dataMinimization.authorizedAggregateEventsOnly ? '是' : '否',
              },
              {
                key: '包含原始学生数据',
                value: report.dataMinimization.rawStudentDataIncluded ? '是' : '否',
              },
              {
                key: '包含事件 ID',
                value: report.dataMinimization.eventIdsIncluded ? '是' : '否',
              },
            ]}
          />
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>知识点聚合</th>
              <th className="num">尝试</th>
              <th className="num">独立正确率</th>
              <th className="num">每尝试提示数</th>
              <th className="num">复习完成</th>
              <th>待关注</th>
            </tr>
          </thead>
          <tbody>
            {report.topics.map((topic) => (
              <tr key={topic.kcId}>
                <td className="mono">{topic.kcId}</td>
                <td className="num">{topic.metrics.attempts}</td>
                <td className="num">{formatPercent(independentAccuracy(topic.metrics))}</td>
                <td className="num">{formatRatio(hintsPerAttempt(topic.metrics))}</td>
                <td className="num">
                  {topic.metrics.reviewsCompleted}/{topic.metrics.reviewsDue}
                </td>
                <td>
                  {topic.attentionReasons.length ? (
                    <div className="chip-row">
                      {topic.attentionReasons.map((reason) => (
                        <Badge key={reason} tone="warning">
                          {ATTENTION_LABEL[reason]}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <Badge tone="success">无</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Notice tone="warning" title="待关注点：">
        {report.attentionTopics.length
          ? `${report.attentionTopics.join('、')}（仅基于当前窗口内的聚合数据，是人工复核提示，不是能力标签）。`
          : '无（仅基于当前窗口内的聚合数据）。'}
      </Notice>

      <div className="callout">{report.note}</div>
    </div>
  )
}

export default function ReportView() {
  const [audience, setAudience] = useState<'teacher' | 'guardian'>('teacher')
  const report = reports[audience]

  return (
    <div className="container">
      <PageHeader
        eyebrow="报告视图 · 合成演示"
        title="教师 / 家长聚合报告"
        lede="报告只消费已授权的聚合事件：不含原始作答文本、图片、题目内容或事件 ID。"
        actions={
          <div className="pill-tabs" role="tablist" aria-label="报告受众">
            <button
              type="button"
              role="tab"
              aria-selected={audience === 'teacher'}
              className={`pill-tab${audience === 'teacher' ? ' active' : ''}`}
              onClick={() => setAudience('teacher')}
            >
              教师报告
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={audience === 'guardian'}
              className={`pill-tab${audience === 'guardian' ? ' active' : ''}`}
              onClick={() => setAudience('guardian')}
            >
              家长/监护人报告
            </button>
          </div>
        }
      />

      <Notice tone="synthetic" title="仅聚合事件：">
        本页展示的是聚合统计（尝试数、独立正确率、提示次数、复习完成、时长），
        <strong>不含原始学生数据</strong>，也不含任何事件 ID。受众越权无法扩大授权范围。
      </Notice>

      <Section
        eyebrow={`受众：${report.audienceLabel}`}
        title={`${report.audienceLabel}学习报告（聚合）`}
        description="字段与字段含义对齐仓库中的聚合报告边界（aeh/report.py 的 as_dict）。"
      >
        <ReportBody report={report} />
      </Section>

      <Section
        eyebrow="权限域"
        title="教师与家长看到的范围不同"
        description="家长视图按授权范围收窄；越权请求只能缩小、不能扩大可见范围。"
      >
        <div className="grid grid-2">
          <div className="card">
            <h3>教师报告</h3>
            <ul className="muted">
              <li>授权范围：educational_report、teacher_report</li>
              <li>覆盖 4 个知识点的聚合</li>
              <li>用于教学复核，不替代教师判断</li>
            </ul>
          </div>
          <div className="card">
            <h3>家长 / 监护人报告</h3>
            <ul className="muted">
              <li>授权范围：educational_report、guardian_report</li>
              <li>仅显示已授权共享的部分知识点聚合</li>
              <li>同样不含原始作答、图片或事件 ID</li>
            </ul>
          </div>
        </div>
      </Section>

      <Section
        eyebrow="规范 §13.3"
        title="权限域与数据边界"
        description="报告只读取 teacher_guardian_scope；模拟证据留在 simulation_isolated，永不混入真实观测。"
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>权限域</th>
                <th>范围</th>
                <th>可见方</th>
                <th>约束</th>
              </tr>
            </thead>
            <tbody>
              {permissionDomains.map((domain) => (
                <tr key={domain.domain}>
                  <td className="mono tiny">{domain.domain}</td>
                  <td className="small">{domain.scope}</td>
                  <td className="small">{domain.visibleTo}</td>
                  <td className="small muted">{domain.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        eyebrow="规范 §21"
        title="隐私最小化、数据治理与学术诚信"
        description="以学习事件为中心，不监控与学习无关的行为；未成年人保护与内容治理为演示声明，不连接任何真实数据存储。"
      >
        <div className="grid grid-2">
          <div className="card">
            <h3>最小化采集原则（§21.1）</h3>
            <ul className="muted">
              {privacyMinimization.principles.map((principle) => (
                <li key={principle.id}>
                  <strong>{principle.title}</strong>：{principle.statement}
                  <span className="tiny muted"> （{principle.status}）</span>
                </li>
              ))}
            </ul>
            <h4>同意与权利（合成数据声明）</h4>
            <KeyValues
              items={[
                {
                  key: '监护同意',
                  value: <span className="mono tiny">{privacyMinimization.consent.guardianConsent}</span>,
                },
                { key: '保留期', value: `${privacyMinimization.consent.retentionDays} 天` },
                {
                  key: '导出 / 纠错 / 删除',
                  value: [
                    privacyMinimization.consent.exportSupported ? '导出' : null,
                    privacyMinimization.consent.correctionSupported ? '纠错' : null,
                    privacyMinimization.consent.deletionSupported ? '删除' : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                },
              ]}
            />
            <p className="tiny muted" style={{ marginBottom: 0 }}>
              {privacyMinimization.note}
            </p>
          </div>
          <div className="stack">
            <div className="card">
              <h3>数据治理与模型隔离（§21.2）</h3>
              <ul className="small muted" style={{ marginBottom: 0 }}>
                {privacyMinimization.governance.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            </div>
            <div className="card">
              <h3>学术诚信与教师权责（§21.3）</h3>
              <ul className="small muted" style={{ marginBottom: 0 }}>
                {privacyMinimization.academicIntegrity.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </Section>
    </div>
  )
}
