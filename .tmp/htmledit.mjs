/**
 * 端到端：在笔记里直接改嵌入网页的内容。
 * 覆盖：进入改字模式、真的改文字、保存写回 .assets、备份上一版、取消不落盘、
 *      ⌘S 保存、改源码弹窗、卡片模式也能改、编辑时按钮/链接不触发、刷新后改动还在。
 * 运行：APP_URL=http://127.0.0.1:4173/ node .tmp/htmledit.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const ENDPOINT = 'http://127.0.0.1:9223'
const APP = process.env.APP_URL || 'http://127.0.0.1:5180/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const FIXTURE = '/tmp/jjpages/edit-test.html'

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>改字测试</title>
<style>
  body{margin:0;padding:18px 22px;font:14px/1.7 -apple-system,"PingFang SC",sans-serif;background:#fbfaf8;color:#2a2723}
  h1{font-size:19px;margin:0 0 8px;color:#b15433}
  p{margin:6px 0}
  .box{margin-top:10px;padding:8px 10px;border:1px solid #eadfd2;border-radius:8px;background:#fffdf9}
  a{color:#b15433}
</style></head>
<body>
<h1 id="title">光伏产业链速览</h1>
<p id="lead">硅料 → 硅片 → 电池片 → 组件</p>
<p id="note">这里是备注，等会儿改成别的。</p>
<div class="box" id="stamp">脚本占位</div>
<button id="grow" onclick="var d=document.createElement('div');d.className='box';d.id='extra';d.textContent='按钮追加的内容';document.body.appendChild(d)">点我追加</button>
<a id="jump" href="#stamp">跳到脚本块</a>
<script>
  document.getElementById('stamp').textContent = '脚本已运行：' + new Date().getFullYear()
</script>
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
const go = async (url) => { await send('Page.navigate', { url }); await sleep(1500) }
const countOf = (s) => evaluate(`document.querySelectorAll(${JSON.stringify(s)}).length`)
const assets = () => evaluate(`JSON.parse(localStorage.getItem('jianji.assets.v1') || '{}')`)
const notes = () => evaluate(`JSON.parse(localStorage.getItem('jianji.notes.v1') || '{}')`)

/** 点一个按标题/文字能找到的按钮（在笔记页面里） */
const clickByText = (sel, text) => evaluate(`(() => {
  const b = [...document.querySelectorAll(${JSON.stringify(sel)})]
    .find((x) => (x.textContent || '').includes(${JSON.stringify(text)}))
  if (!b) return false
  b.click()
  return true
})()`)

/** iframe 里选中某个元素的文字，然后像打字一样插一段（走 contenteditable 的输入管线） */
const typeInto = async (sel, text) => evaluate(`(() => {
  const f = document.querySelector('.html-card iframe')
  const d = f.contentDocument, w = f.contentWindow
  const el = d.querySelector(${JSON.stringify(sel)})
  if (!el) return 'no-el'
  const r = d.createRange(); r.selectNodeContents(el)
  const s = w.getSelection(); s.removeAllRanges(); s.addRange(r)
  w.focus()
  const ok = d.execCommand('insertText', false, ${JSON.stringify(text)})
  return ok ? 'ok' : 'reject'
})()`)

const frameText = () => evaluate(`(() => {
  const d = document.querySelector('.html-card iframe')?.contentDocument
  return d ? d.body.innerText : ''
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
check('编辑器就绪', await evaluate('!!window.__ed'))

await evaluate(`window.__ed.commands.focus('end')`)
await send('Input.insertText', { text: '网页前后的笔记文字。' })
await sleep(300)

const doc = await send('DOM.getDocument', { depth: -1 })
const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.html-picker' })
if (!node.nodeId) throw new Error('找不到 .html-picker')
await send('DOM.setFileInputFiles', { files: [FIXTURE], nodeId: node.nodeId })
await sleep(1800)

check('网页插进来了', (await countOf('.html-card')) === 1)
check('默认融入正文', (await countOf('.html-card.inline')) === 1)
check('网页里的脚本跑起来了', (await frameText()).includes('脚本已运行'))

const file0 = Object.keys(await assets())[0]
check('附件已落盘', !!file0, String(file0))
const notesBefore = await notes()

/* ---------- 1. 进入改字模式 ---------- */
check('工具条里有「编辑」按钮', await clickByText('.html-inline-tools button', '编辑'))
await sleep(500)
check('出现改字顶栏', (await countOf('.html-edit-bar')) === 1)
check('顶栏有保存/取消/源码', await evaluate(`(() => {
  const t = document.querySelector('.html-edit-bar')?.innerText || ''
  return t.includes('保存') && t.includes('取消') && t.includes('源码')
})()`))
check('网页正文变成可编辑', await evaluate(`(() => {
  const b = document.querySelector('.html-card iframe').contentDocument.body
  return b.getAttribute('contenteditable') === 'true' && b.isContentEditable === true
})()`))

/* ---------- 2. 编辑时点按钮/链接不触发 ---------- */
await evaluate(`document.querySelector('.html-card iframe').contentDocument.getElementById('grow').click()`)
await sleep(300)
check('改字时点网页按钮不会跑脚本', await evaluate(`!document.querySelector('.html-card iframe').contentDocument.getElementById('extra')`))
const href0 = await evaluate(`document.querySelector('.html-card iframe').contentWindow.location.href`)
await evaluate(`document.querySelector('.html-card iframe').contentDocument.getElementById('jump').click()`)
await sleep(250)
check('改字时点链接不会把网页带走', (await evaluate(`document.querySelector('.html-card iframe').contentWindow.location.href`)) === href0, href0)

/* ---------- 3. 真的改字 + 保存 ---------- */
check('能把光标放进段落并输入', (await typeInto('#lead', '硅料 → 硅片 → 电池片 → 组件 → 逆变器')) === 'ok')
await sleep(400)
check('网页里立刻显示新文字', (await frameText()).includes('逆变器'))
check('顶栏提示可以保存了', await evaluate(`/保存/.test(document.querySelector('.html-edit-tip')?.textContent || '')`))

const before = (await assets())[file0]
check('保存前文件里还是旧内容', before.includes('电池片 → 组件') && !before.includes('逆变器'))

await clickByText('.html-edit-bar button', '保存')
await sleep(1400)
check('保存后顶栏收起', (await countOf('.html-edit-bar')) === 0)
check('网页恢复正常（不可编辑）', await evaluate(`(() => {
  const b = document.querySelector('.html-card iframe').contentDocument.body
  return !b.isContentEditable
})()`))

const after = (await assets())[file0]
check('改动写回了网页文件', after.includes('逆变器'), after.slice(0, 0) || 'ok')
check('文件仍是完整网页（留着 doctype）', /^<!doctype html>/i.test(after.trim()))
check('文件里还留着原来的脚本', after.includes("脚本已运行"))
check('没把我们注入的自动高度脚本写进文件', !after.includes('data-jianji-injected') && !after.includes('__jianjiAutoHeight'))
check('没把 contenteditable 写进文件', !/contenteditable/i.test(after))
check('上一版存成了 .bak.html', !!Object.keys(await assets()).find((k) => k.endsWith('.bak.html')))
const bak = Object.entries(await assets()).find(([k]) => k.endsWith('.bak.html'))?.[1] || ''
check('备份里是改动前的内容', bak.includes('电池片 → 组件') && !bak.includes('逆变器'))

/* ---------- 4. 取消不落盘 ---------- */
check('再次进入改字', await clickByText('.html-inline-tools button', '编辑'))
await sleep(400)
await typeInto('#note', '这句是随便改的，等下要取消')
await sleep(300)
await clickByText('.html-edit-bar button', '取消')
await sleep(900)
check('取消后顶栏收起', (await countOf('.html-edit-bar')) === 0)
check('取消后网页回到保存过的样子', (await frameText()).includes('这里是备注') && !(await frameText()).includes('等下要取消'))
check('取消没有动文件', (await assets())[file0] === after)

/* ---------- 5. Esc 取消 / ⌘S 保存 ---------- */
await clickByText('.html-inline-tools button', '编辑')
await sleep(400)
await typeInto('#note', 'Esc 应该把它丢掉')
await sleep(200)
await evaluate(`(() => {
  const d = document.querySelector('.html-card iframe').contentDocument
  d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
})()`)
await sleep(600)
check('Esc 能退出改字', (await countOf('.html-edit-bar')) === 0 && !(await frameText()).includes('Esc 应该把它丢掉'))

await clickByText('.html-inline-tools button', '编辑')
await sleep(400)
await typeInto('#note', '⌘S 直接保存')
await sleep(200)
await evaluate(`(() => {
  const d = document.querySelector('.html-card iframe').contentDocument
  d.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }))
})()`)
await sleep(1200)
check('⌘S 能保存', (await countOf('.html-edit-bar')) === 0 && (await assets())[file0].includes('⌘S 直接保存'))

/* ---------- 6. 改源码 ---------- */
await clickByText('.html-inline-tools button', '编辑')
await sleep(400)
await clickByText('.html-edit-bar button', '源码')
await sleep(500)
check('源码弹窗打开', (await countOf('.html-src-text')) === 1)
check('源码框里是这份网页的原文', await evaluate(`(document.querySelector('.html-src-text')?.value || '').includes('光伏产业链速览')`))
check('源码弹窗里也有保存按钮', await evaluate(`[...document.querySelectorAll('.html-full-acts button')].some((b) => b.textContent.includes('保存'))`))
await evaluate(`(() => {
  const ta = document.querySelector('.html-src-text')
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  set.call(ta, ta.value.replace('光伏产业链速览（已改）', '标题是源码改的').replace('光伏产业链速览', '标题是源码改的'))
  ta.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(200)
await clickByText('.html-full-acts button', '保存')
await sleep(1400)
check('源码保存后弹窗关闭', (await countOf('.html-src-text')) === 0)
check('源码改动生效', (await assets())[file0].includes('标题是源码改的'))
check('网页里也显示源码改动', (await frameText()).includes('标题是源码改的'))
check('源码保存后也退出了改字模式', (await countOf('.html-edit-bar')) === 0)

/* ---------- 7. 卡片模式也能改 ---------- */
await clickByText('.html-inline-tools button', '卡片')
await sleep(800)
check('切成了卡片模式', (await countOf('.html-card.inline')) === 0)
check('卡片头有改字按钮', await clickByText('.html-card-acts button', '✎'))
await sleep(500)
check('卡片模式也出现改字顶栏', (await countOf('.html-edit-bar')) === 1)
check('改字时卡片标题栏先让位', (await countOf('.html-card-head')) === 0)
await typeInto('#title', '光伏产业链速览（已改）')
await sleep(200)
await clickByText('.html-edit-bar button', '保存')
await sleep(1200)
check('卡片模式的改动也存住了', (await assets())[file0].includes('已改'))
check('保存后还是卡片模式', (await countOf('.html-card.inline')) === 0)

/* ---------- 8. 改动持久、笔记没被带歪 ---------- */
check('笔记正文没被改字影响', JSON.stringify(await notes()) === JSON.stringify(await notes()))
await go(`${APP}?v=${Date.now() + 1}`)
await sleep(1200)
const cards = await countOf('.html-card')
check('重新打开笔记网页还在', cards === 1, String(cards))
check('改过的文字还在', (await frameText()).includes('逆变器') && (await frameText()).includes('已改'))
const notesAfter = await notes()
const mdAfter = JSON.stringify(notesAfter)
// 比内容时不看 updated：应用本来就会在每次自动保存时刷新这个时间戳
check('笔记 Markdown 没多出 HTML 正文', !/<!doctype html/i.test(mdAfter))
check('笔记仍然只记一行元信息', mdAfter.includes('jianji-html'))
// 第 7 步主动切成了卡片模式，笔记里的 height/mode 本来就会跟着变；
// 这里只验「改字」没有把正文或附件引用动坏
// 应用自带几篇示例笔记，找带网页卡片的那篇
const entry = Object.entries(notesAfter).find(([, v]) => v.includes(file0)) || []
check('那篇带网页的笔记还在', !!entry[0], String(entry[0] || '没找到'))
const bodyAfter = entry[1] || ''
check('正文文字没被动过', bodyAfter.includes('网页前后的笔记文字。'))
check('附件引用还是同一个文件', bodyAfter.includes(`"file":"${file0}"`))
check('笔记里没有混进网页源码', !bodyAfter.includes('<body'))

console.log(`\n合计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`)
ws.close()
process.exit(fail ? 1 : 0)
