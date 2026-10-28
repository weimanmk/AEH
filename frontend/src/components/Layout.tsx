import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { STORAGE_KEY } from '../lib/model'

const NAV_ITEMS: { to: string; label: string; end?: boolean }[] = [
  { to: '/', label: '首页', end: true },
  { to: '/student', label: '学生' },
  { to: '/teacher', label: '教师' },
  { to: '/report', label: '报告' },
  { to: '/metrics', label: '指标' },
]

function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [pathname])
  return null
}

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="site">
      <ScrollToTop />
      <header className="nav">
        <div className="container nav-inner">
          <Link to="/" className="brand">
            <span className="brand-mark">AEH</span>
            <span>教师工作台 · 本地</span>
          </Link>
          <nav className="nav-links" aria-label="主导航">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="page">{children}</main>
      <footer className="footer">
        <div className="container footer-grid">
          <div style={{ maxWidth: '72ch' }}>
            <strong>本地教师工具 · 真实核心</strong>
            <p className="tiny" style={{ marginTop: 6, marginBottom: 0 }}>
              课程门禁、FSRS 排程、诊断、干预准备与聚合报告直接运行
              dsh-plugin/src 的 TypeScript 核心；数据只存本机浏览器 localStorage
              （{STORAGE_KEY}），运行期零网络，不含模型会话。
            </p>
          </div>
          <div className="tiny">
            <div>合成数据示例均有标注，可删除或一键清空。</div>
            <div style={{ marginTop: 4 }}>
              学生只用本地代号 + 年级；掌握度只来自 observed_* 观察。
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}
