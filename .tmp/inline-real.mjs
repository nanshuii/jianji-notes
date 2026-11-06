/**
 * 真实数据验证：用户放进「光伏板块」的 122KB 长页面，按「融入正文」打开时
 * 高度能不能撑开、会不会越量越高、锚点和脚本是否照常可用。
 * 只在浏览器 localStorage 里造临时笔记，不碰 ~/Documents/简记 里的真实文件。
 * 运行：APP_URL=http://127.0.0.1:4173/ node .tmp/inline-real.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ENDPOINT = 'http://127.0.0.1:9223'
const APP = process.env.APP_URL || 'http://127.0.0.1:5180/'
const HTML_FILE = resolve(process.env.HOME, 'Documents/简记/.assets/html-20261105-220310-7249.html')
const html = readFileSync(HTML_FILE, 'utf8')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const targets = await (await fetch(`${ENDPOINT}/json/list`)).json()
const target = targets.find((t) => t.type === 'page')
if (!target) throw new Error('找不到页面 target')
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
let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
}
const go = async (url) => { await send('Page.navigate', { url }); await sleep(1500) }

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })

await go(APP)
await evaluate('localStorage.clear()')
const fm = '---\ntitle: 光伏融入验证\ncreated: 2026-11-06T10:00:00.000Z\nupdated: 2026-11-06T10:00:00.000Z\npinned: false\n---\n\n'
const meta = JSON.stringify({ file: 'html-real.html', title: '光伏产业链全表', height: 520, mode: 'inline' })
const note = `${fm}网页上面的一段笔记文字。\n\n\`\`\`jianji-html\n${meta}\n\`\`\`\n\n网页下面的一段笔记文字。\n`
await evaluate(`(() => {
  const a = {}; a['html-real.html'] = ${JSON.stringify(html)}
  localStorage.setItem('jianji.assets.v1', JSON.stringify(a))
  const n = {}; n['股市/光伏融入验证.md'] = ${JSON.stringify(note)}
  localStorage.setItem('jianji.notes.v1', JSON.stringify(n))
})()`)
await go(`${APP}?v=${Date.now()}`)
await evaluate(`(() => { const it = [...document.querySelectorAll('.note-item')].find(e => e.textContent.includes('光伏融入验证')); it?.click() })()`)
await sleep(2500)

check('真实长页面按融入模式打开', await evaluate(`document.querySelectorAll('.html-card.inline').length === 1`))
check('网页内容完整渲染', await evaluate(`(() => {
  const d = document.querySelector('.html-card iframe')?.contentDocument
  return !!d && d.body.innerHTML.length > 90000 && d.querySelectorAll('a[href^="#"]').length >= 59
})()`), await evaluate(`(() => { const d = document.querySelector('.html-card iframe')?.contentDocument; return d ? d.body.innerHTML.length + ' 字符 / ' + d.querySelectorAll('a[href^="#"]').length + ' 个锚点' : 'none' })()`))
check('页面里的脚本照常跑', await evaluate(`(() => {
  const d = document.querySelector('.html-card iframe').contentDocument
  return !!d && !d.body.innerText.includes('undefined') && d.body.innerText.length > 3000
})()`))

const samples = []
for (let i = 0; i < 6; i++) {
  samples.push(await evaluate(`(() => {
    const f = document.querySelector('.html-card iframe')
    const d = f.contentDocument
    const kids = [...d.body.children]
    const content = Math.max(...kids.map(el => el.getBoundingClientRect().bottom))
    return { frame: Math.round(f.getBoundingClientRect().height), content: Math.round(content) }
  })()`))
  await sleep(500)
}
const heights = samples.map((s) => s.frame)
check('高度稳定，没有越量越高', Math.max(...heights) - Math.min(...heights) <= 4, JSON.stringify(heights))
const last = samples[samples.length - 1]
check('整篇网页都铺开了（不是固定 520）', last.frame > 3000, `${last.frame}px`)
check('高度贴合真实内容', Math.abs(last.frame - last.content) < 60, JSON.stringify(last))

// 目录锚点：不白屏，滚的是笔记
const before = await evaluate(`(() => {
  let n = document.querySelector('.html-card').parentElement, s = null
  while (n) { const st = getComputedStyle(n); if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 1) { s = n; break } n = n.parentElement }
  window.__sc = s || document.scrollingElement
  window.__sc.scrollTop = 0
  return Math.round(window.__sc.scrollTop)
})()`)
await evaluate(`(() => {
  const d = document.querySelector('.html-card iframe').contentDocument
  const a = d.querySelector('a[href="#proc-1.1"]')
  a.click()
})()`)
await sleep(900)
const after = await evaluate(`(() => ({
  top: Math.round(window.__sc.scrollTop),
  len: document.querySelector('.html-card iframe').contentDocument.body.innerHTML.length,
  url: document.querySelector('.html-card iframe').contentWindow.location.href,
}))()`)
check('点「硅石开采」没有把网页弄白', after.len > 90000 && after.url === 'about:srcdoc', `${after.len} 字符`)
check('点锚点滚的是整篇笔记', after.top > before + 100, `${before} → ${after.top}`)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
ws.close()
if (fail) process.exit(1)
