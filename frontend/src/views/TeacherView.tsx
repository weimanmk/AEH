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
  addEdge,
  addItem,
  addKc,
  deleteEdge,
  deleteItem,
  deleteKc,
  prepareIntervention,
  updateItem,
  validateGraph,
} from '../lib/store'
import { strategyForKc } from '../lib/behavior'
import { useStore } from '../store/useStore'
import type { Item, Kc } from '../lib/model'
import { formatDateTime } from '../lib/format'

type Feedback = { readonly ok: boolean; readonly text: string }

function resultFeedback(
  result: { ok: boolean; error?: string },
  success: string,
): Feedback {
  return result.ok
    ? { ok: true, text: success }
    : { ok: false, text: result.error ?? '操作失败' }
}

function kcLabel(kcs: readonly Kc[], kcId: string): string {
  return kcs.find((kc) => kc.id === kcId)?.label ?? kcId
}

function FeedbackNotice({ feedback }: { feedback: Feedback | null }) {
  if (feedback === null) return null
  return (
    <Notice
      tone={feedback.ok ? 'success' : 'warning'}
      title={feedback.ok ? '完成：' : '未完成：'}
    >
      {feedback.text}
    </Notice>
  )
}

type ItemForm = {
  prompt: string
  requiredKcs: string[]
  difficulty: string
  gradeLevel: string
  estimatedMinutes: string
  cognitiveLoad: string
  hints: string
  answerExplanation: string
}

const EMPTY_ITEM_FORM: ItemForm = {
  prompt: '',
  requiredKcs: [],
  difficulty: '2',
  gradeLevel: '5',
  estimatedMinutes: '5',
  cognitiveLoad: '4',
  hints: '',
  answerExplanation: '',
}

function itemToForm(item: Item): ItemForm {
  return {
    prompt: item.prompt,
    requiredKcs: [...item.requiredKcs],
    difficulty: String(item.difficulty),
    gradeLevel: String(item.gradeLevel),
    estimatedMinutes: String(item.estimatedMinutes),
    cognitiveLoad: String(item.cognitiveLoad),
    hints: item.hints.join('\n'),
    answerExplanation: item.answerExplanation,
  }
}

function GraphSection() {
  const store = useStore()
  const [kcId, setKcId] = useState('')
  const [label, setLabel] = useState('')
  const [stage, setStage] = useState('')
  const [nodeType, setNodeType] = useState<Kc['nodeType']>('knowledge_component')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  const graphState = useMemo(
    () => validateGraph(store.kcs, store.edges),
    [store.kcs, store.edges],
  )
  const effectiveFrom = store.kcs.some((kc) => kc.id === from)
    ? from
    : (store.kcs[0]?.id ?? '')
  const effectiveTo = store.kcs.some((kc) => kc.id === to)
    ? to
    : (store.kcs[1]?.id ?? store.kcs[0]?.id ?? '')

  return (
    <Section
      eyebrow="课程图谱 · curriculum-graph.ts"
      title="知识点与先修关系"
      description="每次新增边都会重建真实 KnowledgeGraph；已批准 REQUIRES 关系成环时由图谱代码拒绝，不会写入 store。"
    >
      <div className="grid grid-2">
        <div className="card stack">
          <div className="spread">
            <h3 style={{ marginBottom: 0 }}>新增知识点</h3>
            <Badge tone={graphState.ok ? 'success' : 'error'}>
              {graphState.ok ? '图校验通过' : '图校验失败'}
            </Badge>
          </div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="kc-id">知识点 ID</label>
              <input
                id="kc-id"
                className="text-input"
                value={kcId}
                placeholder="kc.fraction.simplify"
                onChange={(event) => setKcId(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="kc-label">名称</label>
              <input
                id="kc-label"
                className="text-input"
                value={label}
                placeholder="约分"
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="kc-stage">学段 / 单元</label>
              <input
                id="kc-stage"
                className="text-input"
                value={stage}
                placeholder="小学五年级 · 分数"
                onChange={(event) => setStage(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="kc-node-type">节点类型</label>
              <select
                id="kc-node-type"
                className="text-input"
                value={nodeType}
                onChange={(event) =>
                  setNodeType(event.target.value as Kc['nodeType'])
                }
              >
                <option value="knowledge_component">
                  知识点（knowledge_component）
                </option>
                <option value="subskill">子技能（subskill）</option>
              </select>
            </div>
          </div>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                const result = addKc({ id: kcId, label, stage, nodeType })
                setFeedback(
                  resultFeedback(
                    result,
                    `已新增知识点 ${result.ok ? result.value.id : ''}`,
                  ),
                )
                if (result.ok) {
                  setKcId('')
                  setLabel('')
                  setStage('')
                }
              }}
            >
              新增知识点
            </button>
          </div>
          <FeedbackNotice feedback={feedback} />
          {!graphState.ok ? (
            <Notice tone="warning" title="当前图谱不可用：">
              {graphState.error}
            </Notice>
          ) : null}
        </div>

        <div className="card stack">
          <h3>新增先修边</h3>
          <p className="small muted" style={{ marginBottom: 0 }}>
            方向：<strong>依赖方（后学）→ 先修方（先学）</strong>
            。例如“异分母加法依赖等值分数”。
          </p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="edge-from">依赖方（后学）</label>
              <select
                id="edge-from"
                className="text-input"
                value={effectiveFrom}
                onChange={(event) => setFrom(event.target.value)}
                disabled={store.kcs.length < 2}
              >
                {store.kcs.map((kc) => (
                  <option key={kc.id} value={kc.id}>
                    {kc.label}（{kc.id}）
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="edge-to">先修方（先学）</label>
              <select
                id="edge-to"
                className="text-input"
                value={effectiveTo}
                onChange={(event) => setTo(event.target.value)}
                disabled={store.kcs.length < 2}
              >
                {store.kcs.map((kc) => (
                  <option key={kc.id} value={kc.id}>
                    {kc.label}（{kc.id}）
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={store.kcs.length < 2}
              onClick={() => {
                const result = addEdge(effectiveFrom, effectiveTo)
                setFeedback(
                  resultFeedback(
                    result,
                    `已新增先修边：${kcLabel(store.kcs, effectiveFrom)} → ${kcLabel(store.kcs, effectiveTo)}`,
                  ),
                )
              }}
            >
              新增先修边
            </button>
            <span className="tiny muted">
              成环会被真实图谱代码拒绝并显示原因。
            </span>
          </div>
          <FeedbackNotice feedback={feedback} />
        </div>
      </div>

      <div className="grid grid-2" style={{ marginTop: 'var(--space-lg)' }}>
        <div className="card stack">
          <div className="spread">
            <h3 style={{ marginBottom: 0 }}>知识点（{store.kcs.length}）</h3>
            <Badge tone="neutral">本地 store</Badge>
          </div>
          {store.kcs.length === 0 ? (
            <p className="small muted">还没有知识点。</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>ID / 名称</th>
                    <th>学段</th>
                    <th>类型</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {store.kcs.map((kc) => (
                    <tr key={kc.id}>
                      <td>
                        <div className="mono tiny">{kc.id}</div>
                        {kc.label}
                        {kc.synthetic ? (
                          <div>
                            <Badge tone="warning">合成数据示例</Badge>
                          </div>
                        ) : null}
                      </td>
                      <td className="small">{kc.stage}</td>
                      <td className="small">{kc.nodeType}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            const result = deleteKc(kc.id)
                            setFeedback(
                              resultFeedback(
                                result,
                                `已删除知识点 ${kc.id}`,
                              ),
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

        <div className="card stack">
          <h3>先修边（{store.edges.length}）</h3>
          {store.edges.length === 0 ? (
            <p className="small muted">还没有先修关系。</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>依赖方</th>
                    <th>先修方</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {store.edges.map((edge) => (
                    <tr key={edge.id}>
                      <td>
                        {kcLabel(store.kcs, edge.source)}
                        <div className="mono tiny muted">{edge.source}</div>
                      </td>
                      <td>
                        {kcLabel(store.kcs, edge.target)}
                        <div className="mono tiny muted">{edge.target}</div>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            const result = deleteEdge(edge.id)
                            setFeedback(
                              resultFeedback(result, '已删除这条先修边'),
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
  )
}

function ItemBankSection() {
  const store = useStore()
  const [form, setForm] = useState<ItemForm>(EMPTY_ITEM_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  const submit = () => {
    const input = {
      prompt: form.prompt,
      requiredKcs: form.requiredKcs,
      difficulty: Number.parseInt(form.difficulty, 10),
      gradeLevel: Number.parseInt(form.gradeLevel, 10),
      estimatedMinutes: Number.parseFloat(form.estimatedMinutes),
      cognitiveLoad: Number.parseFloat(form.cognitiveLoad),
      hints: form.hints
        .split('\n')
        .map((hint) => hint.trim())
        .filter((hint) => hint.length > 0),
      answerExplanation: form.answerExplanation,
    }
    const result =
      editingId === null ? addItem(input) : updateItem(editingId, input)
    setFeedback(
      resultFeedback(
        result,
        editingId === null ? '已新增题目' : `已更新题目 ${editingId}`,
      ),
    )
    if (result.ok) {
      setEditingId(null)
      setForm(EMPTY_ITEM_FORM)
    }
  }

  return (
    <Section
      eyebrow="题库 · 本地 observed 题目"
      title="题目增删改"
      description="每道题至少标注题干、必需 KC 与难度；写入前会校验 KC 存在、数值范围与必填项。"
    >
      <div className="grid grid-2">
        <div className="card stack">
          <div className="spread">
            <h3 style={{ marginBottom: 0 }}>
              {editingId === null ? '新增题目' : `编辑 ${editingId}`}
            </h3>
            {editingId !== null ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setEditingId(null)
                  setForm(EMPTY_ITEM_FORM)
                }}
              >
                取消编辑
              </button>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="item-prompt">题干</label>
            <textarea
              id="item-prompt"
              className="text-input text-area"
              rows={3}
              value={form.prompt}
              placeholder="例：计算 1/2 + 1/3，并写出通分过程。"
              onChange={(event) =>
                setForm({ ...form, prompt: event.target.value })
              }
            />
          </div>
          <div className="field">
            <span className="field-label-like">必需知识点（可多选）</span>
            {store.kcs.length === 0 ? (
              <p className="small muted">请先在上方新增知识点。</p>
            ) : (
              <div className="checkbox-grid">
                {store.kcs.map((kc) => (
                  <label className="checkbox-row" key={kc.id}>
                    <input
                      type="checkbox"
                      checked={form.requiredKcs.includes(kc.id)}
                      onChange={(event) => {
                        setForm({
                          ...form,
                          requiredKcs: event.target.checked
                            ? [...form.requiredKcs, kc.id]
                            : form.requiredKcs.filter((id) => id !== kc.id),
                        })
                      }}
                    />
                    {kc.label}
                    <span className="mono tiny muted">{kc.id}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="item-difficulty">难度（1–5）</label>
              <select
                id="item-difficulty"
                className="text-input"
                value={form.difficulty}
                onChange={(event) =>
                  setForm({ ...form, difficulty: event.target.value })
                }
              >
                {[1, 2, 3, 4, 5].map((value) => (
                  <option key={value} value={String(value)}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="item-grade">年级（1–13）</label>
              <input
                id="item-grade"
                className="text-input"
                type="number"
                min={1}
                max={13}
                value={form.gradeLevel}
                onChange={(event) =>
                  setForm({ ...form, gradeLevel: event.target.value })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="item-minutes">预计分钟</label>
              <input
                id="item-minutes"
                className="text-input"
                type="number"
                min={0.5}
                step={0.5}
                value={form.estimatedMinutes}
                onChange={(event) =>
                  setForm({ ...form, estimatedMinutes: event.target.value })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="item-load">认知负荷</label>
              <input
                id="item-load"
                className="text-input"
                type="number"
                min={0}
                step={0.5}
                value={form.cognitiveLoad}
                onChange={(event) =>
                  setForm({ ...form, cognitiveLoad: event.target.value })
                }
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="item-hints">提示阶梯（每行一条，可空）</label>
            <textarea
              id="item-hints"
              className="text-input text-area"
              rows={3}
              value={form.hints}
              onChange={(event) =>
                setForm({ ...form, hints: event.target.value })
              }
            />
          </div>
          <div className="field">
            <label htmlFor="item-explanation">讲解 / 参考说明（可空）</label>
            <textarea
              id="item-explanation"
              className="text-input text-area"
              rows={3}
              value={form.answerExplanation}
              onChange={(event) =>
                setForm({ ...form, answerExplanation: event.target.value })
              }
            />
          </div>
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={submit}>
              {editingId === null ? '新增题目' : '保存题目'}
            </button>
          </div>
          <FeedbackNotice feedback={feedback} />
        </div>

        <div className="card stack">
          <div className="spread">
            <h3 style={{ marginBottom: 0 }}>
              题目列表（{store.items.length}）
            </h3>
            <Badge tone="neutral">难度 1–5</Badge>
          </div>
          {store.items.length === 0 ? (
            <p className="small muted">
              题库为空。新增一道题后即可准备干预与诊断。
            </p>
          ) : (
            <div className="stack">
              {store.items.map((item) => (
                <div className="card card-quiet" key={item.id}>
                  <div className="spread">
                    <div>
                      <strong>{item.prompt}</strong>
                      <div className="chip-row" style={{ marginTop: 6 }}>
                        {item.requiredKcs.map((kcId) => (
                          <Tag key={kcId} tone="lavender">
                            {kcLabel(store.kcs, kcId)}
                          </Tag>
                        ))}
                        <Tag tone="gray">难度 {item.difficulty}</Tag>
                        <Tag tone="gray">{item.gradeLevel} 年级</Tag>
                        <Tag tone="gray">{item.estimatedMinutes} 分钟</Tag>
                        {item.synthetic ? (
                          <Badge tone="warning">合成数据示例</Badge>
                        ) : null}
                      </div>
                    </div>
                    <div className="row">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          setEditingId(item.id)
                          setForm(itemToForm(item))
                          setFeedback(null)
                        }}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          const result = deleteItem(item.id)
                          setFeedback(
                            resultFeedback(result, `已删除题目 ${item.id}`),
                          )
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Section>
  )
}

function InterventionSection() {
  const store = useStore()
  const [studentRef, setStudentRef] = useState('')
  const [kcId, setKcId] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  const effectiveStudent = store.students.some(
    (student) => student.ref === studentRef,
  )
    ? studentRef
    : (store.students[0]?.ref ?? '')
  const effectiveKc = store.kcs.some((kc) => kc.id === kcId)
    ? kcId
    : (store.kcs[0]?.id ?? '')

  const selected =
    store.interventions.find((entry) => entry.id === selectedId) ??
    store.interventions[store.interventions.length - 1] ??
    null

  return (
    <Section
      eyebrow="干预 · exercise.ts"
      title="已准备的干预包（不交付）"
      description="选择学生 + KC 后运行真实习题流水线，产出训练/迁移题、提示阶梯、完成判据，并用 validatePackage 校验门禁。"
    >
      <Notice tone="warning" title="边界：">
        这里只有“已准备”。不存在交付按钮，也不会产生交付凭证；真正交付必须由
        dsh 插件侧 host approval 独立复核门禁后执行。前端不编造交付动作。
      </Notice>

      <div className="card stack" style={{ marginTop: 'var(--space-lg)' }}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="intervention-student">学生</label>
            <select
              id="intervention-student"
              className="text-input"
              value={effectiveStudent}
              onChange={(event) => setStudentRef(event.target.value)}
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
          <div className="field">
            <label htmlFor="intervention-kc">知识点</label>
            <select
              id="intervention-kc"
              className="text-input"
              value={effectiveKc}
              onChange={(event) => setKcId(event.target.value)}
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
          <div className="field field-action">
            <button
              type="button"
              className="btn btn-primary"
              disabled={effectiveStudent === '' || effectiveKc === ''}
              onClick={() => {
                const result = prepareIntervention(
                  effectiveStudent,
                  effectiveKc,
                )
                setFeedback(
                  resultFeedback(
                    result,
                    result.ok
                      ? `已准备干预包 ${result.value.packageId}（未交付）`
                      : '准备干预包失败',
                  ),
                )
                if (result.ok) setSelectedId(result.value.id)
              }}
            >
              运行流水线并准备
            </button>
          </div>
        </div>
        <FeedbackNotice feedback={feedback} />
        <p className="tiny muted" style={{ marginBottom: 0 }}>
          已准备干预：{store.interventions.length} 个。训练题与迁移题严格分离；
          迁移题要求未见过。
        </p>
      </div>

      {selected === null ? (
        <Notice tone="plain" title="还没有已准备的干预包：">
          先选择学生与 KC 并运行流水线。若题库没有覆盖该 KC，会如实失败，不会伪造题目。
        </Notice>
      ) : (
        <div className="stack" style={{ marginTop: 'var(--space-lg)' }}>
          <div className="grid grid-4">
            <Stat label="状态" value="已准备" sub="prepared · 未交付" />
            <Stat
              label="校验"
              value={selected.valid ? '通过' : '未通过'}
              sub={`${selected.validationReasons.length} 条原因`}
            />
            <Stat
              label="训练 / 迁移题"
              value={`${selected.trainingItemIds.length} / ${selected.transferItemIds.length}`}
              sub={
                selected.independentTransfer ? '要求独立迁移' : '不要求迁移'
              }
            />
            <Stat
              label="模式"
              value={selected.schoolMode}
              sub={formatDateTime(selected.createdAt)}
            />
          </div>

          <div className="grid grid-2">
            <div className="card stack">
              <div className="spread">
                <h3 style={{ marginBottom: 0 }}>干预包内容</h3>
                <Badge tone={selected.valid ? 'success' : 'error'}>
                  {selected.valid
                    ? 'validatePackage 通过'
                    : 'validatePackage 拒绝'}
                </Badge>
              </div>
              <KeyValues
                items={[
                  {
                    key: '包 ID',
                    value: (
                      <span className="mono tiny">{selected.packageId}</span>
                    ),
                  },
                  {
                    key: '目标 ID',
                    value: (
                      <span className="mono tiny">{selected.objectiveId}</span>
                    ),
                  },
                  {
                    key: '必需 KC',
                    value: selected.requiredKcs
                      .map((id) => kcLabel(store.kcs, id))
                      .join('、'),
                  },
                  {
                    key: '训练题',
                    value:
                      selected.trainingItemIds.length === 0 ? (
                        '—'
                      ) : (
                        <ul style={{ margin: 0 }}>
                          {selected.trainingItemIds.map((id) => (
                            <li key={id} className="mono tiny">
                              {id}
                            </li>
                          ))}
                        </ul>
                      ),
                  },
                  {
                    key: '迁移题',
                    value:
                      selected.transferItemIds.length === 0 ? (
                        '—'
                      ) : (
                        <ul style={{ margin: 0 }}>
                          {selected.transferItemIds.map((id) => (
                            <li key={id} className="mono tiny">
                              {id}
                            </li>
                          ))}
                        </ul>
                      ),
                  },
                  {
                    key: '提示阶梯',
                    value: (
                      <ol style={{ margin: 0 }}>
                        {selected.hintLadder.map((hint, index) => (
                          <li key={`${index}-${hint}`}>{hint}</li>
                        ))}
                      </ol>
                    ),
                  },
                  {
                    key: '完成判据',
                    value: selected.completionCriteria.join(' · ') || '—',
                  },
                ]}
              />
            </div>

            <div className="card stack">
              <h3 style={{ marginBottom: 0 }}>校验结果与审批说明</h3>
              {selected.validationReasons.length === 0 ? (
                <Notice tone="success">
                  所有训练/迁移题通过当前学生与模式下的课程门禁，必需 KC
                  在允许集合内，完成判据、提示阶梯与独立迁移要求齐全。
                </Notice>
              ) : (
                <div className="notice notice-warning">
                  <strong>未通过原因：</strong>
                  <ul style={{ marginBottom: 0 }}>
                    {selected.validationReasons.map((reason) => (
                      <li key={reason}>
                        <span className="mono tiny">{reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="callout">
                <strong>审批说明：</strong>
                {selected.approvalNote}
              </div>
              <div className="row">
                <Badge tone="neutral">未交付</Badge>
                <Badge tone="gray">无 deliver 调用</Badge>
                <Badge tone="gray">无交付凭证</Badge>
              </div>
            </div>
          </div>

          {store.interventions.length > 1 ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>准备时间</th>
                    <th>学生</th>
                    <th>知识点</th>
                    <th>校验</th>
                    <th>状态</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {store.interventions
                    .slice()
                    .reverse()
                    .map((intervention) => (
                      <tr key={intervention.id}>
                        <td className="small nowrap">
                          {formatDateTime(intervention.createdAt)}
                        </td>
                        <td>{intervention.studentRef}</td>
                        <td>{kcLabel(store.kcs, intervention.kcId)}</td>
                        <td>
                          <Badge
                            tone={intervention.valid ? 'success' : 'error'}
                          >
                            {intervention.valid ? '通过' : '拒绝'}
                          </Badge>
                        </td>
                        <td>
                          <Badge tone="neutral">已准备 / 未交付</Badge>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => setSelectedId(intervention.id)}
                          >
                            查看
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      )}
    </Section>
  )
}

function StrategySection() {
  const store = useStore()
  const [kcId, setKcId] = useState('')
  const effectiveKcId = store.kcs.some((kc) => kc.id === kcId)
    ? kcId
    : (store.kcs[0]?.id ?? '')
  const kc = store.kcs.find((entry) => entry.id === effectiveKcId)

  const result = useMemo(
    () => (kc === undefined ? null : strategyForKc(kc, { inProgress: false })),
    [kc],
  )

  return (
    <Section
      eyebrow="教学策略 · teaching-strategy.ts"
      title="每个知识点的策略选项与学习科学依据"
      description="由 selectStrategy 在 9 类教学动作中选择，并映射到学习科学方法；这里只展示策略与依据，不自动执行教学动作。"
    >
      <div className="card stack">
        <div className="field">
          <label htmlFor="strategy-kc">知识点</label>
          <select
            id="strategy-kc"
            className="text-input"
            value={effectiveKcId}
            onChange={(event) => setKcId(event.target.value)}
            disabled={store.kcs.length === 0}
          >
            {store.kcs.length === 0 ? (
              <option value="">还没有知识点</option>
            ) : null}
            {store.kcs.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}（{entry.id}）
              </option>
            ))}
          </select>
        </div>
        {kc === undefined || result === null ? (
          <p className="small muted">新增知识点后即可查看策略映射。</p>
        ) : (
          <>
            <div className="spread">
              <div>
                <div className="eyebrow">当前 KC · {kc.id}</div>
                <h3 style={{ marginBottom: 4 }}>{kc.label}</h3>
              </div>
              <Badge tone={result.decision.blocked ? 'error' : 'success'}>
                {result.decision.blocked ? '被护栏阻止' : result.decision.action}
              </Badge>
            </div>
            <KeyValues
              items={[
                {
                  key: '动作',
                  value: (
                    <span className="mono tiny">{result.decision.action}</span>
                  ),
                },
                { key: '模式', value: result.decision.mode },
                {
                  key: '时间预算',
                  value: `${result.decision.timeMinutes} 分钟`,
                },
                {
                  key: '方法 ID',
                  value:
                    result.decision.methodIds.length === 0 ? (
                      '—'
                    ) : (
                      <span className="mono tiny">
                        {result.decision.methodIds.join(', ')}
                      </span>
                    ),
                },
                {
                  key: '选择理由',
                  value:
                    result.decision.reasons.length === 0 ? (
                      '—'
                    ) : (
                      <ul style={{ margin: 0 }}>
                        {result.decision.reasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    ),
                },
                {
                  key: '护栏',
                  value:
                    result.decision.guardrails.length === 0 ? (
                      '—'
                    ) : (
                      <ul style={{ margin: 0 }}>
                        {result.decision.guardrails.map((guardrail) => (
                          <li key={guardrail} className="mono tiny">
                            {guardrail}
                          </li>
                        ))}
                      </ul>
                    ),
                },
                {
                  key: '交付要求',
                  value: result.decision.deliveryRequiresGate
                    ? '任何交付仍需通过课程门禁'
                    : '—',
                },
              ]}
            />
            {result.decision.requiresConfirmation ? (
              <Notice tone="warning">
                该动作需要教师确认后才可执行；本页没有自动执行入口。
              </Notice>
            ) : null}

            <h3 style={{ marginTop: 'var(--space-lg)' }}>学习科学方法依据</h3>
            {result.methods.length === 0 ? (
              <p className="small muted">
                当前动作没有映射到已登记的方法。
              </p>
            ) : (
              <div className="grid grid-2">
                {result.methods.map((method) => (
                  <div className="card card-quiet" key={method.methodId}>
                    <div className="spread">
                      <h4 style={{ marginBottom: 0 }}>
                        {method.displayName}
                      </h4>
                      <Badge
                        tone={
                          method.status === 'implemented'
                            ? 'success'
                            : 'neutral'
                        }
                      >
                        {method.status}
                      </Badge>
                    </div>
                    <div className="mono tiny muted" style={{ marginTop: 4 }}>
                      {method.methodId}
                    </div>
                    <div style={{ marginTop: 'var(--space-sm)' }}>
                      <div className="tiny muted">适用条件</div>
                      <div className="chip-row">
                        {method.conditions.map((condition) => (
                          <Tag key={condition} tone="gray">
                            {condition}
                          </Tag>
                        ))}
                      </div>
                    </div>
                    <div style={{ marginTop: 'var(--space-sm)' }}>
                      <div className="tiny muted">实现要点</div>
                      <ul className="small" style={{ marginBottom: 0 }}>
                        {method.implementation.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    </div>
                    <div style={{ marginTop: 'var(--space-sm)' }}>
                      <div className="tiny muted">如何验证</div>
                      <div className="chip-row">
                        {method.verification.map((item) => (
                          <Tag key={item} tone="green">
                            {item}
                          </Tag>
                        ))}
                      </div>
                    </div>
                    {method.guardrails.length > 0 ? (
                      <div style={{ marginTop: 'var(--space-sm)' }}>
                        <div className="tiny muted">护栏</div>
                        <ul className="small" style={{ marginBottom: 0 }}>
                          {method.guardrails.map((line) => (
                            <li key={line}>{line}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="table-wrap" style={{ marginTop: 'var(--space-lg)' }}>
        <table>
          <thead>
            <tr>
              <th>知识点</th>
              <th>将采用的动作</th>
              <th>方法</th>
              <th>时间</th>
              <th>需要确认</th>
            </tr>
          </thead>
          <tbody>
            {store.kcs.map((entry) => {
              const decision = strategyForKc(entry, { inProgress: false })
              return (
                <tr key={entry.id}>
                  <td>
                    {entry.label}
                    <div className="mono tiny muted">{entry.id}</div>
                  </td>
                  <td>
                    <span className="mono tiny">
                      {decision.decision.action}
                    </span>
                  </td>
                  <td className="small">
                    {decision.decision.methodIds.length === 0
                      ? '—'
                      : decision.decision.methodIds.join(', ')}
                  </td>
                  <td className="num">{decision.decision.timeMinutes} 分</td>
                  <td>
                    {decision.decision.requiresConfirmation ? (
                      <Badge tone="warning">需要</Badge>
                    ) : (
                      <Badge tone="neutral">否</Badge>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="tiny muted" style={{ marginTop: 'var(--space-sm)' }}>
        策略按“未指定具体学生”的默认证据计算；改变学生状态（observed
        进度/复习）后，dsh 插件侧会带着真实状态重新选择。本页不伪造个性化结论。
      </p>
    </Section>
  )
}

export default function TeacherView() {
  const store = useStore()
  const syntheticCounts = {
    kcs: store.kcs.filter((kc) => kc.synthetic).length,
    items: store.items.filter((item) => item.synthetic).length,
  }

  return (
    <div>
      <PageHeader
        eyebrow="教师 · 真实核心"
        title="课程图谱、题库、干预准备与教学策略"
        lede="所有写操作都落在本地 store；图谱成环、题目校验、干预门禁与策略映射都直接调用 dsh-plugin 的真实 TypeScript 核心。"
      />

      {syntheticCounts.kcs > 0 || syntheticCounts.items > 0 ? (
        <Notice tone="synthetic" title="合成数据示例：">
          当前含预置合成示例（知识点 {syntheticCounts.kcs}、题目{' '}
          {syntheticCounts.items}）。带“合成数据示例”标记的内容可编辑或删除，
          不代表任何真实学生或真实题目。
        </Notice>
      ) : null}

      <div className="grid grid-3" style={{ marginTop: 'var(--space-lg)' }}>
        <Stat
          label="知识点"
          value={store.kcs.length}
          sub={`${store.edges.length} 条先修边`}
        />
        <Stat label="题目" value={store.items.length} sub="本地题库" />
        <Stat
          label="已准备干预"
          value={store.interventions.length}
          sub="全部未交付"
        />
      </div>

      <GraphSection />
      <ItemBankSection />
      <InterventionSection />
      <StrategySection />
    </div>
  )
}
