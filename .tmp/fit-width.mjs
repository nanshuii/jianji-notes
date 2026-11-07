/**
 * 为什么「插入前量」比「真的显示时量」高 176px：比宽度、比量法。
 * 运行：node .tmp/fit-width.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ENDPOINT = 'http://127.0.0.1:9223'
const APP = process.env.APP_URL || 'http://127.0.0.1:4173/'
const REAL = resolve(process.env.HOME, 'Documents/简记/.assets/html-20261107-141713-64ae.html')
const html = readFileSync(REAL, 'utf8')
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception))
  return r.result.value
}

await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 940, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `${APP}?v=${Date.now()}` })
await sleep(1500)

const out = await evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const it = [...document.querySelectorAll('.note-item, .note-title')].find(e => e.textContent.includes('插图'))
  ;(it?.closest('.note-item') || it)?.click()
  await sleep(2500)
  const f = document.querySelector('.html-card iframe')
  const body = document.querySelector('.rich-body')
  const r = f.getBoundingClientRect()
  const d = f.contentDocument

  const readAt = (doc) => {
    const win = doc.defaultView
    let h = 0
    for (const el of [...doc.body.children]) {
      const st = win.getComputedStyle(el)
      if (!st || st.display === 'none' || st.position === 'fixed') continue
      const rr = el.getBoundingClientRect()
      if (rr.height > 0 || rr.bottom > 0) h = Math.max(h, rr.bottom)
    }
    const pad = parseFloat(win.getComputedStyle(doc.body).paddingBottom) || 0
    return { h: Math.round(h + pad + 2), innerW: doc.documentElement.clientWidth, scrollW: doc.body.scrollWidth }
  }

  // 用隐藏 iframe 在不同宽度下量
  const assets = JSON.parse(localStorage.getItem('jianji.assets.v1') || '{}')
  const src = Object.values(assets).find((v) => typeof v === 'string' && v.includes('光伏产业链')) || ''
  const test = (width) => new Promise((done) => {
    const fr = document.createElement('iframe')
    fr.style.cssText = 'position:fixed;left:-99999px;top:0;border:0;visibility:hidden;height:1200px;width:' + width + 'px'
    fr.addEventListener('load', () => setTimeout(() => {
      const res = readAt(fr.contentDocument)
      fr.remove()
      done({ width, ...res })
    }, 350))
    fr.srcdoc = src
    document.body.appendChild(fr)
  })

  const widths = [body.clientWidth, body.clientWidth - 92, Math.round(r.width)]
  const measurements = []
  for (const w of widths) measurements.push(await test(Math.round(w)))

  return {
    noteWidth: Math.round(r.width),
    cardWidth: Math.round(f.clientWidth),
    bodyClientWidth: body.clientWidth,
    bodyContentWidth: Math.round(body.getBoundingClientRect().width - 92),
    realMeasure: readAt(d),
    frameHeight: Math.round(r.height),
    measurements,
  }
})()`)
console.log(JSON.stringify(out, null, 2))
ws.close()
