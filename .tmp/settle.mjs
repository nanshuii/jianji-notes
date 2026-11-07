/**
 * 打开瞬间的高度变化：从点开笔记那一刻起，每 40ms 记一次 iframe 高度，
 * 看它是「平稳长大」还是「来回跳」——这是用户说的抖动最可能的来源。
 * 运行：node .tmp/settle.mjs
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
// 用融入模式开头，模拟「刚拖进来」的默认状态
const meta = JSON.stringify({ file: 'html-jitter.html', title: '光伏工序级竞争格局全表', height: 900, mode: 'inline' })
await evaluate(`(() => {
  localStorage.setItem('jianji.assets.v1', JSON.stringify({'html-jitter.html': ${JSON.stringify(html)}}))
  localStorage.setItem('jianji.notes.v1', JSON.stringify({'股市/光伏板块.md': ${JSON.stringify(fm + '```jianji-html\n' + meta + '\n```\n')}}))
})()`)
await go(`${APP}?v=${Date.now()}`)

// 点开笔记的同时开始采样（在页面里跑采样循环，避免 CDP 往返的抖动）
const rows = await evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const it = [...document.querySelectorAll('.note-item, .note-title')].find(e => e.textContent.includes('光伏板块'))
  ;(it?.closest('.note-item') || it)?.click()
  const rows = []
  const t0 = performance.now()
  for (let i = 0; i < 70; i++) {
    const f = document.querySelector('.html-card iframe')
    const d = f?.contentDocument
    let kids = 0, content = 0
    if (d && d.body) {
      const list = [...d.body.children].filter(el => {
        const st = d.defaultView.getComputedStyle(el)
        return st.display !== 'none' && st.position !== 'fixed'
      })
      kids = list.length
      content = list.length ? Math.round(Math.max(...list.map(el => el.getBoundingClientRect().bottom))) : 0
    }
    rows.push({ t: Math.round(performance.now() - t0), h: f ? Math.round(f.getBoundingClientRect().height) : 0, c: content, k: kids })
    await sleep(40)
  }
  return rows
})()`)

console.log('时间(ms) : iframe 高度 / 内容高度')
console.log(rows.filter((_, i) => i % 2 === 0).map((r) => `${r.t}:${r.h}/${r.c}`).join('  '))
const hs = rows.filter((r) => r.h > 0).map((r) => r.h)
let up = 0, down = 0
for (let i = 1; i < hs.length; i++) { if (hs[i] > hs[i - 1] + 2) up++; if (hs[i] < hs[i - 1] - 2) down++ }
console.log(`\n上涨 ${up} 次、回缩 ${down} 次，最小 ${Math.min(...hs)}、最大 ${Math.max(...hs)}`)
ws.close()
