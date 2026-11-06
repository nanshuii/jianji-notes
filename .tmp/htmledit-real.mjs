/**
 * 端到端（真实页面）：拿用户那份 122KB 光伏长页面，在笔记里改字并保存，
 * 确认复杂页面存回去之后结构没坏：id/脚本/样式都在，锚点还能跳，文件没被注入物污染。
 * 运行：APP_URL=http://127.0.0.1:4173/ node .tmp/htmledit-real.mjs
 */
const ENDPOINT = 'http://127.0.0.1:9223'
const APP = process.env.APP_URL || 'http://127.0.0.1:4173/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const REAL = '/Users/ledon/Documents/简记/.assets/html-20261105-220310-7249.html'

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
const go = async (url) => { await send('Page.navigate', { url }); await sleep(1600) }
const assets = () => evaluate(`JSON.parse(localStorage.getItem('jianji.assets.v1') || '{}')`)
const clickByText = (sel, text) => evaluate(`(() => {
  const b = [...document.querySelectorAll(${JSON.stringify(sel)})]
    .find((x) => (x.textContent || '').includes(${JSON.stringify(text)}))
  if (!b) return false
  b.click(); return true
})()`)

await send('Page.enable')
await send('Runtime.enable')
await send('DOM.enable')
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })

await go(APP)
await evaluate('localStorage.clear()')
await go(`${APP}?v=${Date.now()}`)
await evaluate(`(() => { const b = document.querySelector('.new-main'); b && b.click() })()`)
await sleep(1000)

const doc = await send('DOM.getDocument', { depth: -1 })
const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.html-picker' })
await send('DOM.setFileInputFiles', { files: [REAL], nodeId: node.nodeId })
await sleep(3000)

const file = Object.keys(await assets())[0]
const original = (await assets())[file] || ''
check('真实光伏页插进来了', !!original && original.length > 100000, `${original.length} 字节`)

const stats = () => evaluate(`(() => {
  const d = document.querySelector('.html-card iframe').contentDocument
  return {
    ids: d.querySelectorAll('[id]').length,
    scripts: d.querySelectorAll('script').length,
    styles: d.querySelectorAll('style').length,
    anchors: [...d.querySelectorAll('a[href^="#"]')].length,
    len: d.body.innerText.length,
    h2: d.querySelectorAll('h2').length,
  }
})()`)
const s0 = await stats()
check('页面结构完整（83 个 id / 章节 / 脚本）', s0.ids >= 80 && s0.h2 >= 8 && s0.scripts >= 2, JSON.stringify(s0))

/* 改字：把第二个 h2 改掉 */
check('进入改字模式', await clickByText('.html-inline-tools button', '编辑'))
await sleep(600)
check('真实页面也能编辑', await evaluate(`document.querySelector('.html-card iframe').contentDocument.body.isContentEditable === true`))
const typed = await evaluate(`(() => {
  const f = document.querySelector('.html-card iframe'), d = f.contentDocument, w = f.contentWindow
  const el = d.querySelectorAll('h2')[1]
  if (!el) return 'no-el'
  const r = d.createRange(); r.selectNodeContents(el)
  const s = w.getSelection(); s.removeAllRanges(); s.addRange(r)
  w.focus()
  return d.execCommand('insertText', false, '多晶硅（硅料·笔记里改过）') ? 'ok' : 'reject'
})()`)
check('能在真实页面里改标题', typed === 'ok')
await sleep(300)
await clickByText('.html-edit-bar button', '保存')
await sleep(2000)
check('保存后退出改字', (await evaluate(`document.querySelectorAll('.html-edit-bar').length`)) === 0)

const saved = (await assets())[file] || ''
check('改动写进了文件', saved.includes('笔记里改过'))
check('旧标题已经不在', !saved.includes('<h2>多晶硅（硅料）</h2>'))
check('文件仍是完整网页', /^<!doctype html>/i.test(saved.trim()) && saved.includes('</html>'))
check('文件没被撑大（快照没有爆炸）', saved.length < original.length * 1.35 && saved.length > original.length * 0.6, `${original.length} → ${saved.length}`)
check('没写进我们注入的脚本/样式', !saved.includes('data-jianji-injected') && !saved.includes('__jianjiAutoHeight'))
check('没留下 contenteditable', !/contenteditable/i.test(saved))

const s1 = await stats()
check('id 一个没少', s1.ids >= s0.ids - 1, `${s0.ids} → ${s1.ids}`)
check('锚点链接还在', s1.anchors >= s0.anchors - 1, `${s0.anchors} → ${s1.anchors}`)
check('章节数量没变', s1.h2 === s0.h2, `${s0.h2} → ${s1.h2}`)
check('页面文字量基本一致', Math.abs(s1.len - s0.len) < s0.len * 0.1, `${s0.len} → ${s1.len}`)

/* 保存后锚点仍然能跳，不会把网页弄白 */
const href0 = await evaluate(`document.querySelector('.html-card iframe').contentWindow.location.href`)
await evaluate(`(() => {
  const d = document.querySelector('.html-card iframe').contentDocument
  const a = [...d.querySelectorAll('a')].find((x) => (x.textContent || '').trim() === '硅石开采')
  a && a.click()
})()`)
await sleep(700)
check('点锚点没把网页带走', (await evaluate(`document.querySelector('.html-card iframe').contentWindow.location.href`)) === href0)
check('点完锚点内容还在（没白屏）', (await evaluate(`document.querySelector('.html-card iframe').contentDocument.body.innerText.length`)) > 5000)

console.log(`\n合计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`)
ws.close()
process.exit(fail ? 1 : 0)
