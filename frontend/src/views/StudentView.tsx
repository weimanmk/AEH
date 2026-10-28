import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  DEMO_META,
  allowedKcSets,
  curriculumGateResults,
  exogenousEvents,
  itemStructuredTags,
  kcLabel,
  recommendationAudit,
  studentItems,
} from '../data/synthetic'
import type { StudentItem } from '../data/synthetic'
import { fractionEquals, formatFraction, parseFraction } from '../lib/fractions'
import { Badge, KeyValues, Notice, PageHeader, Section, Tag } from '../components/ui'

interface ObservedAttempt {
  itemId: string
  answerText: string
  correct: boolean
  parseable: boolean
  hintLevel: number
}

interface ItemResult {
  answerText: string
  correct: boolean
  parseable: boolean
  hintLevel: number
}

function grade(item: StudentItem, raw: string): { correct: boolean; parseable: boolean } {
  const parsed = parseFraction(raw)
  if (!parsed) return { correct: false, parseable: false }
  if (item.requireDenominator !== undefined) {
    const correct =
      parsed.d === item.requireDenominator && fractionEquals(item.expected, parsed)
    return { correct, parseable: true }
  }
  return { correct: fractionEquals(item.expected, parsed), parseable: true }
}

/** 展示参考结果：等值分数题按题目要求的分母展示（如 9/12）。 */
function displayAnswer(item: StudentItem): string {
  if (item.requireDenominator !== undefined) {
    const factor = item.requireDenominator / item.expected.d
    if (Number.isInteger(factor)) {
      return `${item.expected.n * factor}/${item.requireDenominator}`
    }
  }
  return formatFraction(item.expected)
}

export default function StudentView() {
  const [index, setIndex] = useState(0)
  const [input, setInput] = useState('')
  const [hintLevel, setHintLevel] = useState(0)
  const [result, setResult] = useState<ItemResult | null>(null)
  const [attempts, setAttempts] = useState<ObservedAttempt[]>([])

  const finished = index >= studentItems.length

  function handleSubmit() {
    if (result || finished) return
    const item = studentItems[index]
    const { correct, parseable } = grade(item, input)
    const answerText = input.trim()
    setResult({ answerText, correct, parseable, hintLevel })
    // 追加式：原始观测不可更改；重做会新增一条事件，而不是覆盖。
    setAttempts((prev) => [
      ...prev,
      { itemId: item.itemId, answerText, correct, parseable, hintLevel },
    ])
  }

  function handleNext() {
    setIndex((prev) => prev + 1)
    setInput('')
    setHintLevel(0)
    setResult(null)
  }

  function handleRedo() {
    setResult(null)
    setInput('')
    setHintLevel(0)
  }

  function handleRestart() {
    setIndex(0)
    setInput('')
    setHintLevel(0)
    setResult(null)
    setAttempts([])
  }

  if (finished) {
    const perItem = studentItems.map((item) => {
      const itemAttempts = attempts.filter((attempt) => attempt.itemId === item.itemId)
      return { item, count: itemAttempts.length, last: itemAttempts[itemAttempts.length - 1] }
    })
    const observedCorrect = perItem.filter((entry) => entry.last?.correct).length

    return (
      <div className="container">
        <PageHeader
          eyebrow="学生答题 · 合成演示"
          title="本轮作答已完成"
          lede="下面只汇总本轮在浏览器内存中观测到的对错，不推断能力、态度或掌握程度。"
        />
        <div className="grid grid-4" style={{ marginBottom: 'var(--space-xl)' }}>
          <div className="stat">
            <div className="stat-label">观测正确（按每题最后一次）</div>
            <div className="stat-value">
              {observedCorrect} / {studentItems.length}
            </div>
            <div className="stat-sub">仅本轮、仅本地内存</div>
          </div>
          <div className="stat">
            <div className="stat-label">记录到的观测尝试</div>
            <div className="stat-value">{attempts.length}</div>
            <div className="stat-sub">含重做产生的追加事件</div>
          </div>
          <div className="stat">
            <div className="stat-label">使用提示次数</div>
            <div className="stat-value">
              {attempts.reduce((sum, attempt) => sum + attempt.hintLevel, 0)}
            </div>
            <div className="stat-sub">hint_level 之和</div>
          </div>
          <div className="stat">
            <div className="stat-label">数据去向</div>
            <div className="stat-value">内存</div>
            <div className="stat-sub">未上传、未写后端</div>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>题项</th>
                <th>知识点</th>
                <th>尝试次数</th>
                <th>最后一次观测</th>
                <th>作答</th>
              </tr>
            </thead>
            <tbody>
              {perItem.map(({ item, count, last }) => (
                <tr key={item.itemId}>
                  <td className="mono">{item.itemId}</td>
                  <td>
                    <div className="chip-row">
                      {item.requiredKcs.map((kc) => (
                        <Tag key={kc} tone="lavender">
                          {kc}
                        </Tag>
                      ))}
                    </div>
                  </td>
                  <td className="num">{count}</td>
                  <td>
                    {last ? (
                      last.correct ? (
                        <Badge tone="success">正确</Badge>
                      ) : (
                        <Badge tone="error">错误</Badge>
                      )
                    ) : (
                      <Badge tone="neutral">未作答</Badge>
                    )}
                  </td>
                  <td className="mono">{last?.answerText ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 'var(--space-lg)' }} className="stack">
          <Notice tone="warning" title="边界说明：">
            你在本页的作答只存在于当前浏览器内存，不会上传，也不会写入教师视图里演示用的合成孪生状态
            <span className="mono"> {DEMO_META.pseudonymousStudentRef}</span>。
          </Notice>
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={handleRestart}>
              重新开始
            </button>
            <Link className="btn btn-secondary" to="/teacher">
              查看教师孪生视图（合成学生）
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const item = studentItems[index]
  const progress = (index / studentItems.length) * 100
  const currentGate = curriculumGateResults.find(
    (gate) => gate.itemId === item.itemId && gate.mode === 'learn',
  )
  const currentTags = itemStructuredTags[item.itemId]
  const failClosedExamples = curriculumGateResults.filter((gate) => gate.failClosed)

  return (
    <div className="container">
      <PageHeader
        eyebrow="学生答题 · 合成演示"
        title="分数合成练习"
        lede="共 3 道题（异分母加法与等值分数）。答完即时给出系统“观测到”的对错，不声称读心。"
      />

      <div style={{ maxWidth: 760 }}>
        <div className="spread small muted" style={{ marginBottom: 6 }}>
          <span>
            第 {index + 1} / {studentItems.length} 题
          </span>
          <span className="mono">{item.itemId}</span>
        </div>
        <div className="progress-track" style={{ marginBottom: 'var(--space-xl)' }}>
          <div className="progress-fill" style={{ width: `${progress}%` }} />
        </div>

        <div className="card card-lg stack">
          <div>
            <div className="chip-row" style={{ marginBottom: 'var(--space-sm)' }}>
              {item.requiredKcs.map((kc) => (
                <Tag key={kc} tone="lavender">
                  {kcLabel(kc)}
                </Tag>
              ))}
            </div>
            <h3 style={{ fontSize: 26 }}>{item.prompt}</h3>
            <p className="small muted" style={{ marginBottom: 0 }}>
              难度 {item.difficulty} · 预计 {item.estimatedMinutes} 分钟 · 来源 {item.source} ·
              许可 {item.license} · 审核 {item.approvalStatus}
            </p>
          </div>

          {hintLevel > 0 ? (
            <Notice tone="synthetic" title={`提示 ${hintLevel}：`}>
              {item.hints[hintLevel - 1]}
            </Notice>
          ) : null}

          <div className="field">
            <label htmlFor="answer">你的答案（用 a/b 或整数，例如 5/12）</label>
            <input
              id="answer"
              className="text-input"
              value={input}
              disabled={result !== null}
              placeholder="在这里输入…"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleSubmit()
              }}
            />
          </div>

          {result ? (
            <div className={`feedback ${result.correct ? 'correct' : 'incorrect'}`}>
              <div className="spread">
                <h4>
                  {result.correct ? '本次观测：正确' : '本次观测：错误'}
                </h4>
                {result.correct ? (
                  <Badge tone="success">observed · independent</Badge>
                ) : (
                  <Badge tone="error">observed · independent</Badge>
                )}
              </div>
              <KeyValues
                items={[
                  { key: '你的作答', value: <span className="mono">{result.answerText || '（空）'}</span> },
                  { key: '参考结果', value: <span className="mono">{displayAnswer(item)}</span> },
                  { key: '过程说明', value: item.answerExplanation },
                  ...(result.parseable
                    ? []
                    : [
                        {
                          key: '格式提示',
                          value: '本次作答无法解析为分数，已按“错误”记录；请使用 a/b 或整数形式。',
                        },
                      ]),
                ]}
              />
              <div className="callout" style={{ marginTop: 'var(--space-md)' }}>
                系统只记录本题的可观察对错与步骤（event_type=INDEPENDENT_ATTEMPT，
                hint_level={result.hintLevel}），不推断你的想法、动机或能力标签。
              </div>
            </div>
          ) : null}

          <div className="row">
            {result ? (
              <>
                <button type="button" className="btn btn-primary" onClick={handleNext}>
                  {index === studentItems.length - 1 ? '查看本轮汇总' : '下一题'}
                </button>
                <button type="button" className="btn btn-secondary" onClick={handleRedo}>
                  重做本题（追加一条观测）
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleSubmit}
                  disabled={input.trim() === ''}
                >
                  提交
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setHintLevel((prev) => Math.min(prev + 1, item.hints.length))}
                  disabled={hintLevel >= item.hints.length}
                >
                  请求提示（hint_level {hintLevel}）
                </button>
              </>
            )}
          </div>
        </div>

        <Section
          eyebrow="记录口径"
          title="这一页会/不会做什么"
          description="对应规范 §5.3「可观察思路表示，而非读心」。"
        >
          <div className="grid grid-2">
            <div className="card">
              <h3>会</h3>
              <ul className="muted">
                <li>记录题项、是否独立完成、hint_level、对错</li>
                <li>把每次作答作为不可更改的追加事件</li>
                <li>用交叉相乘判等，接受 5/12 与 10/24 等值形式</li>
              </ul>
            </div>
            <div className="card">
              <h3>不会</h3>
              <ul className="muted">
                <li>不读取或展示“你心里怎么想”</li>
                <li>不把单题对错贴成能力标签</li>
                <li>不上传数据、不调用任何真实接口</li>
              </ul>
            </div>
          </div>
        </Section>

        <Section
          eyebrow="规范 §4.3"
          title="课程门禁状态（本题 · mode=learn）"
          description="allow(q,u,m) = safety_ok ∧ verified_content ∧ grade_appropriate ∧ required_kcs ⊆ allowed_kcs ∧ no_unapproved_future_method ∧ cognitive_load_within_budget。任一条件不确定或失败即 fail-closed。"
        >
          {currentGate ? (
            <div className="card">
              <div className="spread">
                <h3 style={{ marginBottom: 0 }}>
                  {currentGate.itemLabel} · <span className="mono tiny">{currentGate.itemId}</span>
                </h3>
                <div className="row">
                  <Badge tone={currentGate.allow ? 'success' : 'error'}>
                    {currentGate.allow ? 'allow = true' : 'allow = false'}
                  </Badge>
                  {currentGate.failClosed ? <Badge tone="warning">fail-closed</Badge> : null}
                </div>
              </div>
              <p className="small muted">{currentGate.action}</p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>门禁条件</th>
                      <th>结果</th>
                      <th>说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentGate.checks.map((check) => (
                      <tr key={check.key}>
                        <td>
                          <span className="mono tiny">{check.key}</span>
                          <div>{check.label}</div>
                        </td>
                        <td>
                          {check.pass ? (
                            <Badge tone="success">通过</Badge>
                          ) : (
                            <Badge tone="error">拒绝</Badge>
                          )}
                        </td>
                        <td className="small">{check.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <div className="grid grid-3" style={{ marginTop: 'var(--space-lg)' }}>
            {allowedKcSets.map((set) => (
              <div className="card" key={set.mode}>
                <div className="spread">
                  <h3 style={{ fontSize: 18 }}>{set.label}</h3>
                  <Badge tone={set.mode === 'learn' ? 'lavender' : 'neutral'}>{set.mode}</Badge>
                </div>
                <p className="small muted">{set.rationale}</p>
                <div className="chip-row">
                  {set.allowedKcs.map((kc) => (
                    <Tag key={kc} tone="lavender">
                      {kcLabel(kc)}
                    </Tag>
                  ))}
                  {set.depthLimitedKcs.map((kc) => (
                    <Tag key={kc} tone="orange">
                      {kcLabel(kc)} · 仅概念导入
                    </Tag>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 'var(--space-lg)' }} className="stack">
            <Notice tone="warning" title="fail-closed 示例：">
              演示中两类候选题被拦截：预习模式下发放异分母加法（高阶应用超出预习深度），
              以及发放未教授的分数乘法题。门禁不确定时不放行，改为更安全的题或请确认进度。
            </Notice>
            {failClosedExamples.map((gate) => (
              <div className="card" key={`${gate.itemId}-${gate.mode}`}>
                <div className="spread">
                  <strong>{gate.itemLabel}</strong>
                  <span className="chip-row">
                    <Tag tone="gray">{gate.mode}</Tag>
                    <Badge tone="warning">拒绝发放</Badge>
                  </span>
                </div>
                <p className="small muted" style={{ marginBottom: 0 }}>
                  {gate.action}
                </p>
              </div>
            ))}
          </div>
        </Section>

        <Section
          eyebrow="规范 §3.3 / §20.3"
          title="题目标签与推荐依据"
          description="每道题至少标注结构化字段（Q-matrix、策略、误区目标、验证器、泄露等级等）；学生端只看到一句话解释，详细证据留在教师/研发端。"
        >
          {currentTags ? (
            <div className="grid grid-2">
              <div className="card">
                <h3>结构化标签</h3>
                <KeyValues
                  items={[
                    { key: '学段 / 课程', value: `${currentTags.stage} · ${currentTags.course}` },
                    {
                      key: '课程节点',
                      value: <span className="mono tiny">{currentTags.curriculumNodeIds.join(', ')}</span>,
                    },
                    {
                      key: 'Q-matrix',
                      value: (
                        <span className="mono tiny">
                          {currentTags.qMatrix
                            .map((q) => `${q.kcId}×${q.weight}${q.required ? '（必需）' : ''}`)
                            .join(' · ')}
                        </span>
                      ),
                    },
                    {
                      key: '策略标注',
                      value: <span className="mono tiny">{currentTags.strategyIds.join(', ') || '—'}</span>,
                    },
                    {
                      key: '误区目标',
                      value: (
                        <span className="mono tiny">
                          {currentTags.misconceptionTargets.join(', ') || '—'}
                        </span>
                      ),
                    },
                    { key: '解题步骤', value: `${currentTags.solutionSteps.length} 步（含操作规则与有效性）` },
                    { key: '验证器', value: <span className="mono tiny">{currentTags.verifierType}</span> },
                    { key: '答案 spec', value: <span className="mono tiny">{currentTags.answerSpec}</span> },
                    { key: '提示泄露等级', value: currentTags.hintLeakageLevel },
                    { key: '暴露次数', value: currentTags.exposureCount },
                    { key: '审核状态', value: currentTags.approvalStatus },
                  ]}
                />
              </div>
              <div className="card">
                <h3>为什么现在发这道题？</h3>
                <p className="small">{recommendationAudit.publicExplain}</p>
                <KeyValues
                  items={[
                    {
                      key: '决策 ID',
                      value: <span className="mono tiny">{recommendationAudit.decisionId}</span>,
                    },
                    ...recommendationAudit.detailedQuestions
                      .slice(0, 3)
                      .map((entry) => ({ key: entry.question, value: entry.answer })),
                  ]}
                />
                <div className="callout" style={{ marginTop: 'var(--space-md)' }}>
                  {recommendationAudit.teacherNote}
                </div>
              </div>
            </div>
          ) : null}
          <div style={{ marginTop: 'var(--space-lg)' }}>
            <Notice tone="plain" title="课堂外生事件（§4.4）：">
              {exogenousEvents[0].detail} {exogenousEvents[0].effectOnTwin}
            </Notice>
          </div>
        </Section>
      </div>
    </div>
  )
}
