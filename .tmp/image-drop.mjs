/**
 * 端到端：图片直接拖进笔记（HTML5 拖放 / 粘贴截图 / 文件选择 / 混着网页一起拖）。
 * 运行：APP_URL=http://127.0.0.1:4173/ node .tmp/image-drop.mjs
 *
 * 桌面 Tauri 的原生拖放事件没法在无头浏览器里造，那条路径的分类与读取
 * 由 .tmp/verify-dropped.mjs（纯逻辑）+ src-tauri cargo test（二进制读取）覆盖；
 * 两条路径最终都汇入同一个 insertFiles，这里验的就是这段共用流程。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const ENDPOINT = 'http://127.0.0.1:9223'
const APP = process.env.APP_URL || 'http://127.0.0.1:5180/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------- 造一张真的 PNG（不依赖网络，也不碰用户笔记） ---------- */
const CRC = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function makePng(w, h) {
  const stride = w * 4 + 1
  const raw = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 4
      raw[o] = 198; raw[o + 1] = 72; raw[o + 2] = 48; raw[o + 3] = 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // 8 bit
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
mkdirSync('/tmp/jjpages', { recursive: true })
const PNG_FILE = '/tmp/jjpages/图片拖入测试.png'
const SVG_FILE = '/tmp/jjpages/矢量图测试.svg'
writeFileSync(PNG_FILE, makePng(24, 16))
writeFileSync(SVG_FILE, '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="24"><rect width="40" height="24" fill="#c64830"/></svg>')
const PNG_B64 = `data:image/png;base64,${makePng(24, 16).toString('base64')}`
const BIG_B64 = `data:image/png;base64,${makePng(2000, 100).toString('base64')}`
const SMALL_B64 = `data:image/png;base64,${makePng(8, 8).toString('base64')}`
const HTML_TEXT = '<!doctype html><html><body><h1>一起拖进来的网页</h1></body></html>'

/* ---------- CDP ---------- */
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
const go = async (url) => { await send('Page.navigate', { url }); await sleep(1400) }
const countOf = (s) => evaluate(`document.querySelectorAll(${JSON.stringify(s)}).length`)
const imgStats = () => evaluate(`[...document.querySelectorAll('.rich-body .img-wrap img')].map(i => ({
  mime: (i.getAttribute('src') || '').slice(0, 22),
  len: (i.getAttribute('src') || '').length,
  w: i.naturalWidth, h: i.naturalHeight,
}))`)
const diag = () => evaluate(`(() => ({
  body: document.querySelectorAll('.rich-body').length,
  imgs: document.querySelectorAll('.rich-body .img-wrap img').length,
  inputs: document.querySelectorAll('input[type=file]').length,
  errors: (window.__errors || []).slice(-4),
  notice: document.querySelector('.notice-bar')?.textContent?.trim() ?? '',
  text: (document.body.innerText || '').slice(0, 120),
}))()`)
const textOf = (s) => evaluate(`document.querySelector(${JSON.stringify(s)})?.textContent?.trim() ?? ''`)
const store = () => evaluate(`JSON.parse(localStorage.getItem('jianji.notes.v1') || '{}')`)
const mdOfCurrent = () => evaluate(`(() => {
  const s = JSON.parse(localStorage.getItem('jianji.notes.v1') || '{}')
  return Object.values(s).find(v => v.includes('AAA')) || ''
})()`)
const clickSel = async (sel, nth = 0) => {
  const r = await evaluate(`(() => {
    const e = document.querySelectorAll(${JSON.stringify(sel)})[${nth}]
    if (!e) return null
    const b = e.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  })()`)
  if (!r) return
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 })
}
const setFile = async (selector, files) => {
  const doc = await send('DOM.getDocument', { depth: -1 })
  const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector })
  if (!node.nodeId) throw new Error(`找不到 input：${selector}`)
  await send('DOM.setFileInputFiles', { files, nodeId: node.nodeId })
}
/** 在页面里造 File 并派发真正的 DragEvent / paste 事件 */
const dropFiles = (filesExpr, targetSel = '.rich-body', nth = 0) => evaluate(`(() => {
  const dt = new DataTransfer()
  for (const f of ${filesExpr}) dt.items.add(f)
  const el = document.querySelectorAll(${JSON.stringify(targetSel)})[${nth}] || document.querySelector(${JSON.stringify(targetSel)})
  const b = el.getBoundingClientRect()
  const x = b.left + Math.min(80, b.width / 2), y = b.top + b.height - 8
  const opt = { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }
  el.dispatchEvent(new DragEvent('dragover', opt))
  el.dispatchEvent(new DragEvent('drop', opt))
  return true
})()`)
const fileExpr = (b64, name, type = 'image/png') => `(() => {
  const bin = atob(${JSON.stringify(b64.split(',')[1])})
  const a = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i)
  return new File([a], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} })
})()`

/* ---------- 启动 ---------- */
await send('Page.enable')
await send('Runtime.enable')
await send('DOM.enable')
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__errors = [];
    window.addEventListener('error', e => window.__errors.push('error: ' + (e.message || e.type)));
    window.addEventListener('unhandledrejection', e => window.__errors.push('rejection: ' + String(e.reason)));`,
})
await go(APP)
await evaluate(`localStorage.clear()`)
await go(`${APP}?v=${Date.now()}`)
check('应用启动成功', (await evaluate(`!!localStorage.getItem('jianji.bootJs')`)) === true)

/* ---------- 1. 入口 ---------- */
const tools = await evaluate(`[...document.querySelectorAll('.rich-tools button')].map(b => b.textContent.trim())`)
check('工具栏有「图片」按钮', tools.includes('图片'), JSON.stringify(tools))
check('图片文件框支持多选', (await evaluate(`document.querySelector('input[type=file][accept="image/*"]')?.multiple`)) === true)
check('图片按钮提示写了可以直接拖进来', /拖进来/.test(await evaluate(`document.querySelector('.rich-tools button[title*="插入图片"]')?.title ?? ''`)))

/* ---------- 2. 拖入：按鼠标落点，而不是按光标 ---------- */
await clickSel('.new-main')
await sleep(1100)
check('新建笔记，编辑器就绪', (await countOf('.rich-body')) === 1)
await clickSel('.rich-body')
await send('Input.insertText', { text: 'AAA' })
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await send('Input.insertText', { text: 'BBB' })
await sleep(700)
check('先写了两段文字', (await countOf('.rich-body p')) === 2, String(await countOf('.rich-body p')))
// 把光标挪回第一段，然后往第二段的位置拖 —— 图片应该落在第二段
await evaluate(`window.__ed.commands.focus('start')`)
await sleep(200)
await dropFiles(`[${fileExpr(PNG_B64, '拖入的图片.png')}]`, '.rich-body p', 1)
await sleep(1200)
console.log('DIAG-DROP1', JSON.stringify(await imgStats()), JSON.stringify(await diag()))
check('拖图片进来生成了 img', (await countOf('.rich-body .img-wrap img')) === 1, String(await countOf('.rich-body .img-wrap img')))
check('图片按鼠标落点进了第二段（没插到光标所在的第一段）',
  (await evaluate(`!!document.querySelectorAll('.rich-body p')[1]?.querySelector('img')`)) === true,
  await evaluate(`[...document.querySelectorAll('.rich-body p')].map(p => p.textContent + (p.querySelector('img') ? '[IMG]' : '')).join(' | ')`))
check('图片真的显示出来了', (await evaluate(`(() => { const i = document.querySelector('.rich-body .img-wrap img'); return !!i && i.complete && i.naturalWidth > 0 })()`)) === true,
  await evaluate(`(() => { const i = document.querySelector('.rich-body .img-wrap img'); return i ? i.naturalWidth + 'x' + i.naturalHeight : 'none' })()`))
check('图片以 data URI 内嵌在正文里', /^data:image\//.test(await evaluate(`document.querySelector('.rich-body .img-wrap img')?.getAttribute('src') ?? ''`)))
await sleep(700)
let md = await mdOfCurrent()
check('落盘是标准 Markdown 图片语法', /!\[[^\]]*\]\(data:image\//.test(md), md.slice(0, 90))
check('两段文字都还在', /AAA/.test(md) && /BBB/.test(md))

/* ---------- 3. 大图自动压缩（长边 1600） ---------- */
await dropFiles(`[${fileExpr(BIG_B64, '大图.png')}]`)
await sleep(1300)
console.log('DIAG-BIG', JSON.stringify(await imgStats()), JSON.stringify(await diag()))
const bigW = await evaluate(`[...document.querySelectorAll('.rich-body .img-wrap img')].filter(i => i.getAttribute('src')?.startsWith('data:image/webp')).map(i => i.naturalWidth)`)
check('大图按老规矩压到长边 1600', bigW.includes(1600), JSON.stringify(bigW))
check('压缩后是 WebP', bigW.length > 0)

/* ---------- 4. 粘贴截图（clipboardData.files 为空、只有 items） ---------- */
const beforePaste = await countOf('.rich-body .img-wrap img')
await evaluate(`(() => {
  const dt = new DataTransfer()
  dt.items.add(${fileExpr(PNG_B64, '截图.png')})
  // 模拟 Chrome 有时只在 items 里给图片、files 却是空的那种剪贴板
  Object.defineProperty(dt, 'files', { get: () => [] })
  const ev = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'clipboardData', { value: dt })
  document.querySelector('.rich-body').dispatchEvent(ev)
})()`)
await sleep(1100)
console.log('DIAG-PASTE', JSON.stringify(await diag()))
check('截图粘贴（items 兜底）也能插图', (await countOf('.rich-body .img-wrap img')) === beforePaste + 1, `${beforePaste} → ${await countOf('.rich-body .img-wrap img')}`)

/* ---------- 5. 选文件插入：SVG 保持矢量 ---------- */
console.log('DIAG-BEFORE-SETFILE', JSON.stringify(await diag()))
const beforePick = await countOf('.rich-body .img-wrap img')
await setFile('input[type=file][accept="image/*"]', [SVG_FILE])
await sleep(1200)
const svgImgs = await evaluate(`[...document.querySelectorAll('.rich-body .img-wrap img')].filter(i => i.getAttribute('src')?.startsWith('data:image/svg+xml')).map(i => ({ ok: i.complete && i.naturalWidth > 0, w: i.naturalWidth }))`)
check('选 SVG 文件也能插进来', svgImgs.length === 1, JSON.stringify(svgImgs))
check('SVG 仍按矢量显示', svgImgs.some((x) => x.ok), JSON.stringify(svgImgs))
await setFile('input[type=file][accept="image/*"]', [PNG_FILE])
await sleep(1200)
check('选 PNG 文件也能插进来', (await countOf('.rich-body .img-wrap img')) === beforePick + 2, `${beforePick} → ${await countOf('.rich-body .img-wrap img')}`)

/* ---------- 6. 图片 + 网页一起拖 ---------- */
const beforeMixed = await countOf('.rich-body .img-wrap img')
const beforeCards = await countOf('.html-card')
await evaluate(`(() => {
  const dt = new DataTransfer()
  dt.items.add(${fileExpr(PNG_B64, '混合图片.png')})
  dt.items.add(new File([${JSON.stringify(HTML_TEXT)}], '混合网页.html', { type: 'text/html' }))
  const el = document.querySelector('.rich-body')
  const b = el.getBoundingClientRect()
  const opt = { bubbles: true, cancelable: true, clientX: b.left + 60, clientY: b.bottom - 8, dataTransfer: dt }
  el.dispatchEvent(new DragEvent('dragover', opt))
  el.dispatchEvent(new DragEvent('drop', opt))
})()`)
await sleep(1800)
check('混合拖入：图片进来了', (await countOf('.rich-body .img-wrap img')) === beforeMixed + 1, `${beforeMixed} → ${await countOf('.rich-body .img-wrap img')}`)
check('混合拖入：网页也进来了', (await countOf('.html-card')) === beforeCards + 1, `${beforeCards} → ${await countOf('.html-card')}`)
check('混合拖入不会把图片塞成卡片', (await countOf('.html-card img')) === 0)

/* ---------- 7. 不支持的文件 + 撤回 + 持久化 ---------- */
const beforeBad = await countOf('.rich-body .img-wrap img')
await evaluate(`(() => {
  const dt = new DataTransfer()
  dt.items.add(new File(['说明'], '说明.txt', { type: 'text/plain' }))
  const el = document.querySelector('.rich-body')
  const b = el.getBoundingClientRect()
  el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: b.left + 60, clientY: b.bottom - 8, dataTransfer: dt }))
})()`)
await sleep(700)
check('拖普通文件不会插图', (await countOf('.rich-body .img-wrap img')) === beforeBad)
check('拖普通文件会提示只认图片和网页', /只认图片/.test(await textOf('.notice-bar')), await textOf('.notice-bar'))

await evaluate(`window.__ed.commands.undo()`)
await sleep(800)
check('撤回能把刚插入的内容撤掉', (await countOf('.html-card')) === beforeCards)
await evaluate(`window.__ed.commands.redo()`)
await sleep(800)
check('重做能把它放回来', (await countOf('.html-card')) === beforeCards + 1)

/* ---------- 8. 一次拖多张：顺序不能反 ---------- */
await dropFiles(`[${fileExpr(PNG_B64, '第一张.png')}, ${fileExpr(SMALL_B64, '第二张.png')}]`)
await sleep(1400)
const lastTwo = await evaluate(`[...document.querySelectorAll('.rich-body .img-wrap img')].slice(-2).map(i => i.naturalWidth)`)
check('一次拖两张都进来了，且顺序不反', JSON.stringify(lastTwo) === '[24,8]', JSON.stringify(lastTwo))

await sleep(800)
const saved = await store()
const key = Object.keys(saved).find((k) => saved[k].includes('AAA'))
check('自动保存后 Markdown 里还有全部图片', (saved[key]?.match(/!\[/g) ?? []).length >= 5, String((saved[key]?.match(/!\[/g) ?? []).length))
await go(`${APP}?v=${Date.now() + 1}`)
await sleep(900)
const back = await evaluate(`(() => {
  const s = JSON.parse(localStorage.getItem('jianji.notes.v1') || '{}')
  return Object.values(s).find(v => v.includes('AAA')) || ''
})()`)
check('重开应用图片还在（往返不丢）', /data:image\//.test(back), back.slice(0, 60))

const errs = await evaluate(`window.__errors || []`)
check('全程没有 JS 报错', errs.length === 0, JSON.stringify(errs).slice(0, 200))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
ws.close()
if (fail) process.exit(1)
