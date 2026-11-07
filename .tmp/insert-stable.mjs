/**
 * 插入 HTML 时正文文字会不会被推来推去（用户说的「抖」）。
 *
 * 做法：笔记里放一段在下方的文字，插网页期间每 30ms 记一次它的 y 坐标。
 * 稳定 = y 只往一个方向走（一次到位），并且端点很少；
 * 抖 = y 上下反复（长一点、缩一点、再长）。
 *
 * 同时验证：量到的高度记进了笔记（fit 字段），下次打开一上来就是最终高度。
 * 运行：node .tmp/insert-stable.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ENDPOINT = 'http://127.0.0.1:9223'
const APP = process.env.APP_URL || 'http://127.0.0.1:4173/'
const REAL = resolve(process.env.HOME, 'Documents/简记/.assets/html-20261107-141713-64ae.html')
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
let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
}
const go = async (url) => { await send('Page.navigate', { url }); await sleep(1500) }
const setFile = async (selector, files) => {
  const doc = await send('DOM.getDocument', { depth: -1 })
  const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector })
  if (!node.nodeId) throw new Error(`找不到 input：${selector}`)
  await send('DOM.setFileInputFiles', { files, nodeId: node.nodeId })
}

await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 940, deviceScaleFactor: 1, mobile: false })
await go(`${APP}`)
await evaluate('localStorage.clear()')
const fm = '---\ntitle: 插图测试\ncreated: 2026-11-07T10:00:00.000Z\nupdated: 2026-11-07T10:00:00.000Z\npinned: false\n---\n\n'
const md = `${fm}上面的文字。\n\n下面的文字会跟着网页一起被推。\n`
await evaluate(`(() => {
  localStorage.setItem('jianji.assets.v1', '{}')
  localStorage.setItem('jianji.notes.v1', JSON.stringify({'测试/插图.md': ${JSON.stringify(md)}}))
})()`)
await go(`${APP}?v=${Date.now()}`)
await evaluate(`(() => { const it = [...document.querySelectorAll('.note-item, .note-title')].find(e => e.textContent.includes('插图')); (it?.closest('.note-item') || it)?.click() })()`)
await sleep(1200)

// 开始采样下方那段文字的 y，然后塞文件（走真实 change 事件 → insertHtmlEmbed）
const trail = await evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const node = [...document.querySelectorAll('.ProseMirror p')].find(p => p.textContent.includes('下面的文字'))
  if (!node) return { error: '找不到下面的文字' }
  window.__trail = []
  window.__sampling = setInterval(() => {
    window.__trail.push(Math.round(node.getBoundingClientRect().top))
  }, 30)
  return { ok: true }
})()`)
if (trail.error) throw new Error(trail.error)

await setFile('.html-picker', [REAL])
await sleep(6000)
const seq = await evaluate(`(() => { clearInterval(window.__sampling); return window.__trail })()`)

// 去掉连续重复，得到「文字真正被移动」的序列
const moves = []
for (const y of seq) if (!moves.length || Math.abs(moves[moves.length - 1] - y) > 2) moves.push(y)
let back = 0
const dir = Math.sign(moves[moves.length - 1] - moves[0])
for (let i = 1; i < moves.length; i++) if (Math.sign(moves[i] - moves[i - 1]) === -dir) back++
console.log('下方文字 y 的移动序列：', moves.join(' → '))
check('插入后网页进来了', await evaluate(`document.querySelectorAll('.html-card.inline iframe').length === 1`))
check('正文文字没有来回抖（没有反向移动）', back === 0, `反向 ${back} 次，共 ${moves.length} 个位置`)
check('一次到位，不是一截截往上顶', moves.length <= 3, `${moves.length} 个位置`)

const h = await evaluate(`Math.round(document.querySelector('.html-card iframe').getBoundingClientRect().height)`)
const content = await evaluate(`(() => {
  const d = document.querySelector('.html-card iframe').contentDocument
  const kids = [...d.body.children].filter(el => {
    const st = d.defaultView.getComputedStyle(el)
    return st.display !== 'none' && st.position !== 'fixed'
  })
  return Math.round(Math.max(...kids.map(el => el.getBoundingClientRect().bottom)))
})()`)
check('高度贴合内容', Math.abs(h - content) < 60, `${h} vs ${content}`)

// 笔记里应该记下了量到的高度
const saved = await evaluate(`(() => {
  const raw = JSON.parse(localStorage.getItem('jianji.notes.v1') || '{}')
  const key = Object.keys(raw).find(k => raw[k].includes('jianji-html'))
  return key ? raw[key] : ''
})()`)
let meta = null
try { meta = JSON.parse(saved.split('```jianji-html')[1].split('```')[0].trim()) } catch { /* ignore */ }
check('量到的高度存进了笔记（下次打开不用再撑）', !!meta && meta.fit > 1000, JSON.stringify(meta))
check('仍然默认融入正文', meta?.mode === 'inline', JSON.stringify(meta?.mode))

// 重新打开：高度应该一上来就是最终值，中间不能塌
await go(`${APP}?v=${Date.now()}`)
const reopen = await evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const it = [...document.querySelectorAll('.note-item, .note-title')].find(e => e.textContent.includes('插图'))
  ;(it?.closest('.note-item') || it)?.click()
  const rows = []
  for (let i = 0; i < 60; i++) {
    const f = document.querySelector('.html-card iframe')
    rows.push(f ? Math.round(f.getBoundingClientRect().height) : 0)
    await sleep(40)
  }
  return rows
})()`)
const real = reopen.filter((v) => v > 0)
const uniq = []
for (const v of real) if (!uniq.length || Math.abs(uniq[uniq.length - 1] - v) > 2) uniq.push(v)
console.log('重新打开时的高度序列：', uniq.join(' → '))
check('重开时不再从矮变高（一上来就摆好）', uniq.length <= 2, `${uniq.length} 个高度`)
check('重开高度对', Math.max(...real) > 1000, `${Math.max(...real)}px`)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
ws.close()
if (fail) process.exit(1)
