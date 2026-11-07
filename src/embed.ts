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

/**
 * 融入正文时网页摊开的真实高度，可以远超卡片上限（长表格能到两万像素）。
 * 上限只是防着异常页面（带 100vh 元素的那种）把笔记撑到无限高。
 */
export const INLINE_MAX_HEIGHT = 24000
/** 融入模式量到的高度下限：比这还小的量多半是还没排版完 */
export const MIN_FIT_HEIGHT = 120

/** 网页内容的缩放倍数：流程图这类页面按宽度缩，正文窄的时候字会小到看不清 */
export const DEFAULT_ZOOM = 1
export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 2.5
export const ZOOM_STEP = 0.25

/**
 * 网页在笔记里的两种呈现：
 * - card   ：老样子，一张有边框/标题栏/固定高度的卡片（旧笔记缺省就是它）
 * - inline ：融入正文 —— 没有卡片外框，高度跟着网页内容长，整篇随笔记一起滚，
 *            网页里的脚本、动画、图表、锚点全部照常跑。新插入默认用这个。
 */
export type EmbedMode = 'card' | 'inline'
export const DEFAULT_MODE: EmbedMode = 'card'
export const INSERT_MODE: EmbedMode = 'inline'

/** 只认 inline，其它一律当 card（旧笔记里没有这个字段） */
export function embedMode(v: unknown): EmbedMode {
  return v === 'inline' ? 'inline' : 'card'
}

export type EmbedMeta = {
  /** .assets 里的文件名 */
  file: string
  /** 卡片上显示的标题（默认取原文件名） */
  title: string
  /** 卡片高度（像素），可拖动改 */
  height: number
  /** 内容缩放倍数，1 = 按卡片宽度铺满 */
  zoom?: number
  /** card（缺省）= 卡片；inline = 融入正文、自动贴合内容高度 */
  mode?: EmbedMode
  /**
   * 融入正文时量出来的网页高度，记在笔记里让下次打开「一上来就是最终高度」，
   * 不用先从占位高度撑开一次（那一下会把正文文字推来推去）。
   */
  fit?: number
}

/** 量出来的高度夹到合法范围，0 / 非法都当「还没量过」 */
export function clampFit(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n < MIN_FIT_HEIGHT) return 0
  return Math.min(INLINE_MAX_HEIGHT, Math.round(n))
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
    return { file, title, height, zoom, mode: embedMode(o.mode), fit: clampFit(o.fit) }
  } catch {
    return null
  }
}

/** 元信息 → 一行 JSON（写进 Markdown 的围栏里）；默认值不写，保持老格式干净 */
export function embedMetaJson(m: EmbedMeta): string {
  const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(m.height || DEFAULT_HEIGHT)))
  const zoom = clampZoom(m.zoom)
  const mode = embedMode(m.mode)
  const out: Record<string, unknown> = { file: m.file, title: m.title ?? '', height }
  if (zoom !== DEFAULT_ZOOM) out.zoom = zoom
  if (mode !== DEFAULT_MODE) out.mode = mode
  // 融入模式记下量到的高度：下次打开直接按这个高度摆好，正文不会再被推一下
  const fit = mode === 'inline' ? clampFit(m.fit) : 0
  if (fit) out.fit = fit
  return JSON.stringify(out)
}

/** 12.3 KB / 1.4 MB */
export function humanSize(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
