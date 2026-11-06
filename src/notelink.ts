/**
 * 笔记内链接：点在正文里的链接，跳到另一篇笔记的某一段。
 *
 * 链接在 .md 里就是一条普通 Markdown 链接 [文字](jianji:note?file=...&text=...)，
 * 用别的编辑器打开也只是个普通链接，不会把文件内容搞坏。
 * 不存行号（目标笔记上面加一段，行号就全串了），存那一行的文字，打开时按内容找。
 */

export const NOTE_LINK_PREFIX = 'jianji:note?'

/** 一段文字最多记这么长，足够唯一定位，又不至于把链接撑得没法看 */
const MAX_TEXT = 120

export interface NoteLink {
  file: string
  text: string
}

/** encodeURIComponent 不编码括号，而 Markdown 的 ](...) 遇到 ) 会提前断开，补一层 */
function enc(s: string): string {
  return encodeURIComponent(s).replace(/\(/g, '%28').replace(/\)/g, '%29')
}

export function buildNoteLink(file: string, text: string): string {
  const clean = text.trim().slice(0, MAX_TEXT)
  return `${NOTE_LINK_PREFIX}file=${enc(file)}&text=${enc(clean)}`
}

export function parseNoteLink(href: string): NoteLink | null {
  if (typeof href !== 'string' || !href.startsWith(NOTE_LINK_PREFIX)) return null
  try {
    const p = new URLSearchParams(href.slice(NOTE_LINK_PREFIX.length))
    const file = p.get('file')
    if (!file) return null
    return { file, text: p.get('text') ?? '' }
  } catch {
    return null
  }
}

export interface NoteLine {
  /** 去掉 Markdown 标记后的纯文本，既当链接指纹，也用于跳转时匹配 DOM */
  text: string
  /** 选择面板里显示的短标签 */
  label: string
  kind: 'heading' | 'list' | 'para'
}

/** 把一行 Markdown 粗略还原成屏幕上会显示的纯文字 */
function plain(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')      // 图片 → alt
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')        // 链接 → 文字
    .replace(/`/g, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/(^|\s)[*_](?=\S)/g, '$1')
    .replace(/\s+$/, '')
    .trim()
}

/**
 * 列出一篇笔记里「可以链过去的行」。
 * 跳过空行、代码围栏（网页卡片的 ```jianji-html 之类）和围栏里的内容。
 */
export function noteLines(md: string): NoteLine[] {
  const out: NoteLine[] = []
  let inFence = false
  for (const raw of (md || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('```')) { inFence = !inFence; continue }
    if (inFence || !line) continue

    let kind: NoteLine['kind'] = 'para'
    let body = line
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) { kind = 'heading'; body = h[2] }
    else if (/^>\s?/.test(line)) { body = line.replace(/^>\s?/, '') }
    else if (/^([-*+]|\d+\.)\s+/.test(line)) {
      kind = 'list'
      body = line.replace(/^([-*+]|\d+\.)\s+/, '').replace(/^\[[ xX]\]\s*/, '')
    }
    const text = plain(body)
    if (!text || /^[\s\-=|:]+$/.test(text)) continue
    if (out.some((o) => o.text === text)) continue
    out.push({
      text: text.slice(0, MAX_TEXT),
      label: text.length > 48 ? `${text.slice(0, 48)}…` : text,
      kind,
    })
  }
  return out
}

/** 判断一个 href 是不是该交给系统浏览器打开的普通网址 */
export function isExternalUrl(href: string): boolean {
  return /^https?:\/\//i.test(href)
}
