/** 诊断：编辑器里那些没有 src 的 img 是从哪来的（连接 9223 上当前页面） */
const list = await (await fetch('http://127.0.0.1:9223/json/list')).json()
const t = list.find((x) => x.type === 'page')
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
})
const send = (method, params = {}) => new Promise((resolve) => {
  const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params }))
})
const r = await send('Runtime.evaluate', {
  expression: `(() => ({
    bodies: document.querySelectorAll('.rich-body').length,
    imgs: [...document.querySelectorAll('.rich-body img')].map(i => ({
      src: (i.getAttribute('src') || '').slice(0, 30),
      outer: i.outerHTML.slice(0, 160),
      parent: i.parentElement?.className,
      grand: i.parentElement?.parentElement?.className,
    })),
    json: (window.__ed?.getJSON()?.content || []).map(n => n.type + ':' + (n.content || []).map(c => c.type).join(',')).join(' | '),
  }))()`,
  returnByValue: true,
})
console.log(JSON.stringify(r.result.value, null, 2))
ws.close()
