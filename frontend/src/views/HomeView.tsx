import { Link } from 'react-router-dom'
import { DEMO_META, roleEntrances } from '../data/synthetic'
import { Badge, Notice, Section, Tag } from '../components/ui'

const COVERAGE: { clause: string; where: string; status: '已补' | '演示范围外' }[] = [
  { clause: '§3 课程图谱与题目结构化标签', where: '学生视图（Q-matrix/验证器/泄露等级）、教师视图（先修关系）', status: '已补' },
  { clause: '§4 三条进度轴与课程门禁算法', where: '教师视图（进度轴）、学生视图（门禁六条件与 fail-closed）', status: '已补' },
  { clause: '§5 孪生生命周期 / 四维认知 / 步骤图', where: '教师视图', status: '已补' },
  { clause: '§6 动态虚拟学生与假设生命周期', where: '教师视图', status: '已补' },
  { clause: '§7 反向溯源与主动诊断目标', where: '教师视图', status: '已补' },
  { clause: '§8 FSRS 留存、复习事件质量与调度', where: '教师视图（间隔/队列）、指标视图（留存）', status: '已补' },
  { clause: '§9 习题演化与干预包', where: '教师视图', status: '已补' },
  { clause: '§10 教学策略路由器与提示梯度', where: '教师视图', status: '已补' },
  { clause: '§11 动态模拟实验室（隔离）', where: '指标视图', status: '已补' },
  { clause: '§12/§13 状态机、Agent 角色与权限域', where: '教师视图、报告视图', status: '已补' },
  { clause: '§17 跨学科适配层', where: '指标视图（结构说明；仅数学分数知识点在演示内）', status: '演示范围外' },
  { clause: '§18 学习科学方法工具箱', where: '教师视图', status: '已补' },
  { clause: '§20 运行指标与推荐审计记录', where: '指标视图、教师视图', status: '已补' },
  { clause: '§21 隐私最小化与数据治理', where: '报告视图', status: '已补' },
]

export default function HomeView() {
  return (
    <>
      <section className="hero">
        <div className="container">
          <div className="eyebrow">
            {DEMO_META.productName} · Adaptive Cognitive Twin Education Harness
          </div>
          <h1>{DEMO_META.oneLiner}</h1>
          <p className="lede">
            3 道分数合成题、合成学生孪生、聚合报告与指标仪表盘。无后端、无真实接口、无真实学生数据。
          </p>
        </div>
      </section>

      <div className="container">
        <div style={{ marginTop: 'var(--space-xl)' }}>
          <Notice tone="synthetic" title="合成数据声明：">
            {DEMO_META.syntheticNotice}
          </Notice>
        </div>

        <section className="section">
          <div className="section-head">
            <div className="eyebrow">三个入口</div>
            <h2>按角色浏览演示</h2>
          </div>
          <div className="grid grid-3">
            {roleEntrances.map((role) => (
              <article key={role.id} className={`role-card tint-${role.tint}`}>
                <h3>{role.title}</h3>
                <p className="role-tagline">{role.tagline}</p>
                <ul>
                  {role.points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
                <div className="role-actions">
                  <Link className="btn btn-dark" to={role.to}>
                    {role.id === 'insight' ? '查看报告' : '进入'}
                  </Link>
                  {role.secondaryTo ? (
                    <Link className="btn btn-secondary" to={role.secondaryTo}>
                      {role.secondaryLabel}
                    </Link>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </section>

        <Section
          eyebrow="规范自查"
          title="v1.1 规范覆盖地图"
          description="每个条款在演示前端中的对应位置与状态；未在本演示内实现的能力明确标注为“演示范围外”，不编造后端能力。"
        >
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>规范条款</th>
                  <th>覆盖视图</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {COVERAGE.map((row) => (
                  <tr key={row.clause}>
                    <td>{row.clause}</td>
                    <td className="small muted">{row.where}</td>
                    <td>
                      {row.status === '已补' ? (
                        <Badge tone="success">已补</Badge>
                      ) : (
                        <Badge tone="neutral">演示范围外</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="stack" style={{ marginTop: 'var(--space-lg)' }}>
            <Notice tone="warning" title="演示范围外（不编造）：">
              真实后端与数据库、真实学生数据、真实 LLM/OCR/CAS 调用、向量检索（RAG）、
              生产级 FSRS 优化器、跨学科验证器实现、真实随机对照实验与因果结论、
              监护同意与合规的法律审查，均不在本演示内实现。
            </Notice>
            <div className="chip-row">
              <Tag tone="gray">无后端</Tag>
              <Tag tone="gray">无真实接口</Tag>
              <Tag tone="gray">合成数据</Tag>
              <Tag tone="gray">仅浏览器内存状态</Tag>
            </div>
          </div>
        </Section>

        <p className="small muted" style={{ marginTop: 'var(--space-xl)' }}>
          {DEMO_META.phaseNotice} 每个入口都只读取{' '}
          <span className="mono">frontend/src/data/synthetic.ts</span> 中的合成 fixture，
          状态仅保存在浏览器内存。
        </p>
      </div>
    </>
  )
}
