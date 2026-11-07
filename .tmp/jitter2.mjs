/**
 * 抖动诊断 v2：真实「光伏板块」笔记（卡片模式，height 900）与强制融入模式，
 * 各量 4 秒，看 iframe 高度、页面内容高度是不是来回跳。
 * 运行：node .tmp/jitter2.mjs
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
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })

await go(APP)
await evaluate('localStorage.clear()')
const fm = '---\ntitle: 光伏板块\ncreated: 2026-11-07T10:00:00.000Z\nupdated: 2026-11-07T10:00:00.000Z\npinned: false\n---\n\n'
const meta = JSON.stringify({ file: 'html-jitter.html', title: '光伏工序级竞争格局全表', height: 900 })
const note = `${fm}\`\`\`jianji-html\n${meta}\n\`\`\`\n`
await evaluate(`(() => {
  const a = {}; a['html-jitter.html'] = ${JSON.stringify(html)}
  localStorage.setItem('jianji.assets.v1', JSON.stringify(a))
  const n = {}; n['股市/光伏板块.md'] = ${JSON.stringify(note)}
  localStorage.setItem('jianji.notes.v1', JSON.stringify(n))
})()`)
await go(`${APP}?v=${Date.now()}`)
await evaluate(`(() => { const it = [...document.querySelectorAll('.note-item, .note-title')].find(e => e.textContent.includes('光伏板块')); (it?.closest('.note-item') || it)?.click() })()`)
await sleep(2500)

const probe = `(() => {
  const f = document.querySelector('.html-card iframe')
  if (!f) return null
  const d = f.contentDocument
  const fr = f.getBoundingClientRect()
  if (!d || !d.body) return { mode: f.closest('.html-card').className, frame: Math.round(fr.height), top: Math.round(fr.top) }
  const tb = d.querySelector('.toolbar')
  const kids = [...d.body.children].filter(el => {
    const st = d.defaultView.getComputedStyle(el)
    return st.display !== 'none' && st.position !== 'fixed'
  })
  return {
    mode: f.closest('.html-card').className,
    frame: Math.round(fr.height),
    top: Math.round(fr.top),
    bodyScroll: d.body.scrollHeight,
    docScroll: d.documentElement.scrollHeight,
    content: kids.length ? Math.round(Math.max(...kids.map(el => el.getBoundingClientRect().bottom))) : 0,
    innerScroll: Math.round((d.scrollingElement||d.documentElement).scrollTop),
    tbTop: tb ? Math.round(tb.getBoundingClientRect().top) : null,
    tbH: tb ? Math.round(tb.getBoundingClientRect().height) : null,
  }
})()`

const sample = async (tag, n = 24, gap = 120) => {
  const out = []
  for (let i = 0; i < n; i++) { out.push(await evaluate(probe)); await sleep(gap) }
  const ok = out.filter(Boolean)
  const frames = ok.map((s) => s.frame)
  let flips = 0
  for (let i = 1; i < frames.length; i++) if (Math.abs(frames[i] - frames[i - 1]) > 2) flips++
  console.log(`\n=== ${tag} ===`)
  console.log('mode:', ok[0]?.mode)
  console.log('iframe 高度:', frames.join(' '))
  console.log('内容高度:', ok.map((s) => s.content).join(' '))
  console.log('页面内 scrollTop:', ok.map((s) => s.innerScroll).join(' '))
  console.log('toolbar top（相对 iframe）:', ok.map((s) => s.tbTop).join(' '))
  console.log(`高度跳动 ${flips} 次，幅度 ${Math.max(...frames) - Math.min(...frames)}px`)
  return ok
}

await sample('卡片模式（真实笔记现在的样子）', 20)

// 切到融入模式再量
await evaluate(`(() => { const b = [...document.querySelectorAll('.html-card button')].find(x => x.textContent.includes('融入')); b?.click() })()`)
await sleep(3000)
await sample('融入正文模式', 24, 150)

ws.close()
