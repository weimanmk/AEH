import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Section, Stat, Notice, Badge } from '../components/ui'
import { useStore } from '../store/useStore'
import { buildMetrics } from '../lib/metrics'
import {
  clearAll,
  exportStoreJson,
  importStoreJson,
  resetToSynthetic,
} from '../lib/store'
import { downloadJson } from '../lib/download'
import { STORAGE_KEY } from '../lib/model'
import type { AppStore } from '../lib/model'

function syntheticCounts(store: AppStore) {
  return {
    students: store.students.filter((entry) => entry.synthetic).length,
    kcs: store.kcs.filter((entry) => entry.synthetic).length,
    items: store.items.filter((entry) => entry.synthetic).length,
    reviews: store.reviews.filter((entry) => entry.synthetic).length,
  }
}

export default function HomeView() {
  const store = useStore()
  const now = new Date().toISOString()
  const metrics = useMemo(() => buildMetrics(store, now), [store, now])
  const synthetic = syntheticCounts(store)
  const hasSynthetic =
    synthetic.students > 0 || synthetic.kcs > 0 || synthetic.items > 0
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleImport = async (file: File | undefined) => {
    setError(null)
    setMessage(null)
    if (file === undefined) return
    try {
      const text = await file.text()
      const result = importStoreJson(text)
      if (!result.ok) {
        setError(`导入失败，原数据未覆盖：${result.error}`)
        return
      }
      setMessage(
        `已导入：${result.value.students.length} 名学生、${result.value.kcs.length} 个知识点。`,
      )
    } catch (reason) {
      setError(
        `读取文件失败：${reason instanceof Error ? reason.message : String(reason)}`,
      )
    }
  }

  return (
    <div>
      <div className="hero">
        <div className="eyebrow">本地教师工具 · 真实核心</div>
        <h1>AEH 教师工作台</h1>
        <p className="lede">
          课程门禁、认知孪生、FSRS 排程、诊断、干预准备与聚合报告直接运行
          <span className="mono"> dsh-plugin/src</span> 的 TypeScript 核心。学生数据只存在本机浏览器，
          不联网、不含模型会话。
        </p>
        <div className="hero-actions">
          <Link className="btn btn-primary" to="/student">
            进入学生视图
          </Link>
          <Link className="btn btn-secondary" to="/teacher">
            管理课程与题库
          </Link>
        </div>
      </div>

      <Section
        eyebrow="实时计数"
        title="当前本地数据"
        description="数字由 store 与真实 FSRS 派生，不使用任何手写常量。"
      >
        <div className="grid grid-4">
          <Stat label="学生" value={store.students.length} sub="本地代号 + 年级" />
          <Stat
            label="知识点"
            value={store.kcs.length}
            sub={`${store.edges.length} 条先修边`}
          />
          <Stat
            label="题目"
            value={store.items.length}
            sub="本地题库"
          />
          <Stat
            label="今日到期复习"
            value={metrics.dueCount}
            sub={`逾期 ${metrics.overdueCount} · 纳入 ${metrics.studentsIncluded} 人`}
          />
        </div>
        <p className="tiny muted" style={{ marginTop: 'var(--space-sm)' }}>
          FSRS 回忆率估计：
          {metrics.fsrsRecallMean === null
            ? '暂无记忆状态'
            : `${(metrics.fsrsRecallMean * 100).toFixed(1)}%`}
          ；纳入学生复习 {metrics.reviewCount} 条，已准备干预 {metrics.interventionsPrepared} 个（均未交付）。
        </p>

        {hasSynthetic ? (
          <Notice tone="synthetic" title="合成数据示例：">
            当前含预置合成示例（学生 {synthetic.students}、知识点 {synthetic.kcs}
            、题目 {synthetic.items}、复习 {synthetic.reviews}）。示例数据在教学视图中有“合成”
            标记，可在下方数据管理中删除、恢复或清空。
          </Notice>
        ) : null}
      </Section>

      <Section
        eyebrow="视图入口"
        title="按角色开始"
        description="每个按钮都通往可实际操作的本地视图。"
      >
        <div className="grid grid-4">
          <Link className="role-card tint-lavender" to="/student">
            <h3>学生</h3>
            <p className="role-tagline">进度、复习、诊断、门禁与假设。</p>
            <ul>
              <li>录入 observed 进度</li>
              <li>完成到期复习并重算 FSRS</li>
              <li>对当前状态跑真实诊断</li>
            </ul>
          </Link>
          <Link className="role-card tint-sky" to="/teacher">
            <h3>教师</h3>
            <p className="role-tagline">课程图谱、题库、干预准备与教学策略。</p>
            <ul>
              <li>加 KC / 先修边（成环拒绝）</li>
              <li>题库增删改</li>
              <li>准备干预包（不交付）</li>
            </ul>
          </Link>
          <Link className="role-card tint-peach" to="/report">
            <h3>报告</h3>
            <p className="role-tagline">仅聚合，无原始作答。</p>
            <ul>
              <li>人数与分学段分布</li>
              <li>各 KC 聚合</li>
              <li>撤销同意自动排除</li>
            </ul>
          </Link>
          <Link className="role-card tint-mint" to="/metrics">
            <h3>指标</h3>
            <p className="role-tagline">覆盖率、到期、回忆率与负担。</p>
            <ul>
              <li>全部由本地数据实时算出</li>
              <li>同意账本</li>
              <li>本地隐私边界说明</li>
            </ul>
          </Link>
        </div>
      </Section>

      <Section
        eyebrow="数据管理"
        title="导出、导入、恢复、清空"
        description={`存储键 ${STORAGE_KEY}；导入失败时不会覆盖现有数据。`}
      >
        <div className="card stack">
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                downloadJson(
                  `aeh-frontend-${new Date().toISOString().slice(0, 10)}.json`,
                  exportStoreJson(),
                )
                setMessage('已导出当前数据 JSON。')
                setError(null)
              }}
            >
              导出 JSON
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => fileRef.current?.click()}
            >
              导入 JSON
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              aria-label="选择要导入的 AEH 数据 JSON"
              style={{ display: 'none' }}
              onChange={(event) => {
                const file = event.target.files?.[0]
                void handleImport(file)
                event.target.value = ''
              }}
            />
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                if (!window.confirm('用合成示例覆盖当前全部数据？此操作不可撤销。')) {
                  return
                }
                resetToSynthetic()
                setMessage('已恢复预置合成示例。')
                setError(null)
              }}
            >
              恢复预置示例
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                if (!window.confirm('清空全部本地数据？此操作不可撤销。')) return
                clearAll()
                setMessage('已清空本地数据。')
                setError(null)
              }}
            >
              一键清空
            </button>
            <Badge tone="neutral">零网络</Badge>
          </div>
          {message ? (
            <Notice tone="success" title="操作成功：">
              {message}
            </Notice>
          ) : null}
          {error ? (
            <Notice tone="warning" title="操作失败：">
              {error}
            </Notice>
          ) : null}
          <p className="tiny muted" style={{ marginBottom: 0 }}>
            导出文件只含本机录入的代号、知识点、题目、进度、复习、同意与已准备干预；
            不含真实姓名、账号、照片或模型会话。
          </p>
        </div>
      </Section>
    </div>
  )
}
