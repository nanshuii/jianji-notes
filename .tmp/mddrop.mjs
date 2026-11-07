/**
 * 端到端验证「笔记里嵌入 .md 文档」：
 * 选文件插入（默认融入正文）、排版渲染、frontmatter 剥离、源码编辑写回 + .bak.md、
 * 卡片⇄融入切换、刷新后还原、摘要显示「[文档]」。
 * 运行：APP_URL=http://127.0.0.1:4173/ node .tmp/mddrop.mjs
 */
const ENDPOINT = 'http://127.0.0.1:9223'
const APP = process.env.APP_URL || 'http://127.0.0.1:5180/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const targets = await (await fetch(`${ENDPOINT}/json/list`)).json()
const target = targets.find((t) => t.type === 'page')
if (!target) throw new Error('找不到页面 target')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', rej)
})

let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception))
  }
  return r.result.value
}

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
}

const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(160)
}

const boxOf = (selector, nth = 0) =>
  evaluate(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.x, top: r.y, w: r.width, h: r.height }
  })()`)

const clickTitle = async (selector, title) => {
  const ok = await evaluate(`(() => {
    const b = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((x) => (x.getAttribute('title') || '').includes(${JSON.stringify(title)}))
    if (!b) return false
    b.click()
    return true
  })()`)
  if (!ok) throw new Error(`点不到按钮：${selector} 标题含「${title}」`)
}

const clickSel = async (selector, nth = 0) => {
  const box = await boxOf(selector, nth)
  if (!box) throw new Error(`点不到元素：${selector}[${nth}]`)
  await clickAt(box.x, box.y)
  return box
}

const countOf = async (selector) => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
const textOf = async (selector) =>
  evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() ?? ''`)

const go = async (url) => {
  await send('Page.navigate', { url })
  await sleep(1500)
}

const setFile = async (selector, files) => {
  const doc = await send('DOM.getDocument', { depth: -1 })
  const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector })
  if (!node.nodeId) throw new Error(`找不到 input：${selector}`)
  await send('DOM.setFileInputFiles', { files, nodeId: node.nodeId })
}

const store = () => evaluate(`JSON.parse(localStorage.getItem('jianji.notes.v1') || '{}')`)
const assets = () => evaluate(`JSON.parse(localStorage.getItem('jianji.assets.v1') || '{}')`)
const mdWith = async (marker) => {
  const raw = await store()
  const key = Object.keys(raw).find((k) => raw[k].includes(marker))
  return key ? raw[key] : ''
}

/* 测试用的 .md：frontmatter + 常见排版 + 文内锚点 + 嵌套网页占位 */
const MD = `---
title: 光伏周报
author: 测试
---

# 光伏周报

本周**硅料**价格持平，*组件*上涨 ~~2%~~。

## 摘要

- 硅料成交价 ¥180/kg
- 组件排产环比 +3%

| 环节 | 价格 |
| ---- | ---- |
| 硅料 | 180 |
| 硅片 | 32 |

\`\`\`jianji-html
{"file":"html-嵌在文档里.html","title":"嵌套网页","height":300}
\`\`\`

## 结果

结论写在这里。[回到顶部](#光伏周报)

\`\`\`js
console.log('hello')
\`\`\`
`

/* ---------- 初始化 ---------- */
await send('Page.enable')
await send('Runtime.enable')
await send('DOM.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__errors = []
    window.addEventListener('error', (e) => window.__errors.push('error: ' + (e.message || e.type)))
    window.addEventListener('unhandledrejection', (e) =>
      window.__errors.push('rejection: ' + String((e.reason && e.reason.message) || e.reason)),
    )
  `,
})

await go(APP)
await evaluate(`localStorage.clear()`)
await go(`${APP}?v=${Date.now()}`)

check('应用启动成功', (await evaluate(`!!localStorage.getItem('jianji.bootJs')`)) === true)

/* ---------- 1. 插入 ---------- */
await clickSel('.new-main')
await sleep(1200)
await clickSel('.rich-body')
await sleep(200)
await send('Input.insertText', { text: '报告在下面：' })
await sleep(300)

const fs = await import('node:fs')
fs.mkdirSync('/tmp/jjmds', { recursive: true })
fs.writeFileSync('/tmp/jjmds/光伏周报.md', MD)
await setFile('.html-picker', ['/tmp/jjmds/光伏周报.md'])
await sleep(1600)

check('插入了一张文档卡片（默认融入正文）', (await countOf('.md-card.inline')) === 1, `count=${await countOf('.md-card')}`)
check('标题取自文件名', (await textOf('.md-card .html-inline-title')) === '光伏周报', await textOf('.md-card .html-inline-title'))

/* ---------- 2. 渲染 ---------- */
const rendered = await evaluate(`(() => {
  const el = document.querySelector('.md-card .md-render')
  return {
    h1: el?.querySelector('h1')?.textContent ?? '',
    tableCells: el?.querySelectorAll('td,th').length ?? 0,
    listItem: [...(el?.querySelectorAll('li') ?? [])].some((li) => li.textContent.includes('硅料成交价')),
    bold: !!el?.querySelector('strong'),
    strike: !!el?.querySelector('del, s'),
    codeBlock: (el?.querySelector('pre code')?.textContent ?? '').includes('hello'),
  }
})()`)
check('一级标题渲染出来', rendered.h1 === '光伏周报', rendered.h1)
check('表格渲染出来', rendered.tableCells >= 4, `${rendered.tableCells} 格`)
check('列表渲染出来', rendered.listItem === true)
check('粗体渲染出来', rendered.bold === true)
check('删除线渲染出来', rendered.strike === true)
check('普通代码块照常渲染', rendered.codeBlock === true)

const fmVisible = await evaluate(`(() => {
  const el = document.querySelector('.md-card .md-render')
  return (el?.textContent ?? '').includes('author: 测试')
})()`)
check('frontmatter 没有当成正文渲染', fmVisible === false)

const nested = await evaluate(`(() => {
  const el = document.querySelector('.md-card .md-nested-html')
  return el?.textContent ?? ''
})()`)
check('.md 里嵌的网页显示成占位块', nested.includes('嵌套网页'), nested.slice(0, 40))

/* ---------- 3. 落盘格式 ---------- */
const noteBody = await mdWith('报告在下面')
check(
  '正文里只留一行元信息',
  /```jianji-md\n\{"file":"md-[\d-]+-[0-9a-f]+\.md","title":"光伏周报","height":\d+,"mode":"inline"\}\n```/.test(noteBody),
  noteBody.split('\n').filter((l) => l.includes('jianji-md') || l.includes('"file"')).join(' '),
)
const assetList = await assets()
const mdKey = Object.keys(assetList).find((k) => k.endsWith('.md') && !k.includes('.bak.'))
check('md 存进了 .assets 且 frontmatter 原样保留', !!mdKey && assetList[mdKey].startsWith('---\ntitle: 光伏周报'), mdKey ?? '')
check(
  '笔记列表摘要显示「[文档]」',
  (await evaluate(`[...document.querySelectorAll('.note-item .note-sub')].some(e => e.textContent.includes('[文档]'))`)) === true,
  await evaluate(`[...document.querySelectorAll('.note-item .note-sub')].map(e => e.textContent.trim()).join(' / ')`),
)

/* ---------- 4. 文内锚点：点了不跳走，滚到标题 ---------- */
const linkBox = await boxOf('.md-card .md-render a[href^="#"]')
if (!linkBox) throw new Error('找不到文内锚点链接')
const urlBefore = await evaluate('location.href')
await clickAt(linkBox.x, linkBox.y)
await sleep(400)
check('锚点点击没有被导航走', (await evaluate('location.href')) === urlBefore)
check(
  '锚点滚到了「结果」那节',
  await evaluate(`(() => {
    const h = [...document.querySelectorAll('.md-card .md-render h2')].find(x => x.textContent.trim() === '结果')
    if (!h) return false
    const r = h.getBoundingClientRect()
    return r.top >= -50 && r.top < window.innerHeight
  })()`),
)

/* ---------- 5. 源码编辑：改字 → 保存 → 写回文件 + 留 .bak.md ---------- */
await clickTitle('.md-card .html-inline-mode', '改 Markdown 源码')
await sleep(500)
check('源码编辑窗弹出', (await countOf('.html-src-text')) === 1)
const oldSrc = await evaluate(`document.querySelector('.html-src-text').value`)
check('编辑窗里是 Markdown 源码（含 frontmatter）', oldSrc.startsWith('---\ntitle: 光伏周报'), oldSrc.slice(0, 24))
await evaluate(`(() => {
  const ta = document.querySelector('.html-src-text')
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, ta.value.replace('# 光伏周报', '# 光伏周报（改过）').replace('结论写在这里。', '结论改好了。'))
  ta.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(200)
await evaluate(`[...document.querySelectorAll('.html-full-acts button')].find(b => b.textContent.includes('保存'))?.click()`)
await sleep(900)
check('保存后编辑窗关闭', (await countOf('.html-src-text')) === 0)
const after = await assets()
check('改动写回了 .assets 里的那份 .md', !!mdKey && after[mdKey].includes('结论改好了。'))
check('frontmatter 没有被复制成两份', !!mdKey && (after[mdKey].match(/title: 光伏周报/g) ?? []).length === 1)
const bakKey = Object.keys(after).find((k) => k.endsWith('.bak.md'))
check('上一版留了 .bak.md 备份', !!bakKey && after[bakKey].includes('结论写在这里。'), bakKey ?? '')
check('保存后正文重新渲染出改动', (await textOf('.md-card .md-render h1')) === '光伏周报（改过）')
check(
  '保存后 frontmatter 仍然不显示',
  await evaluate(`(() => {
    const el = document.querySelector('.md-card .md-render')
    return !(el?.textContent ?? '').includes('author: 测试')
  })()`),
)

/* ---------- 6. 卡片 ⇄ 融入 ---------- */
await clickTitle('.md-card .html-inline-mode', '切回卡片模式')
await sleep(700)
const cardH = await evaluate(`(() => {
  const c = document.querySelector('.md-card:not(.inline)')
  if (!c) return null
  const body = c.querySelector('.md-card-body')
  return { h: Math.round(body.getBoundingClientRect().height), hasHead: !!c.querySelector('.html-card-head'), hasResize: !!c.querySelector('.html-resize') }
})()`)
check('切回卡片：有标题栏、固定高度、可拖拽', !!cardH && cardH.hasHead && cardH.hasResize && cardH.h > 60, JSON.stringify(cardH))
check('卡片模式下标题在标题栏', (await textOf('.md-card:not(.inline) .html-card-title')) === '光伏周报', await textOf('.md-card:not(.inline) .html-card-title'))
await clickTitle('.md-card .html-inline-mode', '融入正文')
await sleep(700)
check('再切回融入模式', (await countOf('.md-card.inline')) === 1)

/* ---------- 7. 刷新还原 ---------- */
await go(`${APP}?v=${Date.now()}`)
await sleep(500)
await evaluate(`(() => {
  const item = [...document.querySelectorAll('.note-item')].find(e => e.textContent.includes('报告在下面') || e.textContent.includes('2026'))
  item?.click()
  return !!item
})()`)
await sleep(1500)
check('刷新后文档还在（融入模式）', (await countOf('.md-card.inline')) === 1)
check('刷新后渲染的就是保存过的内容', (await textOf('.md-card .md-render h1')) === '光伏周报（改过）')
const bodyAgain = await mdWith('报告在下面')
check('刷新后笔记正文没有多出 fit/zoom 之类字段', !bodyAgain.includes('"fit"') && !bodyAgain.includes('"zoom"'), bodyAgain.match(/\{"file":"md-[^}]*\}/)?.[0] ?? '')

/* ---------- 8. 没有报错 ---------- */
const errors = await evaluate(`window.__errors || []`)
check('全程无报错', errors.length === 0, errors.join(' | '))

const failed = results.filter((r) => !r.ok)
console.log(`\n合计：${results.length} 项，失败 ${failed.length} 项`)
process.exit(failed.length ? 1 : 0)
