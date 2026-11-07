// 在 WebKit 里量抖动：卡片模式滚内部 / 融入模式滚笔记，逐次采样位置
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const post = (o) => window.webkit.messageHandlers.log.postMessage(JSON.stringify(o))

  const open = () => {
    const it = [...document.querySelectorAll('.note-item, .note-title')].find((e) => e.textContent.includes('光伏板块'))
    ;(it?.closest('.note-item') || it)?.click()
  }
  open()
  await sleep(2500)
  const report = { mode: document.querySelector('.html-card')?.className ?? 'none' }

  // 1) 静止 2 秒：位置有没有自己动
  const idle = []
  for (let i = 0; i < 20; i++) {
    const f = document.querySelector('.html-card iframe')
    if (!f) break
    const r = f.getBoundingClientRect()
    const d = f.contentDocument
    const tb = d?.querySelector?.('.toolbar')
    idle.push({
      h: Math.round(r.height),
      top: Math.round(r.top * 10) / 10,
      tb: tb ? Math.round(tb.getBoundingClientRect().top * 10) / 10 : null,
    })
    await sleep(100)
  }
  report.idle = idle

  // 2) 卡片模式：滚 iframe 内部
  if (!document.querySelector('.html-card.inline')) {
    const f = document.querySelector('.html-card iframe')
    const d = f.contentDocument
    const root = d.scrollingElement || d.documentElement
    const tb = d.querySelector('.toolbar')
    const rows = []
    for (let i = 0; i < 80; i++) {
      root.scrollTop += 10
      const r = tb.getBoundingClientRect()
      rows.push({ s: Math.round(root.scrollTop), top: Math.round(r.top * 10) / 10 })
      await sleep(16)
    }
    root.scrollTop = 0
    report.cardScroll = rows
  }

  // 3) 切融入模式再滚笔记
  const btn = [...document.querySelectorAll('.html-card button')].find((x) => x.textContent.includes('融入'))
  if (btn) btn.click()
  await sleep(2800)
  report.inlineMode = document.querySelector('.html-card')?.className

  const card = document.querySelector('.html-card')
  const f = card?.querySelector('iframe')
  if (f) {
    let n = card.parentElement, sc = null
    while (n) { const st = getComputedStyle(n); if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 1) { sc = n; break } n = n.parentElement }
    if (!sc) sc = document.scrollingElement
    sc.scrollTop = 0
    const rows = []
    for (let i = 0; i < 70; i++) {
      const t0 = performance.now()
      sc.scrollTop += 40
      await new Promise((r) => requestAnimationFrame(() => r()))
      const r = f.getBoundingClientRect()
      rows.push({ top: Math.round(r.top), ms: Math.round((performance.now() - t0) * 10) / 10 })
    }
    report.outerScroll = rows
    report.frameH = Math.round(f.getBoundingClientRect().height)
  }
  report.done = true
  post(report)
})().catch((e) => {
  window.webkit.messageHandlers.log.postMessage(JSON.stringify({ error: String(e && e.message || e) }))
})
