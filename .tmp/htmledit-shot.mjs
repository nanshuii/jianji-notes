/**
 * 生成「在笔记里改网页内容」的效果图：真实光伏页面 + 顶部改字条。
 * 运行：APP_URL=http://127.0.0.1:4173/ node .tmp/htmledit-shot.mjs
 */
import { writeFileSync } from 'node:fs'

const ENDPOINT = 'http://127.0.0.1:9223'
const APP = process.env.APP_URL || 'http://127.0.0.1:4173/'
const OUT = '.tmp/htmledit-preview.png'
const REAL = '/Users/ledon/Documents/简记/.assets/html-20261105-220310-7249.html'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const targets = await (await fetch(`${ENDPOINT}/json/list`)).json()
const target = targets.find((t) => t.type === 'page')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id)
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
  }
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id; pending.set(mid, { resolve, reject })
  ws.send(JSON.stringify({ id: mid, method, params }))
})
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('DOM.enable')
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 860, deviceScaleFactor: 2, mobile: false })

await send('Page.navigate', { url: APP })
await sleep(1500)
await evaluate('localStorage.clear()')
await send('Page.navigate', { url: `${APP}?v=${Date.now()}` })
await sleep(1600)
await evaluate(`(() => { const b = document.querySelector('.new-main'); b && b.click() })()`)
await sleep(1000)

const doc = await send('DOM.getDocument', { depth: -1 })
const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.html-picker' })
await send('DOM.setFileInputFiles', { files: [REAL], nodeId: node.nodeId })
await sleep(3000)

// 进入改字模式
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.html-inline-tools button')].find((x) => (x.textContent || '').includes('编辑'))
  b && b.click()
})()`)
await sleep(700)

// 把某一节标题选中，让「正在改哪一段」看得出来
await evaluate(`(() => {
  const f = document.querySelector('.html-card iframe'), d = f.contentDocument, w = f.contentWindow
  const el = d.querySelectorAll('h2')[1]
  if (!el) return
  const r = d.createRange(); r.selectNodeContents(el)
  const s = w.getSelection(); s.removeAllRanges(); s.addRange(r)
  w.focus()
})()`)
await sleep(400)

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
console.log('已生成', OUT)
ws.close()
