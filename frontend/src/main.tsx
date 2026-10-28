import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './styles/tokens.css'
import './styles/app.css'
import { contentHash, gateAllow } from './lib/core'

// Step 0 冒烟：确认真实核心可进入浏览器 bundle，并计算一个内容摘要。
const step0Decision = gateAllow(
  {
    itemId: 'step0.item',
    requiredKcs: ['kc.step0'],
    gradeLevel: 5,
    safetyChecked: true,
    contentVerified: true,
    annotationConfidence: 1,
  },
  {
    studentRef: 'step0.student',
    gradeLevel: 5,
    taughtKcs: ['kc.step0'],
    loadBudget: 10,
  },
  'learn',
)
document.documentElement.dataset.aehCore = `${step0Decision.allowed}:${contentHash({ step0: true }).slice(0, 12)}`

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('找不到 #root 挂载节点')
}

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
