import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const root = document.getElementById('root')

/**
 * 兜底：万一启动阶段就抛错，页面会变成一片白，看不出原因。
 * 这里把错误直接画到页面上，白板至少能变成一句人话。
 */
function showFatal(title: string, detail: string) {
  const host = root ?? document.body
  host.innerHTML = ''
  const box = document.createElement('div')
  box.setAttribute(
    'style',
    'padding:36px 40px;font:14px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#25231f;background:#fbfaf8;height:100%;overflow:auto',
  )
  const head = document.createElement('div')
  head.textContent = title
  head.setAttribute('style', 'font-size:16px;font-weight:600;margin-bottom:14px')
  const pre = document.createElement('pre')
  pre.textContent = detail
  pre.setAttribute(
    'style',
    'white-space:pre-wrap;word-break:break-all;font-size:12.5px;color:#a85732;background:#f6ece6;padding:14px;border-radius:8px',
  )
  box.append(head, pre)
  host.appendChild(box)
}

window.addEventListener('error', (e) => {
  showFatal('简记启动失败', String(e.error?.stack ?? e.message ?? '未知错误'))
})
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason as { stack?: string } | string | undefined
  showFatal('简记启动失败', String((reason as { stack?: string })?.stack ?? reason ?? '未知错误'))
})

if (!root) {
  showFatal('简记启动失败', '页面里找不到 #root 节点，前端资源可能没加载完整。')
} else {
  // 启动探针：脚本跑到这里说明 JS 已经加载并执行了
  try {
    localStorage.setItem('jianji.bootJs', new Date().toISOString())
  } catch {
    /* 忽略 */
  }
  root.innerHTML = ''
  try {
    createRoot(root).render(<App />)
  } catch (e) {
    showFatal('简记启动失败', String(e))
  }
}
