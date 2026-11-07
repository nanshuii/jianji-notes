/**
 * 截图看实际样子：卡片模式 + 融入模式各一张。
 * 运行：node .tmp/jitter-shot.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
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
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(resolve('.tmp', name), Buffer.from(r.data, 'base64'))
  console.log('已存', name)
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
await shot('jitter-card.png')
await evaluate(`(() => { const b = [...document.querySelectorAll('.html-card button')].find(x => x.textContent.includes('融入')); b?.click() })()`)
await sleep(2500)
await shot('jitter-inline-top.png')
await evaluate(`(() => {
  const card = document.querySelector('.html-card')
  let n = card.parentElement, sc = null
  while (n) { const st = getComputedStyle(n); if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 1) { sc = n; break } n = n.parentElement }
  ;(sc || document.scrollingElement).scrollTop = 3200
})()`)
await sleep(600)
await shot('jitter-inline-mid.png')
ws.close()
