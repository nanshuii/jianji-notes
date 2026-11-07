/**
 * 用真实滚轮事件（CDP Input.dispatchMouseEvent wheel）在卡片上滚，看笔记滚动位置会不会来回抖。
 * 卡片模式：先往上滚（内部已在顶部，应该接力给笔记）→ 再往下滚；
 * 融入模式：直接滚笔记。
 * 运行：node .tmp/wheel-jitter.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ENDPOINT = 'http://127.0.0.1:9223'
const APP = process.env.APP_URL || 'http://127.0.0.1:4173/'
const HTML_FILE = resolve(process.env.HOME, 'Documents/简记/.assets/html-20261107-141713-64ae.html')
const html = readFileSync(HTML_FILE, 'utf8')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const targets = await (await fetch(`${ENDPOINT}/json/list`)).json()
const target = targets.find((t) => t.type === 'page')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) }
})
const send = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })) })
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}
const go = async (url) => { await send('Page.navigate', { url }); await sleep(1500) }

await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 940, deviceScaleFactor: 1, mobile: false })
await go(APP)
await evaluate('localStorage.clear()')
const fm = '---\ntitle: 光伏板块\ncreated: 2026-11-07T10:00:00.000Z\nupdated: 2026-11-07T10:00:00.000Z\npinned: false\n---\n\n'
const meta = JSON.stringify({ file: 'html-jitter.html', title: '光伏工序级竞争格局全表', height: 900 })
await evaluate(`(() => {
  localStorage.setItem('jianji.assets.v1', JSON.stringify({'html-jitter.html': ${JSON.stringify(html)}}))
  localStorage.setItem('jianji.notes.v1', JSON.stringify({'股市/光伏板块.md': ${JSON.stringify(fm + '```jianji-html\n' + meta + '\n```\n')}}))
})()`)
await go(`${APP}?v=${Date.now()}`)
await evaluate(`(() => { const it = [...document.querySelectorAll('.note-item, .note-title')].find(e => e.textContent.includes('光伏板块')); (it?.closest('.note-item') || it)?.click() })()`)
await sleep(2500)

// 找到笔记滚动容器和卡片中心点
const info = await evaluate(`(() => {
  const card = document.querySelector('.html-card')
  const r = card.getBoundingClientRect()
  let n = card.parentElement, sc = null
  while (n) { const st = getComputedStyle(n); if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 1) { sc = n; break } n = n.parentElement }
  window.__sc = sc || document.scrollingElement
  window.__sc.scrollTop = 500
  return { x: Math.round(r.left + r.width / 2), y: Math.round(Math.min(r.bottom - 40, 700)), mode: card.className }
})()`)
console.log('模式：', info.mode, '｜点：', info.x, info.y)

const readState = () => evaluate(`(() => {
  const f = document.querySelector('.html-card iframe')
  const d = f?.contentDocument
  const root = d ? (d.scrollingElement || d.documentElement) : null
  return {
    outer: Math.round(window.__sc.scrollTop),
    inner: root ? Math.round(root.scrollTop) : -1,
    frameTop: Math.round(f.getBoundingClientRect().top),
  }
})()`)

const wheel = async (deltaY, n = 12) => {
  const seen = []
  for (let i = 0; i < n; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: info.x, y: info.y, deltaX: 0, deltaY, pointerType: 'mouse' })
    await sleep(60)
    seen.push(await readState())
  }
  return seen
}

console.log('\n--- 卡片模式：先往下滚 ---')
let rows = await wheel(120, 10)
console.log('outer:', rows.map((r) => r.outer).join(' '))
console.log('inner:', rows.map((r) => r.inner).join(' '))
let back = 0
for (let i = 1; i < rows.length; i++) if (rows[i].outer < rows[i - 1].outer) back++
console.log('outer 回退次数:', back)

await evaluate(`window.__sc.scrollTop = 400`)
console.log('\n--- 卡片模式：往上滚（内部在顶部，应接力给笔记）---')
rows = await wheel(-120, 10)
console.log('outer:', rows.map((r) => r.outer).join(' '))
console.log('inner:', rows.map((r) => r.inner).join(' '))
back = 0
for (let i = 1; i < rows.length; i++) if (rows[i].outer > rows[i - 1].outer) back++
console.log('outer 反向次数:', back)

// 切融入
await evaluate(`(() => { const b = [...document.querySelectorAll('.html-card button')].find(x => x.textContent.includes('融入')); b?.click() })()`)
await sleep(2500)
await evaluate(`window.__sc.scrollTop = 800`)
console.log('\n--- 融入模式：往下滚 ---')
rows = await wheel(120, 12)
console.log('outer:', rows.map((r) => r.outer).join(' '))
console.log('frameTop:', rows.map((r) => r.frameTop).join(' '))
back = 0
for (let i = 1; i < rows.length; i++) if (rows[i].outer < rows[i - 1].outer) back++
console.log('outer 回退次数:', back)
ws.close()
