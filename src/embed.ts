/**
 * 「网页卡片」的纯逻辑：把一份 .html 放进笔记里显示。
 *
 * 网页本身存在笔记目录下的 .assets/ 里，正文只留一行元信息：
 *
 *   ```jianji-html
 *   {"file":"html-20261103-141233-4f2a.html","title":"十月复盘","height":520}
 *   ```
 *
 * 这样 .md 不会被一大段 HTML 撑爆，网页也还能单独用浏览器打开。
 */

export const EMBED_LANG = 'jianji-html'
export const DEFAULT_HEIGHT = 520
export const MIN_HEIGHT = 160
export const MAX_HEIGHT = 2000

/** 网页内容的缩放倍数：流程图这类页面按宽度缩，正文窄的时候字会小到看不清 */
export const DEFAULT_ZOOM = 1
export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 2.5
export const ZOOM_STEP = 0.25

export type EmbedMeta = {
  /** .assets 里的文件名 */
  file: string
  /** 卡片上显示的标题（默认取原文件名） */
  title: string
  /** 卡片高度（像素），可拖动改 */
  height: number
  /** 内容缩放倍数，1 = 按卡片宽度铺满 */
  zoom?: number
}

/** 把任意输入夹到合法的缩放范围里，缺省/非法都当 1 */
export function clampZoom(z: unknown): number {
  const n = Number(z)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ZOOM
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(n * 100) / 100))
}

const HTML_EXT = /\.(html?|xhtml)$/i

/** 是不是一份网页文件（按扩展名或 MIME 判断，Finder 拖进来的常常没有 MIME） */
export function isHtmlFile(f: { name?: string; type?: string } | null | undefined): boolean {
  if (!f) return false
  if (typeof f.name === 'string' && HTML_EXT.test(f.name)) return true
  return f.type === 'text/html'
}

/** 文件名 → 卡片标题：去掉扩展名，空的就退回「网页」 */
export function titleOf(fileName: string): string {
  const t = (fileName || '').replace(HTML_EXT, '').trim()
  return t || '网页'
}

/** 生成一个不会撞车的附件名：html-20261103-141233-4f2a.html */
export function makeAssetName(now: number = Date.now(), rand: number = Math.random()): string {
  const d = new Date(now)
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`
  const tail = Math.floor(rand * 0xffff)
    .toString(16)
    .padStart(4, '0')
  return `html-${stamp}-${tail}.html`
}

/** 解析卡片元信息；解析不出来就返回 null（当作普通代码块处理） */
export function parseEmbedMeta(raw: string): EmbedMeta | null {
  const text = raw.trim()
  if (!text) return null
  try {
    const o = JSON.parse(text) as Record<string, unknown>
    const file = typeof o.file === 'string' ? o.file.trim() : ''
    if (!file) return null
    const title = typeof o.title === 'string' ? o.title : ''
    const h = Number(o.height)
    const height = Number.isFinite(h)
      ? Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(h)))
      : DEFAULT_HEIGHT
    const zoom = clampZoom(o.zoom)
    return { file, title, height, zoom }
  } catch {
    return null
  }
}

/** 元信息 → 一行 JSON（写进 Markdown 的围栏里）；zoom=1 就不写，保持老格式干净 */
export function embedMetaJson(m: EmbedMeta): string {
  const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(m.height || DEFAULT_HEIGHT)))
  const zoom = clampZoom(m.zoom)
  return JSON.stringify(
    zoom === DEFAULT_ZOOM
      ? { file: m.file, title: m.title ?? '', height }
      : { file: m.file, title: m.title ?? '', height, zoom },
  )
}

/** 12.3 KB / 1.4 MB */
export function humanSize(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
