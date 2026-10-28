import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { DEMO_META } from '../data/synthetic'

const NAV_ITEMS: { to: string; label: string; end?: boolean }[] = [
  { to: '/', label: '首页', end: true },
  { to: '/student', label: '学生答题' },
  { to: '/teacher', label: '教师孪生' },
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
            <span>自适应认知孪生 · 演示</span>
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
            <strong>合成数据演示</strong>
            <p className="tiny" style={{ marginTop: 6, marginBottom: 0 }}>
              {DEMO_META.syntheticNotice}
            </p>
          </div>
          <div className="tiny">
            <div>{DEMO_META.phaseNotice}</div>
            <div style={{ marginTop: 4 }}>
              伪匿名示例学生：<span className="mono">{DEMO_META.pseudonymousStudentRef}</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}
