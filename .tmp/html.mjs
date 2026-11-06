/**
 * 端到端验证「笔记里嵌入 HTML 网页」：
 * 选文件 / 拖进来 / 粘贴 三种入口，卡片渲染、调高度、全屏、删除、持久化。
 * 运行：node .tmp/html.mjs   （可加 APP_URL 跑生产构建）
 *
 * 注：新插入的网页默认是「融入正文」模式，这套老用例验的是「卡片模式」，
 * 所以每次插入后先用编辑器命令切回 card。融入模式单独在 inline.mjs 里测。
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

/** 真鼠标双击：clickCount 给 2，浏览器才会发 dblclick */
const dblClickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 2 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 2 })
  await sleep(260)
}

const keyPress = async (key, code, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk })
  await sleep(200)
}

const boxOf = (selector, nth = 0) =>
  evaluate(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.x, top: r.y, w: r.width, h: r.height }
  })()`)

/** 按 title 点按钮：卡片头上的按钮增删过，用序号点不牢靠 */
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

/** 把刚插进来的网页切回卡片模式（走编辑器真实的 updateAttributes 路径） */
const toCard = () =>
  evaluate(`(() => {
    const ed = window.__ed
    return ed.commands.command(({ tr, state, dispatch }) => {
      let changed = false
      state.doc.descendants((node, pos) => {
        if (node.type.name === 'htmlEmbed' && node.attrs.mode !== 'card') {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, mode: 'card' })
          changed = true
        }
      })
      if (dispatch && changed) dispatch(tr)
      return changed
    })
  })()`)

const countOf = async (selector) => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
const textOf = async (selector) =>
  evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() ?? ''`)

const go = async (url) => {
  await send('Page.navigate', { url })
  await sleep(1500)
}

/** 给隐藏的 file input 塞文件（走真实的 change 事件） */
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
/** 把元素滚到视口中间再点，免得坐标跑到屏幕外 */
const scrollTo = async (selector, nth = 0) => {
  await evaluate(`document.querySelectorAll(${JSON.stringify(selector)})[${nth}]?.scrollIntoView({ block: 'center' })`)
  await sleep(400)
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>十月复盘</title>
<style>body{font-family:-apple-system,"PingFang SC",sans-serif;margin:0;padding:20px}h1{color:#c05f3a;font-size:20px;margin:0 0 8px}</style>
</head>
<body>
  <h1 id="headline">十月复盘</h1>
  <p id="lead">这个月一共记了 12 笔支出</p>
  <div class="kpi"><span>支出 ¥1,284</span></div>
  <script>document.getElementById('lead').textContent += '（脚本跑起来了）'</script>
</body></html>`

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
    const origErr = console.error
    console.error = (...a) => { window.__errors.push('console.error: ' + a.map(String).join(' ')); origErr(...a) }
  `,
})

await go(APP)
await evaluate(`localStorage.clear()`)
await go(`${APP}?v=${Date.now()}`)

check('应用启动成功', (await evaluate(`!!localStorage.getItem('jianji.bootJs')`)) === true)

/* ---------- 1. 入口：工具栏按钮 + 文件框 ---------- */
const tools = await evaluate(`[...document.querySelectorAll('.rich-tools button')].map(b => b.textContent.trim())`)
check('工具栏多了「HTML」按钮', tools.includes('HTML'), JSON.stringify(tools))
check(
  'HTML 文件框只收网页文件',
  (await evaluate(`document.querySelector('.html-picker')?.getAttribute('accept') ?? ''`)) ===
    '.html,.htm,.xhtml,text/html',
  await evaluate(`document.querySelector('.html-picker')?.getAttribute('accept') ?? ''`),
)

/* ---------- 2. 选文件插入 ---------- */
await clickSel('.new-main')
await sleep(1200)
check('新建了笔记，编辑器就绪', (await countOf('.rich-body')) === 1)

// 先在正文里写一句话，插入后应该出现在这句话后面
await clickSel('.rich-body')
await sleep(200)
await send('Input.insertText', { text: '报表放在下面：' })
await sleep(300)

await setFile('.html-picker', ['/tmp/jjpages/十月复盘.html'])
await sleep(1400)
await toCard()
await sleep(700)

check('插入了一张网页卡片', (await countOf('.html-card')) === 1)
check('卡片标题取文件名', (await textOf('.html-card-title')) === '十月复盘', await textOf('.html-card-title'))
check('卡片显示了文件大小', /.+B|KB/.test(await textOf('.html-card-size')), await textOf('.html-card-size'))
check('卡片里是 iframe', (await countOf('.html-card iframe')) === 1)

const frameInfo = await evaluate(`(() => {
  const f = document.querySelector('.html-card iframe')
  return {
    srcdocHasHeadline: (f.getAttribute('srcdoc') || '').includes('十月复盘'),
    visibleText: f.contentDocument?.body?.innerText ?? '',
    height: Math.round(f.getBoundingClientRect().height),
  }
})()`)
check('iframe 里就是这份网页', frameInfo.srcdocHasHeadline === true)
check('网页里的脚本真的跑起来了', frameInfo.visibleText.includes('脚本已跑起来'), frameInfo.visibleText.slice(0, 40))
check('iframe 撑开了卡片高度', frameInfo.height > 100, `${frameInfo.height}px`)

/* ---------- 3. 落盘格式 ---------- */
const noteBody = await mdWith('报表放在下面')
check('正文里只留一行元信息', /```jianji-html\n\{"file":"html-[\d-]+-[0-9a-f]+\.html","title":"十月复盘","height":\d+\}\n```/.test(noteBody), noteBody.split('\n').filter((l) => l.includes('jianji-html') || l.includes('"file"')).join(' '))
check('正文里没有把整段 HTML 塞进去', !/<!doctype html/i.test(noteBody))
const assetList = await assets()
check('网页存进了 .assets', Object.keys(assetList).length === 1 && /kpi/.test(Object.values(assetList)[0]), JSON.stringify(Object.keys(assetList)))
check(
  '笔记列表摘要显示「[网页]」而不是那串 JSON',
  (await evaluate(`[...document.querySelectorAll('.note-item .note-sub')].some(e => e.textContent.includes('[网页]'))`)) === true,
  await evaluate(`[...document.querySelectorAll('.note-item .note-sub')].map(e => e.textContent.trim()).join(' / ')`),
)

/* ---------- 4. 块级：前后都还能写 ---------- */
const layout = await evaluate(`(() => {
  const body = document.querySelector('.rich-body')
  const kids = [...body.children].map((el) => el.classList?.contains('html-card') ? 'CARD' : el.tagName)
  return { kids, beforeText: body.querySelector('p')?.textContent ?? '' }
})()`)
check('卡片是独立的一块（前后各一段）', JSON.stringify(layout.kids) === '["P","DIV","P"]', JSON.stringify(layout.kids))
check('插入前的文字还在', layout.beforeText.includes('报表放在下面'), layout.beforeText)

/* ---------- 5. 拖进来 ---------- */
await evaluate(`(() => {
  const dt = new DataTransfer()
  dt.items.add(new File([${JSON.stringify(PAGE.replace('十月复盘', '拖进来的报表'))}], '拖进来的报表.html', { type: 'text/html' }))
  const body = document.querySelector('.rich-body')
  const r = body.getBoundingClientRect()
  const x = r.left + 60, y = r.bottom - 40
  body.dispatchEvent(new DragEvent('dragover', { bubbles: true, clientX: x, clientY: y, dataTransfer: dt }))
  body.dispatchEvent(new DragEvent('drop', { bubbles: true, clientX: x, clientY: y, dataTransfer: dt }))
})()`)
await sleep(1400)
await toCard()
await sleep(700)
check('拖进来的网页也能变卡片', (await countOf('.html-card')) === 2, `${await countOf('.html-card')} 张`)
check(
  '拖进来的卡片按落点排在后面',
  (await evaluate(`[...document.querySelectorAll('.html-card-title')].map(e => e.textContent.trim()).join('>')`)) ===
    '十月复盘>拖进来的报表',
  await evaluate(`[...document.querySelectorAll('.html-card-title')].map(e => e.textContent.trim()).join('>')`),
)

// 拖一个不是网页的文件：不该插卡片，也不该报错
await evaluate(`(() => {
  const dt = new DataTransfer()
  dt.items.add(new File(['说明文字'], '说明.txt', { type: 'text/plain' }))
  const body = document.querySelector('.rich-body')
  const r = body.getBoundingClientRect()
  body.dispatchEvent(new DragEvent('drop', { bubbles: true, clientX: r.left + 60, clientY: r.bottom - 40, dataTransfer: dt }))
})()`)
await sleep(900)
check('拖普通文件不会变成卡片', (await countOf('.html-card')) === 2, `${await countOf('.html-card')} 张`)
check(
  '拖普通文件会提示「只认图片和 .html」',
  /只认图片/.test(await textOf('.notice-bar')),
  await textOf('.notice-bar'),
)

/* ---------- 6. 粘贴 ---------- */
// 用编辑器命令把光标放到末尾（点正文中心容易点到卡片上，变成选中卡片）
await evaluate(`window.__ed.commands.focus('end')`)
await sleep(200)
const pasteOk = await evaluate(`(() => {
  try {
    const dt = new DataTransfer()
    dt.items.add(new File([${JSON.stringify(PAGE.replace('十月复盘', '粘贴的页面'))}], '粘贴的页面.html', { type: 'text/html' }))
    const ev = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', { value: dt })
    document.querySelector('.rich-body').dispatchEvent(ev)
    return true
  } catch (e) { return String(e) }
})()`)
await sleep(1400)
await toCard()
await sleep(700)
check('粘贴一份网页文件也能插进来', pasteOk === true && (await countOf('.html-card')) === 3, `${pasteOk} / ${await countOf('.html-card')} 张`)

/* ---------- 7. 拖底部调高度 ---------- */
/** 按卡片标题量 iframe 高度：同屏有多张卡片时不能盲取第一个 */
const frameHOf = (title) =>
  evaluate(`(() => {
    const card = [...document.querySelectorAll('.html-card')].find(c => c.querySelector('.html-card-title')?.textContent.trim() === ${JSON.stringify(title)})
    const f = card?.querySelector('iframe')
    return f ? Math.round(f.getBoundingClientRect().height) : -1
  })()`)

await scrollTo('.html-card', 0)
await sleep(400)
const before = await frameHOf('十月复盘')
// 先把鼠标移到手柄上（顺带让卡片进入 hover），再重新量一次坐标，避免卡片自动收高后坐标失效
const hover = await boxOf('.html-card .html-resize', 0)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hover.x, y: hover.y })
await sleep(200)
const handle = await boxOf('.html-card .html-resize', 0)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: handle.x, y: handle.y, button: 'left', buttons: 1, clickCount: 1 })
await sleep(120)
// 往下拖的过程中指针会落到下面那张卡片的 iframe 上，这正是要验的场景
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x, y: handle.y + 60, button: 'left', buttons: 1 })
await sleep(120)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x, y: handle.y + 140, button: 'left', buttons: 1 })
await sleep(120)
const maskOn = await countOf('.html-resize-mask')
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x, y: handle.y + 140, button: 'left', buttons: 1, clickCount: 1 })
await sleep(1000)
const after = await frameHOf('十月复盘')
check('拖底部能把卡片拉高', after - before > 100, `${before} → ${after}`)
check('拖动期间鼠标被透明罩接住', maskOn === 1, `${maskOn} 层`)
check('松手后透明罩撤掉', (await countOf('.html-resize-mask')) === 0)
const mdAfterResize = await mdWith('报表放在下面')
check('新高度写进了正文', new RegExp(`"height":${after}`).test(mdAfterResize), mdAfterResize.split('\n').find((l) => l.includes('"file"')))

/* ---------- 8. 全屏 ---------- */
await scrollTo('.html-card', 0)
await clickTitle('.html-card .html-act', '全屏看')
await sleep(500)
check('全屏打开了大图', (await countOf('.html-full')) === 1)
check('全屏里也是这份网页', (await evaluate(`(document.querySelector('.html-full iframe')?.getAttribute('srcdoc') || '').includes('十月复盘')`)) === true)
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
await sleep(400)
check('Esc 能退出全屏', (await countOf('.html-full')) === 0)

/* ---------- 9. 在浏览器打开 ---------- */
await evaluate(`window.__opened = ''; window.open = (u) => { window.__opened = u; return null }`)
await scrollTo('.html-card', 0)
await clickTitle('.html-card .html-act', '用浏览器打开')
await sleep(600)
check(
  '「↗」把网页丢给浏览器',
  String(await evaluate(`window.__opened`)).startsWith('blob:'),
  String(await evaluate(`window.__opened`)).slice(0, 24),
)

/* ---------- 10. 重新载入 ---------- */
await evaluate(`(() => {
  const raw = JSON.parse(localStorage.getItem('jianji.assets.v1'))
  const key = Object.keys(raw)[0]
  raw[key] = raw[key].replace('10 月改过了', '10 月改过了') + '<p id="changed">文件被换成新版了</p>'
  localStorage.setItem('jianji.assets.v1', JSON.stringify(raw))
})()`)
await scrollTo('.html-card', 0)
await clickTitle('.html-card .html-act', '重新载入')
await sleep(900)
check(
  '「↻」能把外部的改动重新读进来',
  (await evaluate(`(document.querySelector('.html-card iframe')?.getAttribute('srcdoc') || '').includes('文件被换成新版了')`)) === true,
)

/* ---------- 11. 刷新后还在 ---------- */
const beforeReload = await countOf('.html-card')
await go(`${APP}?v=${Date.now()}`)
await sleep(800)
await evaluate(`(() => {
  const it = [...document.querySelectorAll('.note-item')].find(e => e.textContent.includes('报表放在下面'))
  it?.click()
})()`)
await sleep(1500)
check('重新打开笔记，卡片还在', (await countOf('.html-card')) === beforeReload, `${beforeReload} → ${await countOf('.html-card')} 张`)
check(
  '重新打开后网页照样渲染',
  (await evaluate(`(document.querySelector('.html-card iframe')?.getAttribute('srcdoc') || '').includes('十月复盘')`)) === true,
)
const heightStill = await frameHOf('十月复盘')
check('调过的高度留住了', Math.abs(heightStill - after) <= 2, `${heightStill} vs ${after}`)

/* ---------- 12. 删除卡片 ---------- */
await scrollTo('.html-card', 0)
await clickSel('.html-card .html-act.del', 0)
await sleep(1000)
check('× 能把卡片从笔记里拿掉', (await countOf('.html-card')) === beforeReload - 1, `${beforeReload} → ${await countOf('.html-card')}`)
const mdAfterDel = await mdWith('报表放在下面')
check(
  '正文里的围栏也一起去掉',
  (mdAfterDel.match(/jianji-html/g) ?? []).length === beforeReload - 1,
  String((mdAfterDel.match(/jianji-html/g) ?? []).length),
)
check('删卡片不会删掉 .assets 里的文件', Object.keys(await assets()).length === 3, `${Object.keys(await assets()).length} 份`)

/* ---------- 13. 手写的围栏也能认 ---------- */
await evaluate(`(() => {
  const raw = JSON.parse(localStorage.getItem('jianji.notes.v1'))
  const key = Object.keys(raw).find(k => k.includes('报表放在下面'))
  const body = raw[key]
  raw['手写网页.md'] = '---\\ntitle: 手写网页\\ncreated: 2026-11-01T00:00:00.000Z\\nupdated: 2026-11-01T00:00:00.000Z\\npinned: false\\n---\\n\\n' +
    '开头一句话\\n\\n\`\`\`jianji-html\\n' + JSON.stringify({ file: Object.keys(JSON.parse(localStorage.getItem('jianji.assets.v1')))[0], title: '手写网页', height: 360 }) + '\\n\`\`\`\\n'
  raw['坏掉的网页.md'] = '---\\ntitle: 坏掉的网页\\ncreated: 2026-11-01T00:00:00.000Z\\nupdated: 2026-11-01T00:00:00.000Z\\npinned: false\\n---\\n\\n\`\`\`jianji-html\\n不是 json\\n\`\`\`\\n'
  raw['丢了的网页.md'] = '---\\ntitle: 丢了的网页\\ncreated: 2026-11-01T00:00:00.000Z\\nupdated: 2026-11-01T00:00:00.000Z\\npinned: false\\n---\\n\\n\`\`\`jianji-html\\n' + JSON.stringify({ file: '不存在.html', title: '没了', height: 300 }) + '\\n\`\`\`\\n'
  localStorage.setItem('jianji.notes.v1', JSON.stringify(raw))
})()`)
await go(`${APP}?v=${Date.now()}`)
await evaluate(`(() => {
  const it = [...document.querySelectorAll('.note-item')].find(e => e.textContent.includes('手写网页'))
  it?.click()
})()`)
await sleep(1200)
check('手写进正文的围栏也能变成卡片', (await countOf('.html-card')) === 1)
check('手写卡片按记录的高度显示', (await evaluate(`Math.round(document.querySelector('.html-card iframe').getBoundingClientRect().height)`)) === 360, String(await evaluate(`Math.round(document.querySelector('.html-card iframe').getBoundingClientRect().height)`)))

// 再写一个字，围栏不能丢
await clickSel('.rich-body')
await sleep(150)
await send('Input.insertText', { text: '补一句' })
await sleep(800)
const handMd = await mdWith('开头一句话')
check('编辑后围栏还在（往返不丢）', /```jianji-html/.test(handMd) && /"file":/.test(handMd), handMd.split('\n').filter((l) => l.includes('jianji-html')).join(' '))

await evaluate(`(() => {
  const it = [...document.querySelectorAll('.note-item')].find(e => e.textContent.includes('坏掉的网页'))
  it?.click()
})()`)
await sleep(1000)
check('JSON 写坏了就当普通代码块，不崩', (await countOf('.html-card')) === 0 && (await countOf('.rich-body pre')) === 1, `${await countOf('.html-card')} 卡片 / ${await countOf('.rich-body pre')} 代码块`)

await evaluate(`(() => {
  const it = [...document.querySelectorAll('.note-item')].find(e => e.textContent.includes('丢了的网页'))
  it?.click()
})()`)
await sleep(1000)
check('附件丢了会明说打不开', (await countOf('.html-card.broken')) === 1 && /打不开/.test(await textOf('.html-card-err')), await textOf('.html-card-err'))

/* ---------- 14. 双击标题改名 ---------- */
await evaluate(`(() => {
  const it = [...document.querySelectorAll('.note-item')].find(e => e.textContent.includes('手写网页'))
  it?.click()
})()`)
await sleep(1200)
await scrollTo('.html-card', 0)
const nameBox = await boxOf('.html-card-title', 0)
await dblClickAt(nameBox.x, nameBox.y)
check('双击标题进入改名状态', (await countOf('.html-card-name')) === 1)
check(
  '改名框里预填了原名',
  (await evaluate(`document.querySelector('.html-card-name')?.value`)) === '手写网页',
  String(await evaluate(`document.querySelector('.html-card-name')?.value`)),
)
await send('Input.insertText', { text: '十月数据看板' })
await keyPress('Enter', 'Enter', 13)
check('回车后标题改掉了', (await textOf('.html-card-title')) === '十月数据看板', await textOf('.html-card-title'))
check('改名后退出编辑态', (await countOf('.html-card-name')) === 0)
await sleep(700) // 自动保存有 500ms 防抖，读早了会拿到旧内容
const renamedMd = await mdWith('开头一句话')
check('新名字写进了正文元信息', /"title":"十月数据看板"/.test(renamedMd), renamedMd.split('\n').find((l) => l.includes('"file"')))

// Esc 放弃
await scrollTo('.html-card', 0)
const nameBox2 = await boxOf('.html-card-title', 0)
await dblClickAt(nameBox2.x, nameBox2.y)
await send('Input.insertText', { text: '不要这个名字' })
await keyPress('Escape', 'Escape', 27)
check('Esc 放弃改名', (await textOf('.html-card-title')) === '十月数据看板', await textOf('.html-card-title'))
check('放弃后正文也没变', /"title":"十月数据看板"/.test(await mdWith('开头一句话')))

/* ---------- 15. 滚轮接力：网页滚到头，接着滚笔记 ---------- */
await evaluate(`window.__ed.chain().focus('end').insertContent(
  Array.from({ length: 40 }, () => ({ type: 'paragraph', content: [{ type: 'text', text: '这是一段用来把正文撑高的占位文字。' }] }))
).run()`)
await sleep(700)
const scroller = await evaluate(`(() => {
  window.__sc = (() => {
    let n = document.querySelector('.html-card').parentElement
    while (n) { const st = getComputedStyle(n); if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 1) return n; n = n.parentElement }
    return document.scrollingElement
  })()
  window.__sc.scrollTop = 0
  return { tag: window.__sc.className || window.__sc.tagName, h: window.__sc.clientHeight, can: window.__sc.scrollHeight > window.__sc.clientHeight }
})()`)
await sleep(400)
const frameBox = await boxOf('.html-card iframe', 0)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: frameBox.x, y: frameBox.y })
await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: frameBox.x, y: frameBox.y, deltaX: 0, deltaY: 240 })
await sleep(450)
const scrolled = await evaluate(`Math.round(window.__sc.scrollTop)`)
check('鼠标停在网页上也能往下滚整篇笔记', scrolled > 50, `${scroller.tag} → ${scrolled}px`)
// 反过来：网页自己还能滚的时候，滚轮得留在网页里，不能被抢走
await evaluate(`(() => {
  const d = document.querySelector('.html-card iframe').contentDocument
  const pad = d.createElement('div')
  pad.id = 'tall-pad'
  pad.style.height = '2400px'
  d.body.appendChild(pad)
  const root = d.scrollingElement || d.documentElement
  root.scrollTop = 0
  window.__sc.scrollTop = 0
})()`)
await sleep(400)
await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: frameBox.x, y: frameBox.y, deltaX: 0, deltaY: 200 })
await sleep(450)
const inside = await evaluate(`(() => {
  const d = document.querySelector('.html-card iframe').contentDocument
  const root = d.scrollingElement || d.documentElement
  return { inner: Math.round(root.scrollTop), outer: Math.round(window.__sc.scrollTop) }
})()`)
check('网页内部还能滚时，滚轮留在网页里', inside.inner > 0 && inside.outer === 0, JSON.stringify(inside))

/* ---------- 16. 卡片铺满纸张 + 内容缩放 ---------- */
await evaluate(`(() => {
  const it = [...document.querySelectorAll('.note-item')].find(e => e.textContent.includes('手写网页'))
  it?.click()
})()`)
await sleep(1200)
await scrollTo('.html-card', 0)
await sleep(400)

const wide = await evaluate(`(() => {
  const card = document.querySelector('.html-card')
  const body = document.querySelector('.rich-body')
  const paper = document.querySelector('.paper')
  return {
    card: Math.round(card.getBoundingClientRect().width),
    body: Math.round(body.getBoundingClientRect().width),
    paper: Math.round(paper.getBoundingClientRect().width),
  }
})()`)
check('卡片吃掉纸张的左右留白（比正文宽）', wide.card > wide.body + 20, JSON.stringify(wide))
check('但没有盖住纸张边框', wide.card <= wide.paper - 1, `${wide.card} vs ${wide.paper}`)

const base = await evaluate(`(() => {
  const card = document.querySelector('.html-card')
  const f = card.querySelector('iframe')
  return {
    frameW: Math.round(f.getBoundingClientRect().width),
    bodyW: Math.round(card.querySelector('.html-card-body').clientWidth),
    label: document.querySelector('.html-zoom-val').textContent.trim(),
    innerW: Math.round(f.contentDocument.documentElement.clientWidth),
  }
})()`)
check('默认按 100% 显示', base.label === '100%', base.label)

await clickSel('.html-zoom-btn', 1)
await sleep(700)
const zoomed = await evaluate(`(() => {
  const card = document.querySelector('.html-card')
  const f = card.querySelector('iframe')
  return {
    frameW: Math.round(f.getBoundingClientRect().width),
    label: document.querySelector('.html-zoom-val').textContent.trim(),
    innerW: Math.round(f.contentDocument.documentElement.clientWidth),
  }
})()`)
check('点「＋」放大到 125%', zoomed.label === '125%', zoomed.label)
check('iframe 宽度跟着放大到 1.25 倍', Math.abs(zoomed.frameW - base.bodyW * 1.25) <= 4, `${zoomed.frameW} vs ${Math.round(base.bodyW * 1.25)}`)
check('网页内容真的变宽了（不是空放大）', zoomed.innerW > base.innerW + 20, `${base.innerW} → ${zoomed.innerW}`)
await sleep(800)
check('缩放倍数写进了正文元信息', /"zoom":1\.25/.test(await mdWith('开头一句话')), (await mdWith('开头一句话')).split('\n').find((l) => l.includes('"file"')))

await clickSel('.html-zoom-val', 0)
await sleep(900)
const reset = await evaluate(`(() => {
  const f = document.querySelector('.html-card iframe')
  return { frameW: Math.round(f.getBoundingClientRect().width), label: document.querySelector('.html-zoom-val').textContent.trim() }
})()`)
check('点百分比回到 100%', reset.label === '100%', reset.label)
check('回到 100% 后宽度还原', Math.abs(reset.frameW - base.frameW) <= 2, `${reset.frameW} vs ${base.frameW}`)
check('100% 时正文里不写 zoom（老格式不变）', !/"zoom"/.test(await mdWith('开头一句话')))

/* ---------- 17. 内容比默认高的网页：自动撑高而不是憋着滚 ---------- */
await clickSel('.new-main')
await sleep(1300)
await setFile('.html-picker', ['/tmp/jjpages/高页面.html'])
await sleep(1800)
await toCard() // 融入模式会整篇铺开，这里验的是卡片模式的「撑高有上限」
await sleep(900)
const tall = await evaluate(`(() => {
  const f = document.querySelector('.html-card iframe')
  const d = f?.contentDocument
  const root = d ? (d.scrollingElement || d.documentElement) : null
  return {
    h: f ? Math.round(f.getBoundingClientRect().height) : -1,
    inner: root ? Math.round(root.scrollHeight) : -1,
  }
})()`)
check('比默认高的网页会把卡片撑高', tall.h >= 850, `${tall.h}px（内容 ${tall.inner}px）`)
check('撑高有上限，不会顶满整屏', tall.h <= 906, `${tall.h}px`)

/* ---------- 18. 收尾 ---------- */
const errs = await evaluate(`window.__errors ?? []`)
check('全程没有未捕获的错误', Array.isArray(errs) && errs.length === 0, JSON.stringify(errs).slice(0, 300))

const bad = results.filter((r) => !r.ok)
console.log(`\n合计 ${results.length} 项，通过 ${results.length - bad.length}，失败 ${bad.length}`)
if (bad.length) {
  console.log('失败项：')
  for (const b of bad) console.log(` - ${b.name} ${b.extra}`)
}
ws.close()
process.exit(bad.length ? 1 : 0)
