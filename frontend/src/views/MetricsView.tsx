import {
  DEMO_META,
  crossSubjectAdapters,
  diagnosticFidelity,
  evaluationSummary,
  highRiskSafetyNote,
  kcLabel,
  metricsByDimension,
  metricsOverview,
  retentionUnits,
  retrievability,
  simulationLabComponents,
  simulationRun,
} from '../data/synthetic'
import { Badge, KeyValues, Meter, Notice, PageHeader, Section, Stat, Tag } from '../components/ui'
import { formatNumber, formatPercent } from '../lib/fractions'

export default function MetricsView() {
  const averageRetention =
    retentionUnits.reduce(
      (sum, unit) => sum + retrievability(unit.elapsedDays, unit.stabilityDays),
      0,
    ) / retentionUnits.length

  const simulated = evaluationSummary.simulatedBenefit
  const real = evaluationSummary.realTransfer

  return (
    <div className="container">
      <PageHeader
        eyebrow="指标仪表盘 · 合成演示"
        title="留存、诊断覆盖与模拟/真实分离"
        lede="演示如何把记忆留存、假设集合保真度与评测证据分开口径呈现；所有数值均为合成 fixture。"
      />

      <Notice tone="synthetic" title="合成数据声明：">
        {DEMO_META.syntheticNotice} 指标用于演示呈现结构，不代表任何真实系统表现。
      </Notice>

      <div className="grid grid-4" style={{ marginTop: 'var(--space-xl)' }}>
        <Stat
          label={`${metricsOverview.horizonDays} 天平均期望检索`}
          value={formatPercent(averageRetention, 1)}
          sub={`目标保持概率 ${formatPercent(metricsOverview.retentionTarget, 0)}`}
        />
        <Stat
          label="诊断覆盖（假设集合）"
          value={formatPercent(diagnosticFidelity.coverage, 1)}
          sub={`${diagnosticFidelity.covered}/${diagnosticFidelity.observationCount} 次观测被现有假设覆盖`}
        />
        <Stat
          label="有效假设数"
          value={formatNumber(diagnosticFidelity.effectiveHypotheses, 1)}
          sub={`最大权重 ${formatPercent(diagnosticFidelity.maxWeight, 0)} · unknown ${formatPercent(diagnosticFidelity.unknownShare, 0)}`}
        />
        <Stat
          label="真实迁移证据"
          value={real ? '已提供' : '未提供'}
          sub={metricsOverview.realEvidenceNote}
        />
      </div>

      <Section
        eyebrow="规范 §8.3"
        title="记忆留存（FSRS-4.5 风格示意式）"
        description="R(t, S) = (1 + (19/81)·(t/S))^(-1/2)。当 t = S 时 R ≈ 0.9；这是示意式，不是统一固定参数。"
      >
        <div className="card" style={{ marginBottom: 'var(--space-lg)' }}>
          <code className="timeline-payload">
            R(t, S) = (1 + (19/81) · (t / S)) ^ (-1/2)
          </code>
          <p className="small muted" style={{ marginTop: 'var(--space-sm)', marginBottom: 0 }}>
            下表同时给出按公式计算的 R 与记录在合成记忆单元中的期望可提取性，用于核对一致性；
            观测稀疏时不得拟合成高精度的个人曲线。
          </p>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>记忆单元</th>
                <th>知识点</th>
                <th className="num">稳定性 S（天）</th>
                <th className="num">距上次 t（天）</th>
                <th className="num">R(t, S)</th>
                <th className="num">记录值</th>
                <th className="num">观测数</th>
                <th>检索质量</th>
                <th>下次复习</th>
              </tr>
            </thead>
            <tbody>
              {retentionUnits.map((unit) => {
                const computed = retrievability(unit.elapsedDays, unit.stabilityDays)
                return (
                  <tr key={unit.memoryUnitId}>
                    <td className="mono tiny">{unit.memoryUnitId}</td>
                    <td>
                      <div>{kcLabel(unit.kcId)}</div>
                      <span className="mono tiny muted">{unit.kcId}</span>
                    </td>
                    <td className="num">{unit.stabilityDays.toFixed(1)}</td>
                    <td className="num">{unit.elapsedDays}</td>
                    <td className="num">
                      <Meter
                        value={computed}
                        tone={computed >= metricsOverview.retentionTarget ? 'green' : 'orange'}
                        label={formatPercent(computed, 1)}
                      />
                    </td>
                    <td className="num">{formatPercent(unit.expectedRetrievability, 1)}</td>
                    <td className="num">
                      {unit.observationCount}
                      <div className="tiny muted">{unit.uncertainty}</div>
                    </td>
                    <td>{unit.observedRetrievalQuality}</td>
                    <td className="tiny">{unit.nextReviewAt.replace('+08:00', '')}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="tiny muted">
          模型族 {retentionUnits[0].modelFamily} · 版本 {retentionUnits[0].modelVersion} ·
          参数后验 {retentionUnits[0].parameterPosterior}
        </p>
      </Section>

      <Section
        eyebrow="规范 §19.3"
        title="诊断覆盖与假设集合保真度"
        description="覆盖、校准、区分度等指标用于判断“当前假设集合是否解释了观测”，None 表示证据不足而非 0。"
      >
        <div className="grid grid-2">
          <div className="card">
            <h3>覆盖与校准</h3>
            <div style={{ marginBottom: 'var(--space-md)' }}>
              <div className="spread small">
                <span>诊断覆盖</span>
                <span className="muted">
                  {formatPercent(diagnosticFidelity.coverage, 1)} / 目标{' '}
                  {formatPercent(metricsOverview.diagnosticCoverageTarget, 0)}
                </span>
              </div>
              <Meter
                value={diagnosticFidelity.coverage}
                tone={
                  diagnosticFidelity.coverage >= metricsOverview.diagnosticCoverageTarget
                    ? 'green'
                    : 'orange'
                }
              />
            </div>
            <KeyValues
              items={[
                { key: '观测数', value: diagnosticFidelity.observationCount },
                { key: '被覆盖观测', value: diagnosticFidelity.covered },
                {
                  key: 'Brier 分数',
                  value: formatNumber(diagnosticFidelity.brierScore ?? 0, 2),
                },
                {
                  key: 'Log loss',
                  value: formatNumber(diagnosticFidelity.logLoss ?? 0, 2),
                },
                {
                  key: '校准误差',
                  value: formatNumber(diagnosticFidelity.calibrationError ?? 0, 2),
                },
                { key: '准确率', value: formatPercent(diagnosticFidelity.accuracy, 1) },
                {
                  key: '样本是否充分',
                  value: diagnosticFidelity.sufficient ? '是' : '否（指标不可用）',
                },
              ]}
            />
          </div>
          <div className="card">
            <h3>行为一致性</h3>
            <KeyValues
              items={[
                {
                  key: '错误类型一致',
                  value: formatPercent(diagnosticFidelity.errorTypeAgreement, 0),
                },
                {
                  key: '步骤一致',
                  value: formatPercent(diagnosticFidelity.stepAgreement, 0),
                },
                {
                  key: '策略一致',
                  value: formatPercent(diagnosticFidelity.strategyAgreement, 0),
                },
                {
                  key: 'unknown 占比',
                  value: formatPercent(diagnosticFidelity.unknownShare, 0),
                },
                {
                  key: '有效假设数',
                  value: formatNumber(diagnosticFidelity.effectiveHypotheses, 1),
                },
                {
                  key: '最大权重',
                  value: formatPercent(diagnosticFidelity.maxWeight, 0),
                },
              ]}
            />
            <p className="tiny muted" style={{ marginTop: 'var(--space-md)', marginBottom: 0 }}>
              {diagnosticFidelity.note}
            </p>
          </div>
        </div>
      </Section>

      <Section
        eyebrow="规范 §19 / 评测模板"
        title="模拟收益与真实迁移严格分离"
        description="模拟只用于候选策略离线筛选；没有真实观测时写“未提供”，绝不用模拟数据替代或推断真实学习效果。"
      >
        <div className="grid grid-2">
          <div className="card" style={{ borderColor: 'var(--color-brand-purple-300)' }}>
            <div className="spread">
              <h3 style={{ marginBottom: 0 }}>L3 · 模拟收益</h3>
              <Badge tone="lavender">非因果证据</Badge>
            </div>
            <p className="small muted">冻结集中 train+explanation 分片上的模拟预测。</p>
            <KeyValues
              items={[
                { key: '评测分片', value: simulated.split },
                { key: '题数', value: simulated.itemCount },
                {
                  key: '模拟平均预测正确率',
                  value: formatPercent(simulated.meanPredictedCorrect, 2),
                },
                {
                  key: '参考基线',
                  value: formatPercent(simulated.referenceAccuracy, 2),
                },
                {
                  key: '模拟收益',
                  value: (
                    <span style={{ color: 'var(--color-brand-green)', fontWeight: 600 }}>
                      {simulated.simulatedGain >= 0 ? '+' : ''}
                      {formatPercent(simulated.simulatedGain, 2)}
                    </span>
                  ),
                },
                {
                  key: '是否因果证据',
                  value: <Badge tone="warning">否</Badge>,
                },
              ]}
            />
            <div className="callout" style={{ marginTop: 'var(--space-md)' }}>
              {simulated.interpretation}
            </div>
          </div>

          <div className="card" style={{ borderColor: 'var(--color-hairline-strong)' }}>
            <div className="spread">
              <h3 style={{ marginBottom: 0 }}>L4 · 真实迁移</h3>
              <Badge tone={real ? 'success' : 'neutral'}>
                {real ? '已提供' : '未提供观测'}
              </Badge>
            </div>
            {real ? (
              <KeyValues
                items={[
                  { key: '未见迁移题数', value: real.itemCount },
                  { key: '独立正确数', value: real.independentCorrect },
                  { key: '迁移正确率', value: formatPercent(real.transferAccuracy, 2) },
                  { key: '参考基线', value: formatPercent(real.referenceAccuracy, 2) },
                  {
                    key: '观测差值（描述性）',
                    value: formatPercent(real.observedDelta, 2),
                  },
                  { key: '全部 unseen', value: real.allItemsUnseen ? '是' : '否' },
                  { key: '支持因果结论', value: real.causalClaimSupported ? '是' : '否（无对照组）' },
                ]}
              />
            ) : (
              <Notice tone="warning" title="未提供真实迁移观测：">
                不得用左侧模拟数据替代或推断真实效果。当前结论：
                <span className="mono tiny"> {evaluationSummary.claim}</span>
              </Notice>
            )}
          </div>
        </div>

        <div className="grid grid-2" style={{ marginTop: 'var(--space-lg)' }}>
          <div className="card">
            <h3>冻结评测集</h3>
            <KeyValues
              items={[
                { key: '数据集', value: <span className="mono tiny">{evaluationSummary.datasetId}</span> },
                { key: '版本', value: evaluationSummary.datasetVersion },
                { key: '冻结时间', value: evaluationSummary.frozenAt },
                { key: '生成时间', value: evaluationSummary.generatedAt },
                {
                  key: 'SHA-256 摘要',
                  value: (
                    <span className="mono tiny" style={{ wordBreak: 'break-all' }}>
                      {evaluationSummary.datasetDigest}
                    </span>
                  ),
                },
                { key: '仅合成 fixture', value: evaluationSummary.syntheticFixturesOnly ? '是' : '否' },
              ]}
            />
            <div className="chip-row" style={{ marginTop: 'var(--space-md)' }}>
              <Tag tone="gray">train {evaluationSummary.splitCounts.train}</Tag>
              <Tag tone="gray">explanation {evaluationSummary.splitCounts.explanation}</Tag>
              <Tag tone="gray">transfer {evaluationSummary.splitCounts.transfer}</Tag>
            </div>
            <div className="callout" style={{ marginTop: 'var(--space-md)' }}>
              分片隔离自检：{evaluationSummary.splitIsolationCheck}
            </div>
          </div>
          <div className="card">
            <h3>防自证约束与已知限制</h3>
            <h4>防自证</h4>
            <ul className="small muted">
              {evaluationSummary.selfProofGuard.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <h4>已知限制</h4>
            <ul className="small muted" style={{ marginBottom: 0 }}>
              {evaluationSummary.limitations.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <Section
        eyebrow="规范 §11"
        title="模拟实验室（严格隔离）"
        description="模拟只用于候选策略筛选；每一条模拟记录都显式标注 source_type=simulated、is_real_student_evidence=false，永不混入真实观测。"
      >
        <div className="grid grid-2">
          <div className="card" style={{ borderColor: 'var(--color-brand-purple-300)' }}>
            <div className="spread">
              <h3 style={{ marginBottom: 0 }}>运行记录</h3>
              <Badge tone="lavender">非真实证据</Badge>
            </div>
            <KeyValues
              items={[
                { key: 'run_id', value: <span className="mono tiny">{simulationRun.runId}</span> },
                {
                  key: 'source_type',
                  value: <Badge tone="lavender">{simulationRun.sourceType}</Badge>,
                },
                {
                  key: 'is_real_student_evidence',
                  value: <Badge tone="warning">false</Badge>,
                },
                {
                  key: 'student_snapshot_version',
                  value: <span className="mono">v{simulationRun.studentSnapshotVersion}</span>,
                },
                {
                  key: 'simulator_version',
                  value: <span className="mono tiny">{simulationRun.simulatorVersion}</span>,
                },
                {
                  key: 'intervention_id',
                  value: <span className="mono tiny">{simulationRun.interventionId}</span>,
                },
                {
                  key: 'heldout_set_id',
                  value: <span className="mono tiny">{simulationRun.heldoutSetId}</span>,
                },
                {
                  key: '80% 增益区间',
                  value: `[${formatNumber(simulationRun.confidenceInterval.low, 2)}, ${formatNumber(simulationRun.confidenceInterval.high, 2)}]`,
                },
                { key: 'MODEL_MISMATCH', value: simulationRun.modelMismatch.status },
              ]}
            />
            <div className="callout" style={{ marginTop: 'var(--space-md)' }}>
              {simulationRun.modelMismatch.note}
            </div>
          </div>
          <div className="card">
            <h3>试学结构（不是“做对一道题”）</h3>
            <ol className="timeline">
              {simulationRun.stages.map((stage) => (
                <li className="timeline-item" key={stage.stage}>
                  <div className="timeline-stage">{stage.stage}</div>
                  <h4>{stage.label}</h4>
                  <p className="small">{stage.detail}</p>
                </li>
              ))}
            </ol>
          </div>
        </div>

        <div className="grid grid-2" style={{ marginTop: 'var(--space-lg)' }}>
          <div className="card">
            <h3>多候选模型的隔离集成（§11.3）</h3>
            <ul className="small muted" style={{ marginBottom: 0 }}>
              {simulationRun.integrationRules.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          </div>
          <div className="card">
            <h3>模拟环境组成（§11.1）</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>组件</th>
                    <th>职责</th>
                    <th>演示值</th>
                  </tr>
                </thead>
                <tbody>
                  {simulationLabComponents.map((component) => (
                    <tr key={component.component}>
                      <td>{component.component}</td>
                      <td className="small muted">{component.purpose}</td>
                      <td className="small">{component.demoValue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="table-wrap" style={{ marginTop: 'var(--space-lg)' }}>
          <table>
            <thead>
              <tr>
                <th>假设</th>
                <th className="num">运行前权重</th>
                <th className="num">前测</th>
                <th className="num">近迁移后测</th>
                <th className="num">增益均值</th>
                <th>不确定性</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {simulationRun.hypothesisResults.map((result) => (
                <tr key={result.hypothesisId}>
                  <td className="mono tiny">{result.hypothesisId}</td>
                  <td className="num">{formatPercent(result.weightBeforeRun, 0)}</td>
                  <td className="num">{formatPercent(result.pretestScore, 0)}</td>
                  <td className="num">{formatPercent(result.posttestScore, 0)}</td>
                  <td className="num">
                    <Meter
                      value={Math.max(0, result.gainMean)}
                      tone={result.gainMean >= 0.3 ? 'green' : 'orange'}
                      label={formatNumber(result.gainMean, 2)}
                    />
                  </td>
                  <td>{result.uncertainty}</td>
                  <td className="small muted">{result.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        eyebrow="规范 §20.1"
        title="关键运行指标（分维度）"
        description="覆盖学生学习、课程同步、认知拟合、习题生成、遗忘模型、基础设施与公平安全；数值均为合成 fixture。"
      >
        <div className="grid grid-2">
          {metricsByDimension.map((dimension) => (
            <div className="card" key={dimension.dimension}>
              <h3>{dimension.dimension}</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>指标</th>
                      <th>值</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dimension.metrics.map((metric) => (
                      <tr key={metric.name}>
                        <td>{metric.name}</td>
                        <td className="mono tiny">{metric.value}</td>
                        <td>
                          {metric.status === 'ok' ? (
                            <Badge tone="success">ok</Badge>
                          ) : metric.status === 'watch' ? (
                            <Badge tone="warning">watch</Badge>
                          ) : (
                            <Badge tone="neutral">证据不足</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section
        eyebrow="规范 §17"
        title="跨学科适配层（结构说明）"
        description="共享认知状态、课程进度、证据日志、虚拟试学与教学调度架构，但不能假设所有学科采用相同的验证器与掌握度模型。"
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>学科</th>
                <th>思维过程重点</th>
                <th>诊断方法</th>
                <th>关键工具与特殊性</th>
                <th>演示状态</th>
              </tr>
            </thead>
            <tbody>
              {crossSubjectAdapters.map((adapter) => (
                <tr key={adapter.subject}>
                  <td>{adapter.subject}</td>
                  <td className="small muted">{adapter.focus}</td>
                  <td className="small muted">{adapter.diagnosis}</td>
                  <td className="small muted">{adapter.tooling}</td>
                  <td>
                    {adapter.demoStatus === 'in_demo' ? (
                      <Badge tone="success">本演示覆盖</Badge>
                    ) : (
                      <Badge tone="neutral">演示范围外</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Notice tone="warning" title="高风险学科安全：">
          {highRiskSafetyNote}
        </Notice>
      </Section>
    </div>
  )
}
