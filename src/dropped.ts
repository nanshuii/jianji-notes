/**
 * 从系统里拖进窗口的文件：Tauri 的原生拖放只给一串绝对路径，不给内容。
 *
 * 这里只做纯逻辑：认扩展名、把网页/图片分开、把 Rust 读回来的 data URI
 * 还原成 File。还原之后一律交给 RichEditor.insertFiles，和「图片按钮 /
 * ⌘V 粘贴 / 网页里直接拖」走同一条插入路径，压缩、落点、错误提示都只有一份。
 */
import { isHtmlFile } from './embed'

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif|tiff?|ico)$/i
const HTML_EXT = /\.(html?|xhtml)$/i

/** Finder 拖进来的路径常常没有 MIME，只能按扩展名认 */
export function isImagePath(path: string | null | undefined): boolean {
  return typeof path === 'string' && IMAGE_EXT.test(path)
}

export function isHtmlPath(path: string | null | undefined): boolean {
  return typeof path === 'string' && HTML_EXT.test(path)
}

/** 网页里拖进来的 File：优先看 MIME，MIME 为空时再按扩展名兜底 */
export function isImageFile(
  f: { name?: string; type?: string } | null | undefined,
): boolean {
  if (!f) return false
  if (typeof f.type === 'string' && f.type.startsWith('image/')) return true
  return typeof f.name === 'string' && IMAGE_EXT.test(f.name)
}

export function isDroppableFile(
  f: { name?: string; type?: string } | null | undefined,
): boolean {
  return isImageFile(f) || isHtmlFile(f)
}

/** 扩展名 → MIME，和 Rust 侧 image_mime() 保持一致 */
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heic',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ico: 'image/x-icon',
}

export function imageMimeOf(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name || '')?.[1]?.toLowerCase() ?? ''
  return MIME[ext] ?? 'application/octet-stream'
}

export type DroppedPaths = {
  /** 网页路径 */
  pages: string[]
  /** 图片路径 */
  images: string[]
  /** 不认识的文件，用来给用户一个提示 */
  others: string[]
}

/** 按路径串分类；顺序由调用方保留（拖进来是什么顺序就按什么顺序插） */
export function classifyPaths(
  paths: readonly (string | null | undefined)[] | null | undefined,
): DroppedPaths {
  const out: DroppedPaths = { pages: [], images: [], others: [] }
  for (const p of paths ?? []) {
    if (typeof p !== 'string' || !p) continue
    if (isImagePath(p)) out.images.push(p)
    else if (isHtmlPath(p)) out.pages.push(p)
    else out.others.push(p)
  }
  return out
}

/**
 * `data:image/png;base64,...` → File。
 * 用 atob 逐字节解，不依赖 fetch(data:)（WKWebView 对 data URL 的 fetch 限制较多）。
 */
export function dataUrlToFile(dataUrl: string, name: string, type?: string): File {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(dataUrl || '')
  if (!m) throw new Error('读到的图片格式不对')
  const mime = m[1] || type || imageMimeOf(name)
  let bytes: Uint8Array
  if (m[2]) {
    const bin = atob(m[3].replace(/\s/g, ''))
    bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(m[3]))
  }
  return new File([bytes.buffer as ArrayBuffer], name, { type: mime })
}

/** 桌面端按路径读文件的能力（浏览器预览模式没有，会抛错） */
export type DroppedReader = {
  readDroppedFile(path: string): Promise<string>
  readDroppedImage(path: string): Promise<string>
}

/**
 * 原生拖放给的路径串 → 一批 File，顺序保持不变。
 * 网页读成文本、图片读成 data URI 再还原；读不动的单个文件只报错、不影响其它文件。
 * 抽成纯函数是为了能脱离 Tauri 窗口直接测（真机里的拖放事件本身没法在无头浏览器里造）。
 */
export async function pathsToFiles(
  paths: readonly (string | null | undefined)[] | null | undefined,
  reader: DroppedReader,
  onError?: (name: string, err: unknown) => void,
): Promise<File[]> {
  const out: File[] = []
  for (const path of paths ?? []) {
    if (typeof path !== 'string' || !path) continue
    const name = path.split(/[\\/]/).pop() || '文件'
    try {
      if (isHtmlPath(path)) {
        const html = await reader.readDroppedFile(path)
        out.push(new File([html], name, { type: 'text/html' }))
      } else if (isImagePath(path)) {
        const uri = await reader.readDroppedImage(path)
        out.push(dataUrlToFile(uri, name))
      }
    } catch (e) {
      onError?.(name, e)
    }
  }
  return out
}
