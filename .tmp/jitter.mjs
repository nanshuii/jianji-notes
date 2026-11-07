/**
 * 抖动诊断：用户刚改过字的 123KB 光伏全表，在「融入正文」模式下量 4 秒高度，
 * 看 iframe 高度是不是在两三个值之间来回跳。
 * 运行：APP_URL=http://127.0.0.1:4173/ node .tmp/jitter.mjs
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

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })

const go = async (url) => { await send('Page.navigate', { url }); await sleep(1500) }
await go(APP)
await evaluate('localStorage.clear()')
const fm = '---\ntitle: 光伏全表\ncreated: 2026-11-07T10:00:00.000Z\nupdated: 2026-11-07T10:00:00.000Z\npinned: false\n---\n\n'
// 和真实笔记一致：没有 mode 字段 → 默认融入正文
const meta = JSON.stringify({ file: 'html-jitter.html', title: '光伏工序级竞争格局全表', height: 900 })
const note = `${fm}网页上面的一段笔记文字。\n\n\`\`\`jianji-html\n${meta}\n\`\`\`\n\n网页下面的一段笔记文字。\n`
await evaluate(`(() => {
  const a = {}; a['html-jitter.html'] = ${JSON.stringify(html)}
  localStorage.setItem('jianji.assets.v1', JSON.stringify(a))
  const n = {}; n['股市/光伏抖动.md'] = ${JSON.stringify(note)}
  localStorage.setItem('jianji.notes.v1', JSON.stringify(n))
})()`)
await go(`${APP}?v=${Date.now()}`)
await evaluate(`(() => { const it = [...document.querySelectorAll('.note-item')].find(e => e.textContent.includes('光伏抖动')); it?.click() })()`)

// 采样：每 100ms 记一次 iframe 高度 + 内容量出来的高度
const samples = []
for (let i = 0; i < 45; i++) {
  const s = await evaluate(`(() => {
    const f = document.querySelector('.html-card.inline iframe')
    if (!f) return null
    const d = f.contentDocument
    if (!d || !d.body) return { frame: Math.round(f.getBoundingClientRect().height), content: -1, n: 0 }
    const kids = [...d.body.children].filter(el => {
      const st = d.defaultView.getComputedStyle(el)
      return st.display !== 'none' && st.position !== 'fixed'
    })
    const content = kids.length ? Math.max(...kids.map(el => el.getBoundingClientRect().bottom)) : 0
    return { frame: Math.round(f.getBoundingClientRect().height), content: Math.round(content), n: kids.length }
  })()`)
  samples.push(s)
  await sleep(100)
}

const frames = samples.filter(Boolean).map((s) => s.frame)
const uniq = [...new Set(frames)]
console.log('iframe 高度序列（每 100ms）：')
console.log(frames.join(' '))
console.log(`\n不同取值：${uniq.length} 个 → ${uniq.join(', ')}`)
console.log(`波动幅度：${Math.max(...frames) - Math.min(...frames)} px`)
console.log('\n最后 3 个采样：', JSON.stringify(samples.slice(-3)))

// 变化次数：相邻采样差 > 2px 算一次跳动
let flips = 0
for (let i = 1; i < frames.length; i++) if (Math.abs(frames[i] - frames[i - 1]) > 2) flips++
console.log(`跳动次数：${flips} / ${frames.length - 1} 次采样`)
ws.close()
