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
  Tag,
} from '../components/ui'
import {
  buildStudentTwin,
  diagnosisForStudent,
  dueReviewsForTwin,
  gateForItem,
  hypothesisViews,
  latestProgressEntries,
} from '../lib/behavior'
import type { DiagnosisView, DueReviewView } from '../lib/behavior'
import {
  addProgress,
  addStudent,
  deleteProgress,
  deleteStudent,
  recordReview,
  updateStudent,
} from '../lib/store'
import { useStore } from '../store/useStore'
import {
  OBSERVED_SOURCES,
  OBSERVED_SOURCE_LABEL,
  PROGRESS_STATUS_LABEL,
  consentFor,
  studentProgress,
  studentReviews,
} from '../lib/model'
import type {
  AppStore,
  ObservedSource,
  ProgressStatus,
} from '../lib/model'
import { daysLabel, formatDateTime, percent } from '../lib/format'

const STATUS_TONE: Readonly<Record<ProgressStatus, 'lavender' | 'orange' | 'green'>> =
  {
    taught: 'lavender',
    in_progress: 'orange',
    confirmed: 'green',
  }

function studentLabel(store: AppStore, ref: string): string {
  return store.students.find((student) => student.ref === ref)?.ref ?? ref
}

function kcName(store: AppStore, kcId: string): string {
  return store.kcs.find((kc) => kc.id === kcId)?.label ?? kcId
}

function actionMessage(
  result: { ok: boolean; error?: string },
  success: string,
): { ok: boolean; text: string } {
  return result.ok
    ? { ok: true, text: success }
    : { ok: false, text: result.error ?? '操作失败' }
}

function GatePanel({
  store,
  studentRef,
}: {
  store: AppStore
  studentRef: string
}) {
  const firstItem = store.items[0]?.id ?? ''
  const [itemId, setItemId] = useState(firstItem)
  const [mode, setMode] = useState<'learn' | 'preview' | 'review'>('learn')
  const effectiveItemId = store.items.some((item) => item.id === itemId)
    ? itemId
    : firstItem
  const effectiveMode = mode
  const result = gateForItem(store, studentRef, effectiveItemId, effectiveMode)

  const untaught = useMemo(() => {
    const progress = store.progress.find((group) => group.studentRef === studentRef)
    const known = new Set(
      latestProgressEntries(progress?.entries ?? []).map((entry) => entry.kcId),
    )
    return (
      store.items.find((item) =>
        item.requiredKcs.some((kcId) => !known.has(kcId)),
      ) ?? null
    )
  }, [store, studentRef])

  return (
    <div className="stack">
      <div className="form-grid">
        <div className="field">
          <label htmlFor="gate-item">要请求的内容（题目）</label>
          <select
            id="gate-item"
            className="text-input"
            value={effectiveItemId}
            onChange={(event) => setItemId(event.target.value)}
            disabled={store.items.length === 0}
          >
            {store.items.length === 0 ? <option value="">题库为空</option> : null}
            {store.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.prompt.slice(0, 28)}
                {item.prompt.length > 28 ? '…' : ''} · 难度 {item.difficulty}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="gate-mode">场景模式</label>
          <select
            id="gate-mode"
            className="text-input"
            value={mode}
            onChange={(event) =>
              setMode(event.target.value as 'learn' | 'preview' | 'review')
            }
          >
            <option value="learn">learn（同步学习）</option>
            <option value="preview">preview（预习）</option>
            <option value="review">review（复习）</option>
          </select>
        </div>
        <div className="field field-action">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={untaught === null}
            onClick={() => {
              if (untaught !== null) setItemId(untaught.id)
            }}
          >
            选一道含未授 KC 的题
          </button>
        </div>
      </div>

      {result === null ? (
        <Notice tone="warning" title="无法判断：">
          题库为空或题目已不存在。门禁在没有可验证内容时 fail-closed，不会放行。
        </Notice>
      ) : (
        <div className={`card ${result.decision.allowed ? '' : 'card-quiet'}`}>
          <div className="spread">
            <div>
              <h3 style={{ marginBottom: 4 }}>{result.item.prompt}</h3>
              <div className="chip-row">
                {result.item.requiredKcs.map((kcId) => (
                  <Tag key={kcId} tone="lavender">
                    {kcName(store, kcId)}
                  </Tag>
                ))}
              </div>
            </div>
            <div className="chip-row">
              <Badge tone={result.decision.allowed ? 'success' : 'error'}>
                {result.decision.allowed ? '门禁放行' : '门禁拒绝（fail-closed）'}
              </Badge>
              <Tag tone="gray">{result.decision.mode}</Tag>
            </div>
          </div>
          <KeyValues
            items={[
              {
                key: '拒绝/放行原因',
                value:
                  result.decision.reasons.length === 0 ? (
                    <span className="muted">所有检查项通过</span>
                  ) : (
                    <ul style={{ margin: 0 }}>
                      {result.decision.reasons.map((reason) => (
                        <li key={reason}>
                          <span className="mono tiny">{reason}</span>
                        </li>
                      ))}
                    </ul>
                  ),
              },
              {
                key: '当前允许的 KC',
                value: (
                  <div className="chip-row">
                    {result.decision.allowedKcs.length === 0 ? (
                      <span className="muted">无</span>
                    ) : (
                      result.decision.allowedKcs.map((kcId) => (
                        <Tag key={kcId} tone="gray">
                          {kcName(store, kcId)}
                        </Tag>
                      ))
                    )}
                  </div>
                ),
              },
            ]}
          />
        </div>
      )}

      <Notice tone="plain" title="门禁口径：">
        `allow(item, progress, mode)` 要求安全、内容已验证、年级合适、必需 KC 全部在允许集合内、
        无未批准的未来方法、认知负荷不超预算；任一条件缺失或不确定即拒绝，不存在前端覆盖开关。
      </Notice>
    </div>
  )
}

function DiagnosisPanel({
  store,
  studentRef,
  diagnosis,
}: {
  store: AppStore
  studentRef: string
  diagnosis: DiagnosisView
}) {
  const [showAll, setShowAll] = useState(false)
  const allowed = diagnosis.candidates.filter(
    (candidate) => candidate.decision.allowed,
  )
  const defaultVisible = allowed.slice(0, 5)
  const visible = showAll ? diagnosis.candidates : defaultVisible

  return (
    <div className="stack">
      {diagnosis.best === null ? (
        <Notice tone="warning" title="当前没有可执行的 probe：">
          不是所有题目都能用于诊断。只有通过课程门禁的候选才会进入
          `selectProbe`；请先补充已授进度或题库覆盖。
        </Notice>
      ) : (
        <div className="card">
          <div className="spread">
            <div>
              <div className="eyebrow">最佳 probe · 由 diagnosis.ts 选出</div>
              <h3 style={{ marginBottom: 4 }}>{diagnosis.best.item.prompt}</h3>
              <p className="small muted" style={{ marginBottom: 0 }}>
                {diagnosis.best.item.requiredKcs
                  .map((kcId) => kcName(store, kcId))
                  .join(' · ')}
              </p>
            </div>
            <Badge tone="success">score {diagnosis.best.selection.score.toFixed(3)}</Badge>
          </div>
          <div className="grid grid-3" style={{ marginTop: 'var(--space-md)' }}>
            <Stat
              label="期望信息增益"
              value={diagnosis.best.selection.informationGain.toFixed(3)}
              sub="相对当前假设权重"
            />
            <Stat
              label="教学价值 / 风险"
              value={`${diagnosis.best.selection.teachingValue.toFixed(2)} / ${diagnosis.best.selection.riskPenalty.toFixed(2)}`}
              sub="来自候选输入"
            />
            <Stat
              label="用时 / 认知负荷"
              value={`${diagnosis.best.selection.timePenalty.toFixed(0)} 分 / ${diagnosis.best.selection.loadPenalty.toFixed(1)}`}
              sub="越低越优先"
            />
          </div>
          <div className="callout" style={{ marginTop: 'var(--space-md)' }}>
            选择理由：{diagnosis.best.selection.reasons.length > 0
              ? diagnosis.best.selection.reasons.join('、')
              : '通过门禁，且在信息增益、教学价值、用时、风险与认知负荷的加权目标下得分最高。'}
            这是“下一个最值得问的题”，不是对能力或态度的判断。
          </div>
        </div>
      )}

      {visible.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>候选题目</th>
                <th>必需 KC</th>
                <th className="num">score</th>
                <th className="num">信息增益</th>
                <th>门禁</th>
                <th>理由</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((candidate) => (
                <tr key={candidate.item.id}>
                  <td>{candidate.item.prompt}</td>
                  <td>
                    <span className="mono tiny">
                      {candidate.item.requiredKcs.join(', ')}
                    </span>
                  </td>
                  <td className="num">
                    {candidate.decision.allowed
                      ? candidate.selection.score.toFixed(3)
                      : '—'}
                  </td>
                  <td className="num">
                    {candidate.decision.allowed
                      ? candidate.selection.informationGain.toFixed(3)
                      : '—'}
                  </td>
                  <td>
                    {candidate.decision.allowed ? (
                      <Badge tone="success">允许</Badge>
                    ) : (
                      <Badge tone="error">拒绝</Badge>
                    )}
                  </td>
                  <td className="small">
                    {candidate.decision.allowed
                      ? 'pass'
                      : (candidate.decision.reasons.join('、') || 'gate_rejected')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {diagnosis.candidates.length > defaultVisible.length ? (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? '只看通过门禁的候选' : `查看全部候选（含被拒，${diagnosis.candidates.length}）`}
        </button>
      ) : null}

      <p className="tiny muted" style={{ marginBottom: 0 }}>
        学生代号：{studentLabel(store, studentRef)} · 候选数量 {diagnosis.candidates.length}{' '}
        · 通过门禁 {allowed.length}。诊断不强制，学生可跳过。
      </p>
    </div>
  )
}

export default function StudentView() {
  const store = useStore()
  const [selectedRef, setSelectedRef] = useState<string | null>(
    store.students[0]?.ref ?? null,
  )
  const [refInput, setRefInput] = useState('')
  const [gradeInput, setGradeInput] = useState('5')
  const [editingRef, setEditingRef] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(
    null,
  )

  const [progressKc, setProgressKc] = useState('')
  const [progressStatus, setProgressStatus] = useState<ProgressStatus>('taught')
  const [progressSource, setProgressSource] =
    useState<ObservedSource>('observed_teacher')
  const [progressNote, setProgressNote] = useState('')

  const [reviewKc, setReviewKc] = useState('')
  const [reviewSuccess, setReviewSuccess] = useState(true)
  const [reviewIndependent, setReviewIndependent] = useState(true)
  const [reviewHint, setReviewHint] = useState('0')

  const selected =
    store.students.find((student) => student.ref === selectedRef) ??
    store.students[0] ??
    null
  const effectiveRef = selected?.ref ?? null
  const now = useMemo(
    () => new Date().toISOString(),
    // 时间只在数据或学生切换时取一次，避免每次输入都重算到期队列。
    [store, effectiveRef],
  )

  const view = useMemo(() => {
    if (effectiveRef === null) return null
    return buildStudentTwin(store, effectiveRef, now)
  }, [store, effectiveRef, now])

  const due = useMemo(
    () => (view === null ? [] : dueReviewsForTwin(view.twin, now)),
    [view, now],
  )

  const diagnosis = useMemo(() => {
    if (effectiveRef === null || view === null) return null
    return diagnosisForStudent(store, effectiveRef, view)
  }, [store, effectiveRef, view])

  const hypotheses = useMemo(
    () => (view === null ? [] : hypothesisViews(view)),
    [view],
  )

  const entries =
    effectiveRef === null ? [] : studentProgress(store, effectiveRef)
  const latest = latestProgressEntries(entries)
  const reviews =
    effectiveRef === null ? [] : studentReviews(store, effectiveRef)
  const consent = effectiveRef === null ? undefined : consentFor(store, effectiveRef)

  const counts = {
    taught: latest.filter((entry) => entry.status === 'taught').length,
    in_progress: latest.filter((entry) => entry.status === 'in_progress').length,
    confirmed: latest.filter((entry) => entry.status === 'confirmed').length,
  }

  const memoryKcs = view === null ? [] : [...view.twin.state.memory.keys()]
  const dueIds = new Set(due.map((entry) => entry.kcId))
  const effectiveReviewKc =
    dueIds.has(reviewKc) || memoryKcs.includes(reviewKc)
      ? reviewKc
      : (due[0]?.kcId ?? memoryKcs[0] ?? '')
  const effectiveProgressKc = store.kcs.some((kc) => kc.id === progressKc)
    ? progressKc
    : (store.kcs[0]?.id ?? '')

  const resetStudentForm = () => {
    setRefInput('')
    setGradeInput('5')
    setEditingRef(null)
  }

  const handleAddOrUpdate = () => {
    const grade = Number.parseInt(gradeInput, 10)
    const result =
      editingRef === null
        ? addStudent(refInput, grade)
        : updateStudent(editingRef, refInput, grade)
    setFeedback(
      actionMessage(
        result,
        editingRef === null ? `已新增学生 ${refInput.trim()}` : `已更新学生 ${refInput.trim()}`,
      ),
    )
    if (result.ok) {
      setSelectedRef(result.value.ref)
      resetStudentForm()
    }
  }

  const selectedIsGap =
    effectiveRef !== null &&
    latest.some((entry) => entry.status === 'in_progress')

  return (
    <div>
      <PageHeader
        eyebrow="学生 · 真实核心"
        title="学生进度、复习、诊断与门禁"
        lede="所有掌握度只来自你录入的 observed 观察；复习时间由 memory.ts 的 FSRS 排程重算；诊断与门禁直接调用 dsh-plugin 的核心。"
        actions={
          <Link className="btn btn-secondary" to="/teacher">
            去课程与题库
          </Link>
        }
      />

      <Section
        eyebrow="学生管理"
        title="本地代号 + 年级"
        description="不收集真实姓名、账号或照片；删除学生会同时删除其进度、复习、同意与已准备干预。"
      >
        <div className="grid grid-2">
          <div className="card stack">
            <h3>{editingRef === null ? '新增学生' : `编辑 ${editingRef}`}</h3>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="student-ref">本地代号</label>
                <input
                  id="student-ref"
                  className="text-input"
                  value={refInput}
                  placeholder="例如 stu_local_01"
                  onChange={(event) => setRefInput(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="student-grade">年级（1–13）</label>
                <input
                  id="student-grade"
                  className="text-input"
                  type="number"
                  min={1}
                  max={13}
                  step={1}
                  value={gradeInput}
                  onChange={(event) => setGradeInput(event.target.value)}
                />
              </div>
              <div className="field field-action">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleAddOrUpdate}
                >
                  {editingRef === null ? '新增学生' : '保存修改'}
                </button>
                {editingRef !== null ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={resetStudentForm}
                  >
                    取消编辑
                  </button>
                ) : null}
              </div>
            </div>
            {feedback ? (
              <Notice tone={feedback.ok ? 'success' : 'warning'}>
                {feedback.text}
              </Notice>
            ) : null}
          </div>

          <div className="card stack">
            <div className="field">
              <label htmlFor="student-select">当前选中的学生</label>
              <select
                id="student-select"
                className="text-input"
                value={effectiveRef ?? ''}
                onChange={(event) => {
                  setSelectedRef(event.target.value || null)
                  setFeedback(null)
                }}
                disabled={store.students.length === 0}
              >
                {store.students.length === 0 ? (
                  <option value="">还没有学生</option>
                ) : null}
                {store.students.map((student) => (
                  <option key={student.ref} value={student.ref}>
                    {student.ref} · {student.grade} 年级
                    {student.synthetic ? ' · 合成数据示例' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="row">
              {selected ? (
                <>
                  <Badge tone={selected.synthetic ? 'warning' : 'success'}>
                    {selected.synthetic ? '合成数据示例' : '本地录入'}
                  </Badge>
                  <span className="small muted">
                    同意：{consent?.granted ? '已授予' : '未授予/已撤销'}
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setEditingRef(selected.ref)
                      setRefInput(selected.ref)
                      setGradeInput(String(selected.grade))
                    }}
                  >
                    编辑此学生
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      if (
                        !window.confirm(
                          `删除学生 ${selected.ref} 及其全部进度/复习/同意记录？此操作不可撤销。`,
                        )
                      ) {
                        return
                      }
                      const result = deleteStudent(selected.ref)
                      setFeedback(actionMessage(result, `已删除 ${selected.ref}`))
                      if (result.ok) {
                        setSelectedRef(
                          store.students.find(
                            (student) => student.ref !== selected.ref,
                          )?.ref ?? null,
                        )
                        resetStudentForm()
                      }
                    }}
                  >
                    删除学生
                  </button>
                </>
              ) : (
                <span className="muted">先新增一名学生，或在首页恢复预置示例。</span>
              )}
            </div>
            <p className="tiny muted" style={{ marginBottom: 0 }}>
              当前共 {store.students.length} 名学生。选中学生后，下方所有面板都只针对该学生。
            </p>
          </div>
        </div>
      </Section>

      {selected === null || view === null ? (
        <Notice tone="plain" title="没有选中学生：">
          新增学生后即可录入 observed 进度、查看复习队列、运行诊断与门禁。
        </Notice>
      ) : (
        <>
          <Section
            eyebrow={`学生 ${selected.ref} · ${selected.grade} 年级`}
            title="进度面板"
            description="同一知识点只取最后一次 observed 记录；课堂“讲过”不等于掌握，未确认的进度不会解锁后续内容。"
          >
            <div className="grid grid-4">
              <Stat label="已授" value={counts.taught} sub="taught，仅表示接触过" />
              <Stat label="进行中" value={counts.in_progress} sub="in_progress" />
              <Stat label="已确认" value={counts.confirmed} sub="confirmed，先修确认" />
              <Stat
                label="有记忆状态的 KC"
                value={view.twin.state.memory.size}
                sub="来自 observed 复习"
              />
            </div>

            <div className="grid grid-2" style={{ marginTop: 'var(--space-lg)' }}>
              <div className="card stack">
                <h3>录入一条 observed 进度</h3>
                <div className="form-grid">
                  <div className="field">
                    <label htmlFor="progress-kc">知识点</label>
                    <select
                      id="progress-kc"
                      className="text-input"
                      value={effectiveProgressKc}
                      onChange={(event) => setProgressKc(event.target.value)}
                      disabled={store.kcs.length === 0}
                    >
                      {store.kcs.length === 0 ? (
                        <option value="">还没有知识点</option>
                      ) : null}
                      {store.kcs.map((kc) => (
                        <option key={kc.id} value={kc.id}>
                          {kc.label}（{kc.id}）
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="progress-status">状态</label>
                    <select
                      id="progress-status"
                      className="text-input"
                      value={progressStatus}
                      onChange={(event) =>
                        setProgressStatus(event.target.value as ProgressStatus)
                      }
                    >
                      <option value="taught">已授（taught）</option>
                      <option value="in_progress">进行中（in_progress）</option>
                      <option value="confirmed">已确认（confirmed）</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="progress-source">观察来源</label>
                    <select
                      id="progress-source"
                      className="text-input"
                      value={progressSource}
                      onChange={(event) =>
                        setProgressSource(event.target.value as ObservedSource)
                      }
                    >
                      {OBSERVED_SOURCES.map((source) => (
                        <option key={source} value={source}>
                          {OBSERVED_SOURCE_LABEL[source]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="progress-note">来源备注（必填）</label>
                    <textarea
                      id="progress-note"
                      className="text-input text-area"
                      rows={3}
                      value={progressNote}
                      placeholder="例：10/28 课堂练习第 3 题独立完成，教师观察到通分步骤正确"
                      onChange={(event) => setProgressNote(event.target.value)}
                    />
                  </div>
                </div>
                <div className="row">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={store.kcs.length === 0}
                    onClick={() => {
                      if (effectiveRef === null) return
                      const result = addProgress(effectiveRef, {
                        kcId: effectiveProgressKc,
                        status: progressStatus,
                        source: progressSource,
                        note: progressNote,
                      })
                      setFeedback(
                        actionMessage(
                          result,
                          `已记录 ${kcName(store, effectiveProgressKc)} 的 observed 进度`,
                        ),
                      )
                      if (result.ok) setProgressNote('')
                    }}
                  >
                    记录进度
                  </button>
                  <span className="tiny muted">
                    只接受 observed_*；没有 simulated_* 写入口。
                  </span>
                </div>
              </div>

              <div className="card stack">
                <div className="spread">
                  <h3 style={{ marginBottom: 0 }}>当前知识点状态</h3>
                  <Badge tone="neutral">{latest.length} 个 KC</Badge>
                </div>
                {latest.length === 0 ? (
                  <p className="muted small" style={{ marginBottom: 0 }}>
                    还没有任何 observed 进度。未观测不等于未掌握，系统会保留未知。
                  </p>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>知识点</th>
                          <th>状态</th>
                          <th>来源 / 备注</th>
                          <th>观察时间</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {latest.map((entry) => (
                          <tr key={entry.id}>
                            <td>
                              {kcName(store, entry.kcId)}
                              <div className="mono tiny muted">{entry.kcId}</div>
                            </td>
                            <td>
                              <Tag tone={STATUS_TONE[entry.status]}>
                                {PROGRESS_STATUS_LABEL[entry.status]}
                              </Tag>
                              {entry.synthetic ? (
                                <div>
                                  <Badge tone="warning">合成数据示例</Badge>
                                </div>
                              ) : null}
                            </td>
                            <td className="small">
                              {OBSERVED_SOURCE_LABEL[entry.source]}
                              <div className="muted">{entry.note}</div>
                            </td>
                            <td className="small nowrap">
                              {formatDateTime(entry.observedAt)}
                            </td>
                            <td>
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() => {
                                  if (effectiveRef === null) return
                                  const result = deleteProgress(
                                    effectiveRef,
                                    entry.id,
                                  )
                                  setFeedback(
                                    actionMessage(result, '已删除这条进度记录'),
                                  )
                                }}
                              >
                                删除
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </Section>

          <Section
            eyebrow="FSRS 排程 · memory.ts"
            title={`复习队列（${due.length} 项到期）`}
            description="到期时间由真实记忆状态与目标保持率 0.9 反解；完成一次复习会写入 observed_review 并立即重算下次时间。"
          >
            <div className="grid grid-3" style={{ marginBottom: 'var(--space-lg)' }}>
              <Stat
                label="到期 / 逾期"
                value={due.length}
                sub={`逾期 ${due.filter((entry: DueReviewView) => entry.overdueDays > 0).length} 项`}
              />
              <Stat
                label="记忆单元"
                value={view.twin.state.memory.size}
                sub="每个 KC 独立状态"
              />
              <Stat
                label="已有复习记录"
                value={reviews.length}
                sub="原始观测不可覆盖"
              />
            </div>

            {due.length === 0 ? (
              <Notice tone="plain" title="当前没有到期项：">
                这不是“已掌握”的证明，只表示按当前记忆状态还没有到目标保持率以下的复习。
              </Notice>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>知识点</th>
                      <th>到期时间</th>
                      <th className="num">逾期天数</th>
                      <th className="num">预计可提取性</th>
                      <th className="num">稳定度 / 难度</th>
                      <th>上次观测</th>
                    </tr>
                  </thead>
                  <tbody>
                    {due.map((entry) => (
                      <tr key={entry.kcId}>
                        <td>{kcName(store, entry.kcId)}</td>
                        <td className="small nowrap">{formatDateTime(entry.dueAt)}</td>
                        <td className="num">
                          {entry.overdueDays < 1
                            ? entry.overdueDays.toFixed(2)
                            : entry.overdueDays.toFixed(1)}
                        </td>
                        <td className="num">
                          {percent(entry.expectedRetrievability, 1)}
                        </td>
                        <td className="num small">
                          {daysLabel(entry.stabilityDays)} / {entry.difficulty.toFixed(1)}
                        </td>
                        <td className="small nowrap">
                          {formatDateTime(entry.lastObservedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="grid grid-2" style={{ marginTop: 'var(--space-lg)' }}>
              <div className="card stack">
                <h3>完成一次复习</h3>
                <p className="small muted" style={{ marginBottom: 0 }}>
                  只记录这次真正观测到的结果；“提示后改对”不等于独立检索成功。
                </p>
                <div className="form-grid">
                  <div className="field">
                    <label htmlFor="review-kc">知识点</label>
                    <select
                      id="review-kc"
                      className="text-input"
                      value={effectiveReviewKc}
                      onChange={(event) => setReviewKc(event.target.value)}
                      disabled={memoryKcs.length === 0}
                    >
                      {memoryKcs.length === 0 ? (
                        <option value="">还没有记忆状态</option>
                      ) : null}
                      {memoryKcs.map((kcId) => (
                        <option key={kcId} value={kcId}>
                          {kcName(store, kcId)}
                          {dueIds.has(kcId) ? ' · 到期' : ' · 提前复习'}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="review-hint">提示等级（0–3）</label>
                    <select
                      id="review-hint"
                      className="text-input"
                      value={reviewHint}
                      onChange={(event) => setReviewHint(event.target.value)}
                    >
                      <option value="0">0 · 无提示</option>
                      <option value="1">1 · 最小提示</option>
                      <option value="2">2 · 概念提示</option>
                      <option value="3">3 · 局部示范</option>
                    </select>
                  </div>
                </div>
                <div className="row">
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={reviewSuccess}
                      onChange={(event) => setReviewSuccess(event.target.checked)}
                    />
                    本次回忆成功
                  </label>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={reviewIndependent}
                      onChange={(event) =>
                        setReviewIndependent(event.target.checked)
                      }
                    />
                    独立完成（未看答案/讲解）
                  </label>
                </div>
                <div className="row">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={effectiveReviewKc === ''}
                    onClick={() => {
                      if (effectiveRef === null || effectiveReviewKc === '') return
                      const result = recordReview({
                        studentRef: effectiveRef,
                        kcId: effectiveReviewKc,
                        itemId:
                          store.items.find((item) =>
                            item.requiredKcs.includes(effectiveReviewKc),
                          )?.id ?? null,
                        success: reviewSuccess,
                        independent: reviewIndependent,
                        hintLevel: Number.parseInt(reviewHint, 10),
                      })
                      setFeedback(
                        actionMessage(
                          result,
                          result.ok
                            ? `已记录复习：下次到期 ${formatDateTime(result.value.nextDueAt)}（间隔 ${daysLabel(result.value.nextIntervalDays)}）`
                            : '记录复习失败',
                        ),
                      )
                    }}
                  >
                    记录本次复习并重算
                  </button>
                  <Meter
                    value={
                      due.length === 0
                        ? 1
                        : Math.max(0, 1 - due.length / Math.max(1, memoryKcs.length))
                    }
                    tone="green"
                    label="队列完成度（示意，仅用于本页）"
                  />
                </div>
              </div>

              <div className="card stack">
                <h3>最近复习观测</h3>
                {reviews.length === 0 ? (
                  <p className="small muted" style={{ marginBottom: 0 }}>
                    还没有复习记录。完成一次复习后，原始观测会保留并显示 FSRS 重算结果。
                  </p>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>知识点</th>
                          <th>结果</th>
                          <th>下次到期</th>
                          <th className="num">间隔</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reviews
                          .slice(-6)
                          .reverse()
                          .map((review) => (
                            <tr key={review.id}>
                              <td>
                                {kcName(store, review.kcId)}
                                {review.synthetic ? (
                                  <div>
                                    <Badge tone="warning">合成数据示例</Badge>
                                  </div>
                                ) : null}
                              </td>
                              <td>
                                <Badge
                                  tone={review.success ? 'success' : 'error'}
                                >
                                  {review.success ? '成功' : '未成功'}
                                </Badge>
                                <div className="tiny muted">
                                  hint {review.hintLevel} ·{' '}
                                  {review.independent ? '独立' : '非独立'}
                                </div>
                              </td>
                              <td className="small nowrap">
                                {formatDateTime(review.nextDueAt)}
                              </td>
                              <td className="num">
                                {daysLabel(review.nextIntervalDays)}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </Section>

          <Section
            eyebrow="diagnosis.ts"
            title="诊断：下一个最值得问的 probe"
            description="基于当前 observed 证据与假设权重选择 probe；只展示候选与理由，不把推断写成事实。"
          >
            {diagnosis === null ? null : (
              <DiagnosisPanel
                store={store}
                studentRef={selected.ref}
                diagnosis={diagnosis}
              />
            )}
          </Section>

          <Section
            eyebrow="curriculum-gate.ts"
            title="课程门禁：请求内容前先验证"
            description="选一道题与场景，直接调用真实 allow()。含未授 KC、低置信度或未批准方法的内容会被拒绝并给出机器可读原因。"
          >
            <GatePanel store={store} studentRef={selected.ref} />
          </Section>

          <Section
            eyebrow="hypothesis.ts · 假设 / 推测"
            title="假设面板（不是事实）"
            description="这些是按当前证据维护的候选解释，带权重与不确定性；它们只用于选择下一步 probe，不得写进学生档案当结论。"
          >
            <Notice tone="warning" title="阅读边界：">
              以下全部是“假设/推测”。权重高只表示“在当前证据下更值得检验”，
              不表示学生真的存在该缺口或失误。撤销证据或新增观测后应重新评估。
            </Notice>
            {hypotheses.length === 0 ? (
              <p className="small muted">当前没有可展示的假设。</p>
            ) : (
              <div className="grid grid-2" style={{ marginTop: 'var(--space-md)' }}>
                {hypotheses.map((hypothesis) => (
                  <div className="card" key={hypothesis.hypothesisId}>
                    <div className="spread">
                      <Badge tone={hypothesis.isUnknown ? 'neutral' : 'lavender'}>
                        {hypothesis.isUnknown ? '未知 / 证据不足' : '假设 / 推测'}
                      </Badge>
                      <span className="mono tiny">{hypothesis.hypothesisId}</span>
                    </div>
                    <h3 style={{ marginTop: 'var(--space-sm)' }}>
                      {hypothesis.label}
                    </h3>
                    <Meter
                      value={hypothesis.weight}
                      tone={hypothesis.isUnknown ? 'navy' : 'orange'}
                      label={`权重 ${percent(hypothesis.weight, 1)} · 不确定性 ${hypothesis.uncertainty} · 证据 ${hypothesis.evidenceCount} 条`}
                    />
                    <p className="small muted" style={{ marginTop: 'var(--space-sm)', marginBottom: 0 }}>
                      {hypothesis.description}
                    </p>
                  </div>
                ))}
              </div>
            )}
            {selectedIsGap ? (
              <p className="tiny muted" style={{ marginTop: 'var(--space-md)' }}>
                该学生有进行中的知识点；诊断会优先选择能区分“概念缺口”与“偶发失误”的题，
                而不是直接断言缺口。
              </p>
            ) : null}
          </Section>
        </>
      )}
    </div>
  )
}
