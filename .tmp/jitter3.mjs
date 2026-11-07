/**
 * 抖动诊断 v3：滚动时量
 * 1) 卡片模式：滚 iframe 内部，逐帧看吸顶工具条的屏幕位置（有没有来回跳）
 * 2) 融入模式：滚笔记容器，逐帧看 iframe 顶边位置（有没有回弹）＋ 帧率
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception))
  return r.result.value
}
const go = async (url) => { await send('Page.navigate', { url }); await sleep(1500) }

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
await go(APP)

// 已经装好了笔记（上一个脚本写进 localStorage），直接开
await evaluate(`(() => { const it = [...document.querySelectorAll('.note-item, .note-title')].find(e => e.textContent.includes('光伏板块')); (it?.closest('.note-item') || it)?.click() })()`)
await sleep(2500)
console.log('卡在模式：', await evaluate(`document.querySelector('.html-card')?.className`))

/* ---------- 1. 卡片模式：滚内部，逐帧看吸顶工具条 ---------- */
const cardScroll = await evaluate(`(() => new Promise((done) => {
  const f = document.querySelector('.html-card iframe')
  const d = f.contentDocument
  const root = d.scrollingElement || d.documentElement
  const tb = d.querySelector('.toolbar')
  const samples = []
  let n = 0
  function step() {
    root.scrollTop += 6
    const r = tb.getBoundingClientRect()
    samples.push({ s: Math.round(root.scrollTop), top: Math.round(r.top * 10) / 10 })
    if (++n < 120) requestAnimationFrame(step); else done(samples)
  }
  requestAnimationFrame(step)
}))()`)
const tbTops = cardScroll.map((s) => s.top)
let backjumps = 0
for (let i = 1; i < tbTops.length; i++) if (tbTops[i] < tbTops[i - 1] - 0.6) backjumps++
console.log('\n卡片模式·滚内部')
console.log('  scrollTop:', cardScroll.filter((_, i) => i % 12 === 0).map((s) => s.s).join(' '))
console.log('  工具条 top:', tbTops.filter((_, i) => i % 12 === 0).join(' '))
console.log('  同一 scrollTop 出现不同 top 的次数（抖动）:', backjumps)
console.log('  top 取值集合:', [...new Set(tbTops.map((v) => Math.round(v)))].join(', '))

/* ---------- 2. 融入模式：滚笔记容器，逐帧看 iframe 顶边 ---------- */
await evaluate(`(() => { const b = [...document.querySelectorAll('.html-card button')].find(x => x.textContent.includes('融入')); b?.click() })()`)
await sleep(2500)
const outerScroll = await evaluate(`(() => new Promise((done) => {
  const card = document.querySelector('.html-card')
  const f = card.querySelector('iframe')
  let n = card.parentElement, sc = null
  while (n) { const st = getComputedStyle(n); if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 1) { sc = n; break } n = n.parentElement }
  if (!sc) sc = document.scrollingElement
  sc.scrollTop = 0
  const samples = []
  let i = 0
  const t0 = performance.now()
  function step() {
    sc.scrollTop += 40
    const r = f.getBoundingClientRect()
    samples.push({ top: Math.round(r.top), st: Math.round(sc.scrollTop) })
    if (++i < 90) requestAnimationFrame(step)
    else done({ samples, ms: Math.round(performance.now() - t0) })
  }
  requestAnimationFrame(step)
}))()`)
const tops = outerScroll.samples.map((s) => s.top)
let backs = 0
for (let i = 1; i < tops.length; i++) if (tops[i] > tops[i - 1] + 1) backs++
console.log('\n融入模式·滚笔记')
console.log('  iframe 顶边:', tops.filter((_, i) => i % 10 === 0).join(' '))
console.log('  往回跳的次数:', backs)
console.log('  90 帧耗时:', outerScroll.ms, 'ms → 平均', (outerScroll.ms / 90).toFixed(1), 'ms/帧')
console.log('  帧耗时上限估计（掉帧说明滚动卡顿）:', outerScroll.ms > 90 * 25 ? '有掉帧' : '流畅')

ws.close()
