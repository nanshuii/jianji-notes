/** 效果图：把两张图片从「外面」直接拖进笔记正文后截一张图。
 *  运行：APP_URL=http://127.0.0.1:4173/ node .tmp/image-shot.mjs
 */
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const APP = process.env.APP_URL || 'http://127.0.0.1:5180/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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
function makePng(w, h, [r, g, b]) {
  const stride = w * 4 + 1
  const raw = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 4
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}
const b64 = (w, h, rgb) => `data:image/png;base64,${makePng(w, h, rgb).toString('base64')}`
const IMG1 = b64(320, 180, [198, 72, 48])
const IMG2 = b64(260, 180, [72, 108, 168])

const list = await (await fetch('http://127.0.0.1:9223/json/list')).json()
const t = list.find((x) => x.type === 'page')
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((res) => ws.addEventListener('open', res))
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result.value
}
const go = async (url) => { await send('Page.navigate', { url }); await sleep(1400) }
const clickSel = async (sel) => {
  const r = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if(!e) return null;
    const b=e.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2} })()`)
  if (!r) return
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 })
}
const fileOf = (data, name) => `(() => { const bin=atob(${JSON.stringify(data.split(',')[1])});
  const a=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);
  return new File([a], ${JSON.stringify(name)}, {type:'image/png'}) })()`

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
await go(APP)
await evaluate(`localStorage.clear()`)
await go(`${APP}?v=${Date.now()}`)
await clickSel('.new-main')
await sleep(1100)
await clickSel('.rich-body')
await send('Input.insertText', { text: '图片直接拖进来' })
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await send('Input.insertText', { text: '松手的位置就是图片落下的位置，前后照常写字。' })
await sleep(600)
await evaluate(`(() => {
  const dt = new DataTransfer()
  dt.items.add(${fileOf(IMG1, '光伏产业链.png')})
  dt.items.add(${fileOf(IMG2, '持仓记录.png')})
  const el = document.querySelector('.rich-body')
  const b = el.getBoundingClientRect()
  const opt = { bubbles: true, cancelable: true, clientX: b.left + 80, clientY: b.bottom - 8, dataTransfer: dt }
  el.dispatchEvent(new DragEvent('dragover', opt))
  el.dispatchEvent(new DragEvent('drop', opt))
})()`)
await sleep(1800)
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
writeFileSync('.tmp/image-preview.png', Buffer.from(shot.data, 'base64'))
console.log('截图已保存 .tmp/image-preview.png；图片数 =', await evaluate(`document.querySelectorAll('.rich-body .img-wrap img').length`))
ws.close()
