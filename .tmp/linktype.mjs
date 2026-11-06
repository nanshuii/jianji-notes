/**
 * 端到端：设好链接文字后，不换行直接接着打字，新字不能也被吞进链接里。
 * 运行：APP_URL=http://127.0.0.1:5180/ node .tmp/linktype.mjs
 */
const ENDPOINT = 'http://127.0.0.1:9223'
const APP = process.env.APP_URL || 'http://127.0.0.1:5180/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fm = (title) => `---\ntitle: ${title}\ncreated: 2026-11-06T10:54:24.627Z\nupdated: 2026-11-06T10:54:24.627Z\npinned: false\n---\n\n`
const NOTES = {
  '股市/不同商品对工业影响.md': fm('不同商品对工业影响') + '煤价：我觉得主要体现在电能方面\n',
  '股市/光伏板块.md': fm('光伏板块') + '# 产业链上游\n\n硅石开采与洗选是第一步，石英砂纯度决定牌号\n',
}

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
const store = () => evaluate(`JSON.parse(localStorage.getItem('jianji.notes.v1') || '{}')`)
/** 找出带 link mark 的文字片段 */
const marked = () => evaluate(`(() => {
  const out = []
  window.__ed.state.doc.descendants((node) => {
    if (node.isText && node.marks.some(m => m.type.name === 'link')) out.push(node.text)
  })
  return out
})()`)

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })

await go(APP)
await evaluate('localStorage.clear()')
await evaluate(`localStorage.setItem('jianji.notes.v1', ${JSON.stringify(JSON.stringify(NOTES))})`)
await go(`${APP}?v=${Date.now()}`)
await evaluate(`(() => { const it = [...document.querySelectorAll('.note-item')].find(e => e.textContent.includes('不同商品对工业影响')); it.click() })()`)
await sleep(900)
check('编辑器就绪', await evaluate(`!!window.__ed`))
check('Link mark 已关掉 inclusive', await evaluate(`window.__ed.schema.marks.link.spec.inclusive === false`),
  String(await evaluate(`window.__ed.schema.marks.link.spec.inclusive`)))

/* ---- 1. 光标空着，插入一条链接文字，然后直接接着打字 ---- */
await evaluate(`window.__ed.commands.focus('end')`)
await sleep(150)
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.rich-tools button')].find(e => (e.title || '').includes('链接到另一篇笔记'))
  b.click()
})()`)
await sleep(300)
await evaluate(`(() => { const b = [...document.querySelectorAll('.notelink-item')].find(e => e.textContent.includes('光伏板块')); b.click() })()`)
await sleep(250)
await evaluate(`(() => { const b = [...document.querySelectorAll('.notelink-lines .notelink-item')].find(e => e.textContent.includes('硅石开采')); b.click() })()`)
await sleep(200)
check('链接文字输入框可改', await evaluate(`!!document.querySelector('.notelink-label input')`))
await evaluate(`(() => {
  const i = document.querySelector('.notelink-label input')
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(i, '看硅石开采')
  i.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(150)
await evaluate(`document.querySelector('.notelink-acts .primary').click()`)
await sleep(500)
check('插入了笔记链接', await evaluate(`!!document.querySelector('.rich-body a[href^="jianji:note?"]')`))
const stored = await evaluate(`(() => {
  const m = window.__ed.state.storedMarks
  return m === null || m === undefined ? 'null' : m.map(x => x.type.name).join(',') || 'empty'
})()`)
check('光标上没有残留 link mark', stored === 'empty' || stored === 'null', stored)
check('只有链接文字带 link', JSON.stringify(await marked()) === JSON.stringify(['看硅石开采']), JSON.stringify(await marked()))

// 关键：不换行，直接输入
await send('Input.insertText', { text: '，接着写普通字' })
await sleep(700)
const marksAfter = await marked()
check('接着打的字没有被链接吞掉', marksAfter.join('') === '看硅石开采', JSON.stringify(marksAfter))
check('新字确实进了正文', await evaluate(`window.__ed.state.doc.textContent.includes('，接着写普通字')`))
const aText = await evaluate(`document.querySelector('.rich-body a[href^="jianji:note?"]')?.textContent ?? ''`)
check('DOM 里链接只包含链接文字', aText === '看硅石开采', aText)
const md1 = (await store())['股市/不同商品对工业影响.md'] || ''
check('落盘是「链接 + 普通文字」，在同一行', /\[看硅石开采\]\(jianji:note\?[^)]*\)，接着写普通字/.test(md1), md1.slice(-180))

/* ---- 2. 选中已有文字设链接，接着打字 ---- */
await evaluate(`localStorage.clear()`)
await evaluate(`localStorage.setItem('jianji.notes.v1', ${JSON.stringify(JSON.stringify(NOTES))})`)
await go(`${APP}?v=${Date.now()}`)
await evaluate(`(() => { const it = [...document.querySelectorAll('.note-item')].find(e => e.textContent.includes('不同商品对工业影响')); it.click() })()`)
await sleep(900)
const sel = await evaluate(`(() => {
  const ed = window.__ed
  let from = null, to = null
  ed.state.doc.descendants((node, pos) => {
    if (from !== null) return false
    if (node.isText && node.text.includes('煤价')) { from = pos; to = pos + 2; return false }
    return true
  })
  if (from === null) return 'no'
  ed.commands.setTextSelection({ from, to })
  return ed.state.doc.textBetween(from, to, ' ')
})()`)
check('选中了「煤价」两字', sel === '煤价', String(sel))
await evaluate(`(() => { const b = [...document.querySelectorAll('.rich-tools button')].find(e => (e.title || '').includes('链接到另一篇笔记')); b.click() })()`)
await sleep(300)
await evaluate(`(() => { const b = [...document.querySelectorAll('.notelink-item')].find(e => e.textContent.includes('光伏板块')); b.click() })()`)
await sleep(250)
await evaluate(`(() => { const b = [...document.querySelectorAll('.notelink-lines .notelink-item')].find(e => e.textContent.includes('硅石开采')); b.click() })()`)
await sleep(200)
await evaluate(`document.querySelector('.notelink-acts .primary').click()`)
await sleep(500)
check('选中的字变成了链接', (await marked()).join('') === '煤价', JSON.stringify(await marked()))
await send('Input.insertText', { text: '继续' })
await sleep(700)
check('给已有文字加链接后打字也不粘', (await marked()).join('') === '煤价', JSON.stringify(await marked()))
const md2 = (await store())['股市/不同商品对工业影响.md'] || ''
check('落盘里「继续」在链接外面', /\[煤价\]\(jianji:note\?[^)]*\)继续/.test(md2), md2.slice(-180))

/* ---- 3. 自动识别的网址后面接着打字 ---- */
await evaluate(`localStorage.clear()`)
await go(`${APP}?v=${Date.now()}`)
await evaluate(`(() => { const b = document.querySelector('.new-main'); b && b.click() })()`)
await sleep(900)
await evaluate(`window.__ed.commands.focus('end')`)
await sleep(150)
await send('Input.insertText', { text: 'https://example.com' })
await send('Input.insertText', { text: ' ' })
await sleep(500)
const auto = await marked()
check('网址被自动识别成链接', auto.length === 1 && auto[0].startsWith('https://example.com'), JSON.stringify(auto))
await send('Input.insertText', { text: '空格后继续打字' })
await sleep(700)
const auto2 = await marked()
check('自动链接后面的字也没被吞进去', auto2.length === 1 && !auto2[0].includes('空格后'), JSON.stringify(auto2))
const md3 = await evaluate(`Object.values(JSON.parse(localStorage.getItem('jianji.notes.v1') || '{}')).join('\\n')`)
check('落盘里网址只到自己那一截', md3.includes('空格后继续打字') && !md3.includes('[https://example.com 空格后'), md3.slice(-160))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
ws.close()
if (fail) process.exit(1)
