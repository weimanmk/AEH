import { Link, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import HomeView from './views/HomeView'
import StudentView from './views/StudentView'
import TeacherView from './views/TeacherView'
import ReportView from './views/ReportView'
import MetricsView from './views/MetricsView'

function NotFound() {
  return (
    <div className="container">
      <div className="section-head">
        <div className="eyebrow">404</div>
        <h1>页面不存在</h1>
        <p className="lede">本地教师工具只有首页与 4 个业务视图。</p>
      </div>
      <Link className="btn btn-primary" to="/">
        返回首页
      </Link>
    </div>
  )
}

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<HomeView />} />
        <Route path="/student" element={<StudentView />} />
        <Route path="/teacher" element={<TeacherView />} />
        <Route path="/report" element={<ReportView />} />
        <Route path="/metrics" element={<MetricsView />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Layout>
  )
}
