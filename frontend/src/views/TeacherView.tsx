import {
  DEMO_META,
  agentRoles,
  beliefUpdate,
  candidateInterventions,
  curriculumEdges,
  diagnosisObjective,
  diagnosticTrace,
  evolutionPipeline,
  hintGradient,
  hypotheses,
  hypothesisBudget,
  hypothesisLifecycle,
  interventionPackage,
  itemTypeGenerators,
  kcLabel,
  knowledgeFacets,
  knowledgeState,
  learningMethods,
  methodCombinationRule,
  misconceptionBeliefs,
  nextIntervalDays,
  observableTrace,
  policyActions,
  posteriorShifts,
  probeCandidates,
  progressAxes,
  progressAxisMeta,
  recommendationAudit,
  retentionUnits,
  reviewEventSamples,
  reviewQueue,
  reviewQueueWeights,
  reviewTargets,
  rewardHackGuards,
  strategyState,
  teachingPolicy,
  teachingValueWeights,
  toolCatalogSample,
  twinMeta,
  twinVersionHistory,
  unknownHypothesisWeight,
  virtualStudentMechanisms,
  workflowCurrentPath,
  workflowEdges,
  workflowNodes,
  workflowNote,
} from '../data/synthetic'
import type { ExposureState, Hypothesis, ProgressStatus } from '../data/synthetic'
import { Badge, KeyValues, Meter, Notice, PageHeader, Section, Tag } from '../components/ui'
import { formatNumber, formatPercent } from '../lib/fractions'

const EXPOSURE_LABEL: Record<ExposureState, string> = {
  taught: '已教',
  in_progress: '进行中',
  not_taught: '未教',
  unknown: '未知',
}

const PROGRESS_LABEL: Record<ProgressStatus, string> = {
  taught: '已教',
  in_progress: '正在教',
  upcoming: '即将教',
  not_taught: '未教',
}

function exposureTone(state: ExposureState): 'success' | 'warning' | 'neutral' {
  if (state === 'taught') return 'success'
  if (state === 'in_progress') return 'warning'
  return 'neutral'
}

function HypothesisCard({ hypothesis }: { hypothesis: Hypothesis }) {
  return (
    <article className="card">
      <div className="spread">
        <h3 style={{ marginBottom: 0 }}>{hypothesis.label}</h3>
        <div className="row">
          <Badge tone={hypothesis.status === 'active' ? 'success' : 'neutral'}>
            {hypothesis.status}
          </Badge>
          <Badge tone="lavender">不确定性 {hypothesis.uncertainty}</Badge>
        </div>
      </div>
      <div style={{ margin: 'var(--space-sm) 0 var(--space-md)' }}>
        <Meter
          value={hypothesis.posteriorWeight}
          tone="navy"
          label={`后验权重 ${formatPercent(hypothesis.posteriorWeight)} · parent twin v${hypothesis.parentTwinVersion}`}
        />
      </div>
      <div className="chip-row" style={{ marginBottom: 'var(--space-sm)' }}>
        {hypothesis.subjectScope.map((kc) => (
          <Tag key={kc} tone="lavender">
            {kc}
          </Tag>
        ))}
      </div>
      <KeyValues
        items={[
          {
            key: '知识假设',
            value: (
              <ul style={{ marginBottom: 0 }}>
                {hypothesis.knowledgeAssumptions.map((assumption) => (
                  <li key={assumption.kcId}>
                    <span className="mono tiny">{assumption.kcId}</span>：{assumption.assumption}
                  </li>
                ))}
              </ul>
            ),
          },
          { key: '策略倾向', value: hypothesis.strategyPolicy.join('；') },
          {
            key: '错误规则',
            value: hypothesis.bugRules.length ? hypothesis.bugRules.join('；') : '无',
          },
          {
            key: '可观察行为预测',
            value: (
              <ul style={{ marginBottom: 0 }}>
                {hypothesis.predictedObservableBehaviors.map((behavior) => (
                  <li key={behavior}>{behavior}</li>
                ))}
              </ul>
            ),
          },
          { key: '干预反应假设', value: hypothesis.responseToIntervention.join('；') },
          {
            key: '证据引用',
            value: (
              <span className="mono tiny">
                {hypothesis.evidenceRefs.join(', ') || '—'}
              </span>
            ),
          },
        ]}
      />
    </article>
  )
}

export default function TeacherView() {
  const activeHypotheses = hypotheses.filter((hypothesis) => hypothesis.status === 'active')

  return (
    <div className="container">
      <PageHeader
        eyebrow="教师孪生 / 诊断视图 · 合成演示"
        title="合成学生的知识状态与诊断追溯"
        lede="演示长期认知孪生的多层状态、短期认知假设，以及一次主动诊断的证据链。"
      />

      <Notice tone="synthetic" title="合成数据声明：">
        {DEMO_META.syntheticNotice} 下面的概率是结构示例，不是基于真实学生数据得出的估计。
      </Notice>

      <Section
        eyebrow="被测对象"
        title="合成学生档案"
        description="伪匿名标识，仅用于演示；不包含姓名、学号或任何真实身份信息。"
      >
        <div className="grid grid-2">
          <div className="card">
            <KeyValues
              items={[
                { key: '伪匿名学生引用', value: <span className="mono">{DEMO_META.pseudonymousStudentRef}</span> },
                { key: '学段 / 学科', value: `${DEMO_META.stage} · ${DEMO_META.subject}` },
                { key: '教材版本', value: <span className="mono">{DEMO_META.textbookVersion}</span> },
                { key: '孪生版本', value: <span className="mono">v{DEMO_META.twinVersion}</span> },
                { key: '班级（合成）', value: DEMO_META.className },
              ]}
            />
          </div>
          <div className="card">
            <h3>本演示强调的三件事</h3>
            <ul className="muted" style={{ marginBottom: 0 }}>
              <li>认知状态是多维的：概念、程序、策略迁移、检索保持分开估计（规范 §5.2）。</li>
              <li>假设是“可被真实证据检验的解释”，不是“粗心型/学霸型”性格标签（规范 §6.1）。</li>
              <li>系统只声称“证据支持某假设”，不声称读出了学生的内心想法（规范 §5.3）。</li>
            </ul>
          </div>
        </div>
      </Section>

      <Section
        eyebrow="规范 §5.1 / §5.4"
        title="孪生生命周期与版本化状态"
        description="原始真实事件不可更改；推断状态可重建/回滚。学生或教师的纠错形成新事件，而非删除历史证据。"
      >
        <div className="grid grid-2">
          <div className="card">
            <h3>孪生元数据</h3>
            <KeyValues
              items={[
                { key: '孪生版本', value: <span className="mono">v{twinMeta.version}</span> },
                { key: '最后观测时间', value: twinMeta.lastObservedAt },
                { key: '校准配置', value: <span className="mono tiny">{twinMeta.calibrationProfile}</span> },
                { key: '记忆模型族', value: <span className="mono tiny">{twinMeta.memoryModelFamily}</span> },
                {
                  key: '记忆模型版本',
                  value: <span className="mono tiny">{twinMeta.reviewState.memoryModelVersion}</span>,
                },
                {
                  key: '待处理复习事件',
                  value: <span className="mono tiny">{twinMeta.reviewState.pendingReviewEventIds.join(', ')}</span>,
                },
                {
                  key: '未决假设',
                  value: <span className="mono tiny">{twinMeta.unresolvedHypotheses.join(', ')}</span>,
                },
              ]}
            />
            <h4 style={{ marginTop: 'var(--space-md)' }}>教学偏好（带样本量）</h4>
            {twinMeta.pedagogicalPreferences.map((pref) => (
              <div key={pref.key} style={{ marginBottom: 'var(--space-sm)' }}>
                <div className="spread small">
                  <span className="mono tiny">{pref.key}</span>
                  <span className="muted">
                    {formatPercent(pref.weight, 0)} · n={pref.sampleCount}
                  </span>
                </div>
                <Meter value={pref.weight} tone="green" />
              </div>
            ))}
            <Notice tone="plain" title="事件溯源：">
              原始事件不可变；推断状态可重建/回滚（raw_events_immutable=
              {twinMeta.eventSourcing.rawEventsImmutable ? 'true' : 'false'}）。最近重建于{' '}
              {twinMeta.eventSourcing.lastRebuiltAt}，证据摘要{' '}
              <span className="mono tiny">{twinMeta.eventSourcing.evidenceHash}</span>。
            </Notice>
          </div>
          <div className="card">
            <h3>版本历史</h3>
            <ol className="timeline">
              {twinVersionHistory.map((record) => (
                <li className="timeline-item" key={record.version}>
                  <div className="timeline-stage">
                    v{record.version} · {record.kind}
                  </div>
                  <h4>{record.trigger}</h4>
                  <p className="small">{record.summary}</p>
                  <div className="tiny muted">
                    {record.at} · <span className="mono">{record.evidenceHash}</span>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </Section>

      <Section
        eyebrow="规范 §4.1"
        title="三条彼此独立的进度轴"
        description="学校进度、认知进度与 AI 强化进度分别保存来源与置信度；课堂讲过不等于已掌握。"
      >
        <div className="card" style={{ marginBottom: 'var(--space-lg)' }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>进度轴</th>
                  <th>progress_source</th>
                  <th>confirmed_at</th>
                  <th className="num">confidence</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {progressAxisMeta.map((meta) => (
                  <tr key={meta.axis}>
                    <td className="mono tiny">{meta.axis}</td>
                    <td className="mono tiny">{meta.progressSource}</td>
                    <td className="mono tiny">{meta.confirmedAt ?? '未确认/待确认'}</td>
                    <td className="num">{formatPercent(meta.confidence, 0)}</td>
                    <td className="small muted">{meta.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="grid grid-3">
          {progressAxes.map((axis) => (
            <div className="card" key={axis.axis}>
              <h3 style={{ fontSize: 18 }}>{axis.label}</h3>
              <p className="small muted">{axis.description}</p>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {axis.items.map((entry) => (
                  <li
                    key={entry.kcId}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 8,
                      borderTop: '1px solid var(--color-hairline-soft)',
                      padding: '6px 0',
                      fontSize: 13,
                    }}
                  >
                    <span>
                      <span className="mono tiny">{entry.kcId}</span>
                      <br />
                      <span className="muted">{entry.note}</span>
                    </span>
                    <span className="nowrap">
                      <Badge tone={PROGRESS_LABEL[entry.status] === '未教' ? 'neutral' : 'success'}>
                        {PROGRESS_LABEL[entry.status]}
                      </Badge>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>

      <Section
        eyebrow="规范 §5.1 / §5.2"
        title="知识状态（多层，不压缩为单一掌握率）"
        description="每个知识点分别给出掌握后验、独立检索概率与近/远迁移估计；未教内容保留 unknown。"
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>知识点</th>
                <th>接触状态</th>
                <th className="num">掌握后验</th>
                <th className="num">不确定性</th>
                <th className="num">7 天检索概率</th>
                <th className="num">近迁移</th>
                <th className="num">远迁移</th>
                <th className="num">证据数</th>
              </tr>
            </thead>
            <tbody>
              {knowledgeState.map((entry) => (
                <tr key={entry.kcId}>
                  <td>
                    <div>{kcLabel(entry.kcId)}</div>
                    <span className="mono tiny muted">{entry.kcId}</span>
                  </td>
                  <td>
                    <Badge tone={exposureTone(entry.exposureState)}>
                      {EXPOSURE_LABEL[entry.exposureState]}
                    </Badge>
                  </td>
                  <td className="num">
                    <Meter
                      value={entry.masteryPosterior.mean}
                      tone="primary"
                      label={formatPercent(entry.masteryPosterior.mean, 0)}
                    />
                  </td>
                  <td className="num">{formatPercent(entry.masteryPosterior.uncertainty, 0)}</td>
                  <td className="num">
                    {formatPercent(entry.retrieveProbability.p, 0)}
                    <div className="tiny muted">
                      @ {entry.retrieveProbability.atHorizonDays} 天
                    </div>
                  </td>
                  <td className="num">{formatPercent(entry.transferEstimate.near, 0)}</td>
                  <td className="num">{formatPercent(entry.transferEstimate.far, 0)}</td>
                  <td className="num">{entry.evidenceCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        eyebrow="规范 §5.2"
        title="四维认知：概念 / 程序 / 策略迁移 / 检索"
        description="一个学生可能快速背出公式但不理解适用条件；四者不可混为一个百分比。"
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>知识点</th>
                <th className="num">概念理解</th>
                <th className="num">程序流畅</th>
                <th className="num">策略 / 迁移</th>
                <th className="num">检索保持</th>
                <th>证据说明</th>
              </tr>
            </thead>
            <tbody>
              {knowledgeFacets.map((facet) => (
                <tr key={facet.kcId}>
                  <td>
                    <div>{kcLabel(facet.kcId)}</div>
                    <span className="mono tiny muted">{facet.kcId}</span>
                  </td>
                  <td className="num">
                    <Meter
                      value={facet.conceptual.mean}
                      label={`${formatPercent(facet.conceptual.mean, 0)} ±${formatPercent(facet.conceptual.uncertainty, 0)}`}
                    />
                  </td>
                  <td className="num">
                    <Meter
                      value={facet.procedural.mean}
                      tone="navy"
                      label={`${formatPercent(facet.procedural.mean, 0)} ±${formatPercent(facet.procedural.uncertainty, 0)}`}
                    />
                  </td>
                  <td className="num">
                    <Meter
                      value={facet.strategy.mean}
                      tone="orange"
                      label={`${formatPercent(facet.strategy.mean, 0)} ±${formatPercent(facet.strategy.uncertainty, 0)}`}
                    />
                  </td>
                  <td className="num">
                    <Meter
                      value={facet.retrieval.mean}
                      tone="green"
                      label={`${formatPercent(facet.retrieval.mean, 0)} ±${formatPercent(facet.retrieval.uncertainty, 0)}`}
                    />
                  </td>
                  <td className="small muted">{facet.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        eyebrow="规范 §5.3"
        title="可观察步骤图（不是读心）"
        description="按有向步骤图存储：步骤 + 表达式 + 操作规则 + 依赖 + 校验结果 + 置信度。"
      >
        <div className="grid grid-2">
          <div className="card">
            <h3>一次作答的步骤图</h3>
            <p className="small muted">
              作答 <span className="mono tiny">{observableTrace.attemptId}</span> · 题项{' '}
              <span className="mono tiny">{observableTrace.itemId}</span> · source_type=
              {observableTrace.sourceType}
            </p>
            <ol className="timeline">
              {observableTrace.steps.map((step) => (
                <li className="timeline-item" key={step.stepId}>
                  <div className="timeline-stage">
                    {step.stepId} · {step.validity}
                  </div>
                  <h4 className="mono">{step.expression}</h4>
                  <p className="small">
                    操作规则：{step.operationRule} · 依赖：{step.dependsOn.join(', ') || '无'} · 置信度{' '}
                    {formatPercent(step.confidence, 0)}
                  </p>
                </li>
              ))}
            </ol>
          </div>
          <div className="card">
            <h3>边界说明</h3>
            <ul className="muted">
              <li>模型只能推断“存在补偿/通分相关误区的证据”，不能断言学生心里一定如此想。</li>
              <li>对没写步骤的答案，证据尤其薄弱，应通过追问获取，而不是补造思维轨迹。</li>
              <li>校验结果由独立验证器给出，不由生成器自称正确。</li>
            </ul>
            <Notice tone="warning" title="读心边界：">
              {observableTrace.note}
            </Notice>
          </div>
        </div>
      </Section>

      <Section
        eyebrow="规范 §5.3 / §6"
        title="可观察策略与误区信念"
        description="策略使用频率与误区后验权重都来自可观察作答证据；不是心理人格标签。"
      >
        <div className="grid grid-2">
          <div className="card">
            <h3>观察到的策略使用</h3>
            {strategyState.map((strategy) => (
              <div key={strategy.strategyId} style={{ marginBottom: 'var(--space-md)' }}>
                <div className="spread small">
                  <span>{strategy.label}</span>
                  <span className="muted">
                    {formatPercent(strategy.observedFrequency, 0)} · {strategy.supportLevel}
                  </span>
                </div>
                <Meter value={strategy.observedFrequency} tone="green" />
              </div>
            ))}
          </div>
          <div className="card">
            <h3>误区信念（存在证据的强度）</h3>
            {misconceptionBeliefs.map((belief) => (
              <div key={belief.ruleId} style={{ marginBottom: 'var(--space-md)' }}>
                <div className="spread small">
                  <span>
                    {belief.label}{' '}
                    <span className="mono tiny muted">{belief.ruleId}</span>
                  </span>
                  <span className="muted">{formatPercent(belief.posteriorWeight, 0)}</span>
                </div>
                <Meter value={belief.posteriorWeight} tone="orange" />
                <div className="tiny muted" style={{ marginTop: 2 }}>
                  {belief.description}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section
        eyebrow="规范 §6.1 / §6.2"
        title={`短期虚拟学生（认知假设）· 活跃 ${activeHypotheses.length} 个`}
        description="每个假设只模拟一条错误规则或策略缺口，不模拟完整人格。"
      >
        <div className="grid grid-2">
          {hypotheses.map((hypothesis) => (
            <HypothesisCard key={hypothesis.hypothesisId} hypothesis={hypothesis} />
          ))}
        </div>
        <div style={{ marginTop: 'var(--space-lg)' }}>
          <Notice tone="plain" title="Unknown：">
            未被任何候选解释的剩余概率为 {formatPercent(unknownHypothesisWeight)}
            。当所有候选解释力都低时，系统不强制选择，而是新增未知原因并寻求真实证据。
          </Notice>
        </div>
      </Section>

      <Section
        eyebrow="规范 §6.2 / §6.3"
        title="假设生命周期与数量预算"
        description="Spawn / Split / Reweight / Merge / Prune / Resample / Unknown；N_active 由不确定性、候选分歧、预计信息增益与成本预算动态决定。"
      >
        <div className="grid grid-2">
          <div className="card">
            <h3>数量与预算</h3>
            <KeyValues
              items={[
                { key: '活跃假设数 N_active', value: hypothesisBudget.nActive },
                {
                  key: '预计信息增益',
                  value: formatNumber(hypothesisBudget.expectedInformationGain, 2),
                },
                { key: '诊断 / 模拟预算', value: `${hypothesisBudget.budgetMinutes} 分钟` },
              ]}
            />
            <p className="small muted">{hypothesisBudget.rationale}</p>
            <Notice tone="plain" title="边界：">
              {hypothesisBudget.note}
            </Notice>
          </div>
          <div className="card">
            <h3>观测匹配（Bayesian / particle-style）</h3>
            <code className="timeline-payload">{beliefUpdate.formula}</code>
            <ul className="small muted" style={{ marginTop: 'var(--space-sm)' }}>
              {beliefUpdate.requirements.map((requirement) => (
                <li key={requirement}>{requirement}</li>
              ))}
            </ul>
            <p className="tiny muted" style={{ marginBottom: 0 }}>
              {beliefUpdate.note}
            </p>
          </div>
        </div>
        <div className="card" style={{ marginTop: 'var(--space-lg)' }}>
          <h3>生命周期事件</h3>
          <ol className="timeline">
            {hypothesisLifecycle.map((event, index) => (
              <li className="timeline-item" key={`${event.at}-${event.action}-${index}`}>
                <div className="timeline-stage">{event.action}</div>
                <h4>
                  <span className="mono tiny">{event.hypothesisId}</span> → {event.resultingStatus}
                </h4>
                <p className="small">{event.detail}</p>
                <div className="tiny muted">
                  证据：{event.evidenceRefs.join(', ') || '—'} · {event.at}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </Section>

      <Section
        eyebrow="规范 §7.1"
        title="主动诊断追溯链"
        description="一次由真实作答触发的诊断：Observe → Localize → Expand → Simulate → ChooseProbe → Update。"
      >
        <div className="grid grid-2">
          <div className="card">
            <ol className="timeline">
              {diagnosticTrace.map((step) => (
                <li className="timeline-item" key={step.stage}>
                  <div className="timeline-stage">{step.stage}</div>
                  <h4>{step.title}</h4>
                  <p className="small">{step.detail}</p>
                  {step.payload ? (
                    <code className="timeline-payload">{step.payload}</code>
                  ) : null}
                  <div className="tiny muted" style={{ marginTop: 6 }}>
                    证据：{step.evidenceIds.join(', ')}
                  </div>
                </li>
              ))}
            </ol>
          </div>
          <div className="stack">
            <div className="card">
              <h3>后验变化</h3>
              <p className="small muted">探测题作答前后，各假设权重的变化。</p>
              {posteriorShifts.map((shift) => (
                <div key={shift.hypothesisId} style={{ marginBottom: 'var(--space-md)' }}>
                  <div className="spread small">
                    <span>{shift.label}</span>
                    <span className="muted">
                      {formatPercent(shift.before, 0)} → {formatPercent(shift.after, 0)}
                    </span>
                  </div>
                  <Meter
                    value={shift.after}
                    tone={shift.after >= shift.before ? 'navy' : 'orange'}
                    label={`after ${formatNumber(shift.after, 2)}`}
                  />
                </div>
              ))}
            </div>
            <Notice tone="warning" title="读心边界：">
              更新的是“哪个假设更能解释可观察证据”的权重，而不是学生的内心想法。
              对没写步骤的答案，证据尤其薄弱，应通过追问获取。
            </Notice>
            <div className="card">
              <h3>先修关系（课程图谱）</h3>
              <ul className="small" style={{ marginBottom: 0 }}>
                {curriculumEdges.map((edge) => (
                  <li key={`${edge.source}-${edge.target}-${edge.edgeType}`}>
                    <span className="mono tiny">{edge.source}</span>{' '}
                    <Badge tone={edge.edgeType === 'REQUIRES' ? 'sky' : 'neutral'}>
                      {edge.edgeType}
                    </Badge>{' '}
                    <span className="mono tiny">{edge.target}</span>{' '}
                    <span className="tiny muted">({edge.reviewState})</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </Section>

      <Section
        eyebrow="规范 §7.2"
        title="主动诊断目标与候选探测题"
        description="基础目标是期望信息增益，并惩罚过长题目、超前内容、不确定答案与认知负担。"
      >
        <div className="card" style={{ marginBottom: 'var(--space-lg)' }}>
          <code className="timeline-payload">{diagnosisObjective.formula}</code>
          <p className="small muted" style={{ marginTop: 'var(--space-sm)', marginBottom: 0 }}>
            α={diagnosisObjective.alpha} · β={diagnosisObjective.beta} · γ={diagnosisObjective.gamma} ·{' '}
            {diagnosisObjective.note}
          </p>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>候选探测题</th>
                <th className="num">IG</th>
                <th className="num">教学价值</th>
                <th className="num">用时</th>
                <th className="num">风险</th>
                <th className="num">score</th>
                <th>门禁</th>
                <th>理由</th>
              </tr>
            </thead>
            <tbody>
              {probeCandidates.map((probe) => (
                <tr key={probe.itemId}>
                  <td>
                    <span className="mono tiny">{probe.itemId}</span>
                    <div>{probe.label}</div>
                  </td>
                  <td className="num">{formatNumber(probe.infoGain, 2)}</td>
                  <td className="num">{formatNumber(probe.teachingValue, 2)}</td>
                  <td className="num">{probe.timeMinutes} min</td>
                  <td className="num">{formatNumber(probe.risk, 2)}</td>
                  <td className="num">{formatNumber(probe.score, 3)}</td>
                  <td>
                    {probe.allowed ? (
                      <Badge tone="success">允许</Badge>
                    ) : (
                      <Badge tone="error">拦截</Badge>
                    )}
                  </td>
                  <td className="small muted">{probe.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        eyebrow="规范 §8.4 / §8.6 / §8.7"
        title="复习事件质量、下次间隔与统一调度"
        description="下一次间隔由目标保持概率反解；统一调度融合遗忘风险、先修中心性、近期使用、误区风险、考试紧迫度与复习成本。"
      >
        <div className="grid grid-2">
          <div className="card">
            <h3>复习事件质量</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>事件</th>
                    <th>独立</th>
                    <th className="num">hint</th>
                    <th>迁移层级</th>
                    <th>计入独立检索</th>
                  </tr>
                </thead>
                <tbody>
                  {reviewEventSamples.map((event) => (
                    <tr key={event.eventId}>
                      <td>
                        <span className="mono tiny">{event.eventId}</span>
                        <div className="tiny muted">{event.memoryUnitId}</div>
                      </td>
                      <td>{event.independent ? '是' : '否'}</td>
                      <td className="num">{event.hintLevel}</td>
                      <td>{event.transferLevel}</td>
                      <td>
                        {event.countsAsIndependentRetrieval ? (
                          <Badge tone="success">是</Badge>
                        ) : (
                          <Badge tone="warning">否</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {reviewEventSamples.map((event) => (
              <p className="tiny muted" key={`${event.eventId}-note`}>
                <span className="mono">{event.eventId}</span>：{event.note}
              </p>
            ))}
          </div>
          <div className="card">
            <h3>下次复习间隔（示意式反解）</h3>
            <code className="timeline-payload">Δt = (81/19)·S·(r_target⁻² − 1)</code>
            <div className="table-wrap" style={{ marginTop: 'var(--space-sm)' }}>
              <table>
                <thead>
                  <tr>
                    <th>记忆单元</th>
                    <th className="num">S（天）</th>
                    <th className="num">r_target</th>
                    <th className="num">Δt（天）</th>
                    <th>备注</th>
                  </tr>
                </thead>
                <tbody>
                  {reviewTargets.map((target) => {
                    const unit = retentionUnits.find(
                      (entry) => entry.memoryUnitId === target.memoryUnitId,
                    )
                    const interval = unit
                      ? nextIntervalDays(unit.stabilityDays, target.targetRetention)
                      : 0
                    return (
                      <tr key={target.memoryUnitId}>
                        <td className="mono tiny">{target.memoryUnitId}</td>
                        <td className="num">{unit ? unit.stabilityDays.toFixed(1) : '—'}</td>
                        <td className="num">{formatPercent(target.targetRetention, 0)}</td>
                        <td className="num">{interval.toFixed(1)}</td>
                        <td className="small muted">{target.note}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginTop: 'var(--space-lg)' }}>
          <h3>复习队列优先级</h3>
          <p className="small muted">
            Priority = a·ForgettingRisk + b·PrerequisiteCentrality + c·UpcomingUse +
            d·MisconceptionRisk + e·ExamUrgency − f·ReviewCost；权重 a={reviewQueueWeights.a} b=
            {reviewQueueWeights.b} c={reviewQueueWeights.c} d={reviewQueueWeights.d} e=
            {reviewQueueWeights.e} f={reviewQueueWeights.f}。{reviewQueueWeights.note}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>记忆单元</th>
                  <th>知识点</th>
                  <th className="num">遗忘风险</th>
                  <th className="num">先修中心</th>
                  <th className="num">近期使用</th>
                  <th className="num">误区风险</th>
                  <th className="num">考试紧迫</th>
                  <th className="num">成本</th>
                  <th className="num">优先级</th>
                  <th>行动</th>
                </tr>
              </thead>
              <tbody>
                {reviewQueue.map((row) => (
                  <tr key={row.memoryUnitId}>
                    <td className="mono tiny">{row.memoryUnitId}</td>
                    <td>{kcLabel(row.kcId)}</td>
                    <td className="num">{formatNumber(row.forgettingRisk, 2)}</td>
                    <td className="num">{formatNumber(row.prerequisiteCentrality, 2)}</td>
                    <td className="num">{formatNumber(row.upcomingUse, 2)}</td>
                    <td className="num">{formatNumber(row.misconceptionRisk, 2)}</td>
                    <td className="num">{formatNumber(row.examUrgency, 2)}</td>
                    <td className="num">{formatNumber(row.reviewCost, 2)}</td>
                    <td className="num">
                      <Meter value={row.priority} tone="navy" label={formatNumber(row.priority, 3)} />
                    </td>
                    <td className="small">{row.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="grid grid-3" style={{ marginTop: 'var(--space-lg)' }}>
          {virtualStudentMechanisms.map((mechanism) => (
            <div className="card" key={mechanism.mechanism}>
              <h3 style={{ fontSize: 18 }}>{mechanism.mechanism}</h3>
              <p className="small muted">{mechanism.description}</p>
              <div className="callout">{mechanism.action}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section
        eyebrow="规范 §10"
        title="教学策略路由器、时间预算与提示梯度"
        description="输入：模式 + 掌握分布 + 假设 + 遗忘队列 + 学校日程 + 任务意图 + 时间预算；输出一个可解释的教学动作。"
      >
        <div className="grid grid-2">
          <div className="card">
            <div className="spread">
              <h3 style={{ marginBottom: 0 }}>当前决策</h3>
              <Badge tone="lavender">{teachingPolicy.policyVersion}</Badge>
            </div>
            <KeyValues
              items={[
                { key: '当前模式', value: teachingPolicy.inputs.mode },
                { key: '知识焦点', value: teachingPolicy.inputs.knowledgeFocus },
                {
                  key: '假设集合',
                  value: <span className="mono tiny">{teachingPolicy.inputs.hypothesisSet}</span>,
                },
                { key: '复习队列队首', value: teachingPolicy.inputs.reviewQueueHead },
                { key: '近期学校日程', value: teachingPolicy.inputs.upcomingLesson },
                { key: '任务意图', value: teachingPolicy.inputs.taskIntent },
                { key: '时间预算', value: `${teachingPolicy.inputs.timeBudgetMinutes} 分钟` },
              ]}
            />
            <Notice tone="success" title={`选择动作：${teachingPolicy.chosenAction}`}>
              {teachingPolicy.reason}
            </Notice>
            <ul className="small muted" style={{ marginBottom: 0 }}>
              {teachingPolicy.constraints.map((constraint) => (
                <li key={constraint}>{constraint}</li>
              ))}
            </ul>
          </div>
          <div className="stack">
            <div className="card">
              <h3>动作候选（9 类）</h3>
              <ul className="small" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {policyActions.map((action) => (
                  <li
                    key={action.action}
                    style={{
                      borderTop: '1px solid var(--color-hairline-soft)',
                      padding: '6px 0',
                    }}
                  >
                    <div className="spread">
                      <span>
                        <span className="mono tiny">{action.action}</span>
                        <div className="muted">
                          {action.label} · 条件：{action.selectWhen}
                        </div>
                      </span>
                      {action.chosen ? (
                        <Badge tone="success">选中</Badge>
                      ) : (
                        <Badge tone="neutral">备选</Badge>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <div className="card">
              <h3>每次会话时间分配</h3>
              <div className="grid grid-2">
                {[
                  { key: '预习', value: teachingPolicy.timeBudget.previewMinutes },
                  { key: '课堂同步', value: teachingPolicy.timeBudget.currentCourseMinutes },
                  { key: '复习', value: teachingPolicy.timeBudget.reviewMinutes },
                  { key: '诊断', value: teachingPolicy.timeBudget.diagnosticMinutes },
                  { key: '迁移', value: teachingPolicy.timeBudget.transferMinutes },
                ].map((row) => (
                  <div key={row.key}>
                    <div className="spread small">
                      <span>{row.key}</span>
                      <span className="muted">{row.value} min</span>
                    </div>
                    <Meter value={row.value / teachingPolicy.timeBudget.totalMinutes} />
                  </div>
                ))}
              </div>
              <p className="tiny muted" style={{ marginBottom: 0 }}>
                总时长 {teachingPolicy.timeBudget.totalMinutes} 分钟；比例按当前课堂压力动态分配，
                不是所有学生通用的固定模板。
              </p>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginTop: 'var(--space-lg)' }}>
          <h3>提示梯度（§10.4）· 当前 level={hintGradient.currentLevel}</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="num">level</th>
                  <th>梯度</th>
                  <th>说明</th>
                  <th>当前</th>
                </tr>
              </thead>
              <tbody>
                {hintGradient.levels.map((level) => (
                  <tr key={level.level}>
                    <td className="num">{level.level}</td>
                    <td>{level.label}</td>
                    <td className="small muted">{level.description}</td>
                    <td>
                      {level.level === hintGradient.currentLevel ? (
                        <Badge tone="success">当前</Badge>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="tiny muted" style={{ marginBottom: 0 }}>
            {hintGradient.note}
          </p>
        </div>
      </Section>

      <Section
        eyebrow="规范 §9"
        title="习题演化：干预包、教学价值与防刷分"
        description="不是只生成一道题，而是产生 InterventionPackage；候选从同一快照起跑，按加权教学价值排序。"
      >
        <div className="grid grid-2">
          <div className="card">
            <div className="spread">
              <h3 style={{ marginBottom: 0 }}>干预包</h3>
              <Badge tone="lavender">{interventionPackage.packageId}</Badge>
            </div>
            <KeyValues
              items={[
                {
                  key: '目标 KC',
                  value: <span className="mono tiny">{interventionPackage.objective.targetKc}</span>,
                },
                {
                  key: '当前误区',
                  value: (
                    <span className="mono tiny">{interventionPackage.objective.currentMisconception}</span>
                  ),
                },
                { key: '目标行为', value: interventionPackage.objective.desiredBehavior },
                {
                  key: '模式 / 评估',
                  value: `${interventionPackage.objective.schoolMode} · ${interventionPackage.objective.assessment}`,
                },
                { key: '时间预算', value: `${interventionPackage.objective.timeBudgetMinutes} 分钟` },
                {
                  key: '进度证明',
                  value:
                    interventionPackage.progressProof.gate === 'passed' ? (
                      <Badge tone="success">门禁通过</Badge>
                    ) : (
                      <Badge tone="error">被拦截</Badge>
                    ),
                },
              ]}
            />
            <h4>训练题组</h4>
            <ul className="small muted">
              {interventionPackage.trainingItems.map((training) => (
                <li key={training.type}>
                  <strong>{training.type}</strong>：{training.example}
                </li>
              ))}
            </ul>
            <h4>提示阶梯</h4>
            <ol className="small muted">
              {interventionPackage.hintLadder.map((hint) => (
                <li key={hint}>{hint}</li>
              ))}
            </ol>
            <h4>独立迁移检验</h4>
            <p className="small">
              <span className="mono tiny">{interventionPackage.independentTransferTest.itemId}</span> ·{' '}
              {interventionPackage.independentTransferTest.description} · unseen=
              {interventionPackage.independentTransferTest.unseen ? '是' : '否'} ·{' '}
              {interventionPackage.independentTransferTest.transferLevel}
            </p>
          </div>
          <div className="stack">
            <div className="card">
              <h3>候选干预排序</h3>
              <code className="timeline-payload">{teachingValueWeights.note}</code>
              <div className="table-wrap" style={{ marginTop: 'var(--space-sm)' }}>
                <table>
                  <thead>
                    <tr>
                      <th className="num">#</th>
                      <th>候选</th>
                      <th className="num">E[Gain]</th>
                      <th className="num">U(a)</th>
                      <th>路由</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidateInterventions.map((candidate) => (
                      <tr key={candidate.id}>
                        <td className="num">{candidate.rank}</td>
                        <td>{candidate.label}</td>
                        <td className="num">{formatNumber(candidate.gainMean, 2)}</td>
                        <td className="num">
                          <Meter
                            value={candidate.utility}
                            tone={candidate.rank === 1 ? 'green' : 'primary'}
                            label={formatNumber(candidate.utility, 3)}
                          />
                        </td>
                        <td>
                          {candidate.routing === 'diagnostic' ? (
                            <Tag tone="gray">诊断（按 IG）</Tag>
                          ) : (
                            <Tag tone="lavender">教学增强</Tag>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="tiny muted">
                λ={teachingValueWeights.lambda} μ={teachingValueWeights.mu} ν={teachingValueWeights.nu} ρ=
                {teachingValueWeights.rho}
              </p>
            </div>
            <div className="card">
              <h3>防模拟刷分 / reward hacking（§9.6）</h3>
              <ul className="small muted" style={{ marginBottom: 0 }}>
                {rewardHackGuards.map((guard) => (
                  <li key={guard}>{guard}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <div className="grid grid-2" style={{ marginTop: 'var(--space-lg)' }}>
          <div className="card">
            <h3>进化流水线（§9.4）</h3>
            <ol className="timeline">
              {evolutionPipeline.map((stage) => (
                <li className="timeline-item" key={stage.stage}>
                  <div className="timeline-stage">{stage.stage}</div>
                  <h4>{stage.title}</h4>
                  <p className="small">{stage.detail}</p>
                  <div className="tiny muted">
                    证据：{stage.evidenceRefs.join(', ') || '待真实观测'}
                  </div>
                </li>
              ))}
            </ol>
          </div>
          <div className="card">
            <h3>题型生成器（§9.3）</h3>
            <ul className="small" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {itemTypeGenerators.map((generator) => (
                <li
                  key={generator.type}
                  style={{ borderTop: '1px solid var(--color-hairline-soft)', padding: '6px 0' }}
                >
                  <div className="spread">
                    <span>
                      <strong>{generator.type}</strong>
                      <div className="muted">
                        {generator.purpose} · 例：{generator.example}
                      </div>
                    </span>
                    {generator.usedInDemo ? (
                      <Badge tone="success">本演示</Badge>
                    ) : (
                      <Badge tone="neutral">范围外</Badge>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <Section
        eyebrow="规范 §12"
        title="工作流状态机与 Agent 角色"
        description="有类型状态机 + 受限 Agent 决策器；LLM 不能直接写数据库，也不能把模拟答卷写为真人答卷。"
      >
        <div className="grid grid-2">
          <div className="card">
            <h3>状态与转移</h3>
            <div className="chip-row" style={{ marginBottom: 'var(--space-sm)' }}>
              {workflowNodes.map((node) => (
                <Tag key={node.id} tone={workflowCurrentPath.includes(node.id) ? 'green' : 'gray'}>
                  {node.label}
                </Tag>
              ))}
            </div>
            <p className="small muted">当前演示路径：{workflowCurrentPath.join(' → ')}</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>从</th>
                    <th>到</th>
                    <th>条件</th>
                  </tr>
                </thead>
                <tbody>
                  {workflowEdges.map((edge) => (
                    <tr key={`${edge.from}-${edge.to}-${edge.label ?? ''}`}>
                      <td className="mono tiny">{edge.from}</td>
                      <td className="mono tiny">{edge.to}</td>
                      <td className="small muted">{edge.label ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Notice tone="plain" title="说明：">
              {workflowNote}
            </Notice>
          </div>
          <div className="stack">
            <div className="card">
              <h3>Agent 逻辑角色</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>角色</th>
                      <th>输出</th>
                      <th>禁止行为</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agentRoles.map((role) => (
                      <tr key={role.role}>
                        <td>{role.role}</td>
                        <td className="small muted">{role.output}</td>
                        <td className="small muted">{role.forbidden}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card">
              <h3>工具目录（节选）</h3>
              <ul className="small" style={{ marginBottom: 0 }}>
                {toolCatalogSample.map((tool) => (
                  <li key={tool}>
                    <span className="mono tiny">{tool}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </Section>

      <Section
        eyebrow="规范 §18"
        title="学习科学策略工具箱（按条件调用，不是拼盘）"
        description="方法是可调用的工具箱；每个方法都有使用条件与验证方式，其有效性需以真实学生数据校准。"
      >
        <Notice tone="synthetic" title="组合规则：">
          {methodCombinationRule.situation} → {methodCombinationRule.methods.join(' + ')}，然后用
          {methodCombinationRule.followUp}。{methodCombinationRule.note}
        </Notice>
        <div className="table-wrap" style={{ marginTop: 'var(--space-lg)' }}>
          <table>
            <thead>
              <tr>
                <th>教学方法</th>
                <th>Harness 动作</th>
                <th>使用条件</th>
                <th>怎么验证</th>
                <th>本演示</th>
              </tr>
            </thead>
            <tbody>
              {learningMethods.map((method) => (
                <tr key={method.method}>
                  <td>{method.method}</td>
                  <td className="small muted">{method.harnessAction}</td>
                  <td className="small muted">{method.condition}</td>
                  <td className="small muted">{method.verification}</td>
                  <td>
                    {method.activeHere ? (
                      <Badge tone="success">启用</Badge>
                    ) : (
                      <Badge tone="neutral">未启用</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        eyebrow="规范 §20.3"
        title="每条推荐的可解释审计记录"
        description="学生端只看到简洁解释；教师/研发端可查看证据、策略、版本与评测，而不泄露其他学生数据。"
      >
        <div className="grid grid-2">
          <div className="card">
            <h3>推荐</h3>
            <p>{recommendationAudit.recommendation}</p>
            <Notice tone="success" title="学生端解释：">
              {recommendationAudit.publicExplain}
            </Notice>
            <p className="tiny muted" style={{ marginBottom: 0 }}>
              决策 ID <span className="mono">{recommendationAudit.decisionId}</span> ·{' '}
              {recommendationAudit.teacherNote}
            </p>
          </div>
          <div className="card">
            <h3>审问清单</h3>
            <KeyValues
              items={recommendationAudit.detailedQuestions.map((entry) => ({
                key: entry.question,
                value: entry.answer,
              }))}
            />
          </div>
        </div>
      </Section>
    </div>
  )
}
