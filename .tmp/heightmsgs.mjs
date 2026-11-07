/**
 * 记录 iframe 里上报的所有高度（postMessage），以及每次应用后的 iframe 高度，
 * 看打开后到底来回修正了多少次。
 * 运行：node .tmp/heightmsgs.mjs
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
const meta = JSON.stringify({ file: 'html-jitter.html', title: '光伏工序级竞争格局全表', height: 900, mode: 'inline' })
await evaluate(`(() => {
  localStorage.setItem('jianji.assets.v1', JSON.stringify({'html-jitter.html': ${JSON.stringify(html)}}))
  localStorage.setItem('jianji.notes.v1', JSON.stringify({'股市/光伏板块.md': ${JSON.stringify(fm + '```jianji-html\n' + meta + '\n```\n')}}))
  // 先挂监听，再开笔记
  window.__msgs = []; window.__frames = []
  window.addEventListener('message', (e) => {
    if (e.data && e.data.__jianjiHeightId) window.__msgs.push({ t: Math.round(performance.now()), h: e.data.height })
  })
  const t0 = performance.now()
  const loop = setInterval(() => {
    const f = document.querySelector('.html-card iframe')
    if (f) window.__frames.push({ t: Math.round(performance.now() - t0), h: Math.round(f.getBoundingClientRect().height) })
  }, 25)
  window.__stop = () => clearInterval(loop)
})()`)
await go(`${APP}?v=${Date.now()}`)
// 重新挂（页面刷新后丢了），这次先挂再点笔记
const res = await evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  window.__msgs = []; window.__frames = []
  window.addEventListener('message', (e) => {
    if (e.data && e.data.__jianjiHeightId) window.__msgs.push({ t: Math.round(performance.now()), h: e.data.height })
  })
  const t0 = performance.now()
  const it = [...document.querySelectorAll('.note-item, .note-title')].find(e => e.textContent.includes('光伏板块'))
  ;(it?.closest('.note-item') || it)?.click()
  for (let i = 0; i < 160; i++) {
    const f = document.querySelector('.html-card iframe')
    if (f) window.__frames.push({ t: Math.round(performance.now() - t0), h: Math.round(f.getBoundingClientRect().height) })
    await sleep(25)
  }
  return { msgs: window.__msgs, frames: window.__frames }
})()`)

const u = []
for (const f of res.frames) {
  if (!u.length || Math.abs(u[u.length - 1].h - f.h) > 2) u.push(f)
}
console.log('上报的高度（时间ms:值）：')
console.log(res.msgs.map((m) => `${m.t}:${m.h}`).join('  '))
console.log('\niframe 实际高度变化（去重，时间ms:值）：')
console.log(u.map((m) => `${m.t}:${m.h}`).join('  '))
ws.close()
