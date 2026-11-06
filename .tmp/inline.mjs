/**
 * 端到端：HTML 插入后「融入笔记正文」，同时网页里的特效照常可用。
 * 运行：APP_URL=http://127.0.0.1:5180/ node .tmp/inline.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const ENDPOINT = 'http://127.0.0.1:9223'
const APP = process.env.APP_URL || 'http://127.0.0.1:5180/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const FIXTURE = '/tmp/jjpages/inline-test.html'

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>融入测试</title>
<style>
  body{margin:0;padding:20px 24px;font:14px/1.6 -apple-system,"PingFang SC",sans-serif;background:#fbfaf8}
  h1{font-size:20px;margin:0 0 10px;color:#b15433}
  .tall{height:680px;background:linear-gradient(#fff6f1,#f3f0ea);border:1px solid #eadfd2;border-radius:8px;padding:10px}
  #target{margin-top:12px;padding:10px;background:#eef4ff}
</style></head><body>
<h1 id="top">融入正文测试页</h1>
<p id="lead">原本文字</p>
<a id="jump" href="#target">跳到目标</a>
<button id="grow" onclick="var d=document.createElement('div');d.className='tall';d.textContent='展开出来的内容';document.body.appendChild(d);this.textContent='已展开'">点我展开</button>
<div class="tall">第一块内容，专门用来把网页撑高</div>
<div id="target">目标段落：锚点应该把笔记滚到这里</div>
<script>document.getElementById('lead').textContent = '脚本跑起来了（特效保留）'</script>
</body></html>`

mkdirSync('/tmp/jjpages', { recursive: true })
writeFileSync(FIXTURE, PAGE, 'utf8')

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
const store = () => evaluate(`JSON.parse(localStorage.getItem('jianji.notes.v1') || '{}')`)

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
check('编辑器就绪', await evaluate(`!!window.__ed`))

// 先写一句，再插网页，再补一堆段落，好让笔记能滚
await evaluate(`window.__ed.commands.focus('end')`)
await send('Input.insertText', { text: '网页前面的一句话。' })
await sleep(300)
const doc = await send('DOM.getDocument', { depth: -1 })
const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.html-picker' })
if (!node.nodeId) throw new Error('找不到 .html-picker')
await send('DOM.setFileInputFiles', { files: [FIXTURE], nodeId: node.nodeId })
await sleep(1600)

/* ---- 1. 默认融入正文，不再是卡片 ---- */
check('插入后是一块网页', (await countOf('.html-card')) === 1)
check('默认是融入正文模式', (await countOf('.html-card.inline')) === 1)
check('没有卡片标题栏', (await countOf('.html-card-head')) === 0)
check('没有拖高度的把手', (await countOf('.html-resize')) === 0)
check('没有卡片外框（border/阴影都去掉）', await evaluate(`(() => {
  const s = getComputedStyle(document.querySelector('.html-card'))
  return s.borderTopWidth === '0px' && s.boxShadow === 'none'
})()`))
check('网页铺满纸张宽度', await evaluate(`(() => {
  const card = document.querySelector('.html-card'), paper = document.querySelector('.paper')
  return card.getBoundingClientRect().width > paper.getBoundingClientRect().width - 20
})()`))
const md0 = await evaluate(`(() => Object.values(JSON.parse(localStorage.getItem('jianji.notes.v1') || '{}')).join(' | '))()`)
check('元信息里记了 mode:inline', /"mode":"inline"/.test(md0), md0.split('\n').find((l) => l.includes('"file"')) || '')
check('正文里没有塞进整段 HTML', !/<!doctype html/i.test(md0))

/* ---- 2. 特效保留：脚本、按钮 ---- */
check('网页里的脚本照常跑', await evaluate(`(() => {
  const f = document.querySelector('.html-card iframe')
  return (f?.contentDocument?.body?.innerText || '').includes('脚本跑起来了（特效保留）')
})()`))
check('iframe 是可交互的 sandbox 网页', await evaluate(`(() => {
  const f = document.querySelector('.html-card iframe')
  return !!f && !!f.contentDocument && (f.getAttribute('sandbox') || '').includes('allow-scripts')
})()`))

/* ---- 3. 高度自动贴合内容，并随内容变化 ---- */
const geom = () => evaluate(`(() => {
  const f = document.querySelector('.html-card iframe')
  const d = f.contentDocument
  const kids = [...d.body.children]
  const content = Math.max(...kids.map(el => el.getBoundingClientRect().bottom))
  return { frame: Math.round(f.getBoundingClientRect().height), content: Math.round(content), inner: Math.round(d.scrollingElement.clientHeight) }
})()`)
const g0 = await geom()
check('iframe 高度按网页内容撑开（不是固定 520）', g0.frame > 600, JSON.stringify(g0))
check('高度贴合内容，底部不裁切', Math.abs(g0.frame - g0.content) < 40, JSON.stringify(g0))
check('网页内部没有第二条滚动条', await evaluate(`(() => {
  const d = document.querySelector('.html-card iframe').contentDocument
  return d.scrollingElement.scrollHeight <= d.scrollingElement.clientHeight + 30
})()`))

// 点网页里的按钮展开新内容：网页脚本照跑，笔记里的网页也跟着长高
await evaluate(`document.querySelector('.html-card iframe').contentDocument.getElementById('grow').click()`)
await sleep(900)
const g1 = await geom()
check('点网页里的按钮，交互生效', await evaluate(`document.querySelector('.html-card iframe').contentDocument.getElementById('grow').textContent === '已展开'`))
check('网页变高后笔记里的高度跟着长', g1.frame - g0.frame > 500, `${g0.frame} → ${g1.frame}`)
check('长高后仍贴合内容', Math.abs(g1.frame - g1.content) < 40, JSON.stringify(g1))

/* ---- 4. 网页里的 #锚点：不白屏，改成滚笔记 ---- */
await evaluate(`window.__ed.chain().focus('end').insertContent(
  Array.from({ length: 30 }, (_, i) => ({ type: 'paragraph', content: [{ type: 'text', text: '网页后面的第 ' + (i + 1) + ' 段笔记文字。' }] }))
).run()`)
await sleep(800)
const scrollInfo = () => evaluate(`(() => {
  let n = document.querySelector('.html-card').parentElement, s = null
  while (n) { const st = getComputedStyle(n); if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 1) { s = n; break } n = n.parentElement }
  s = s || document.scrollingElement
  window.__sc = s
  return { top: Math.round(s.scrollTop), max: s.scrollHeight - s.clientHeight }
})()`)
const before = await scrollInfo()
await evaluate(`document.querySelector('.html-card iframe').contentDocument.getElementById('jump').click()`)
await sleep(900)
const after = await scrollInfo()
check('点锚点没把 iframe 导航白掉', await evaluate(`(document.querySelector('.html-card iframe').contentDocument.body.innerText || '').includes('脚本跑起来了')`))
check('点锚点滚的是笔记正文', after.top > before.top + 50, `${before.top} → ${after.top}（可滚 ${after.max}）`)

/* ---- 5. 网页前后还能正常写字 ---- */
await evaluate(`window.__ed.commands.focus('end')`)
await send('Input.insertText', { text: '网页后面补的一句话' })
await sleep(700)
const md1 = await evaluate(`(() => Object.values(JSON.parse(localStorage.getItem('jianji.notes.v1') || '{}')).join(' | '))()`)
check('网页后还能接着写笔记', md1.includes('网页后面补的一句话'))
check('写完网页还在', /"mode":"inline"/.test(md1))

/* ---- 6. 模式可以来回切 ---- */
await evaluate(`document.querySelector('.html-inline-mode').click()`)
await sleep(700)
check('工具条能切回卡片模式', (await countOf('.html-card:not(.inline)')) === 1 && (await countOf('.html-card-head')) === 1)
check('切回卡片后高度写回元信息', await evaluate(`window.__ed.state.doc.content.content.some(n => n.type.name === 'htmlEmbed' && n.attrs.mode === 'card')`))
await evaluate(`(() => { const b = [...document.querySelectorAll('.html-card-head button')].find(e => e.textContent.includes('融入')); b.click() })()`)
await sleep(700)
check('卡片头部能再融入正文', (await countOf('.html-card.inline')) === 1 && (await countOf('.html-card-head')) === 0)

/* ---- 7. 刷新后仍是融入模式 ---- */
await go(`${APP}?v=${Date.now()}`)
await evaluate(`(() => { const it = document.querySelector('.note-item'); it && it.click() })()`)
await sleep(1400)
check('刷新后网页还在', (await countOf('.html-card')) === 1)
check('刷新后仍是融入正文', (await countOf('.html-card.inline')) === 1)
const g2 = await geom()
check('刷新后高度重新贴合内容', g2.frame > 600 && Math.abs(g2.frame - g2.content) < 40, JSON.stringify(g2))
check('刷新后网页脚本仍然跑', await evaluate(`(document.querySelector('.html-card iframe').contentDocument.body.innerText || '').includes('脚本跑起来了')`))

/* ---- 8. 融入模式的小工具条 ---- */
check('融入模式有悬浮工具条', (await countOf('.html-inline-tools')) === 1)
check('工具条上有「卡片 / 全屏 / 浏览器 / 删除」', await evaluate(`(() => {
  const t = document.querySelector('.html-inline-tools')
  return t.querySelectorAll('button').length >= 5
})()`))
await evaluate(`document.querySelector('.html-inline-tools .html-act.del').click()`)
await sleep(700)
check('× 能把融入的网页从笔记里移除', (await countOf('.html-card')) === 0)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
ws.close()
if (fail) process.exit(1)
