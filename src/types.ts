export interface Note {
  /**
   * 相对笔记根目录的路径，用 / 分隔：
   * 根目录下的笔记是 "周报.md"，笔记本里的则是 "工作/周报.md"
   */
  file: string
  /** 所属笔记本，空字符串表示未分类（文件直接放在根目录） */
  notebook: string
  title: string
  body: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  /** 用户自己起的标记（标签）。普通笔记默认没有 */
  tags: string[]
  /** 是不是记账笔记：打开时走记账界面，正文存一张 Markdown 表格 */
  ledger: boolean
}

/** 记账笔记固定带的标记，不写进 tags，避免用户误删后类型混乱 */
export const LEDGER_TAG = '记账'

/** 一篇笔记对外展示的全部标记：内置的记账标记 + 自定义标记 */
export function allTags(note: Note): string[] {
  return note.ledger ? [LEDGER_TAG, ...note.tags.filter((t) => t !== LEDGER_TAG)] : note.tags
}

export interface RawFile {
  file: string
  content: string
}

/** 从相对路径里取出笔记本名；根目录下的文件返回空串 */
export function notebookOf(file: string): string {
  const i = file.indexOf('/')
  return i < 0 ? '' : file.slice(0, i)
}

/** 去掉笔记本前缀，只留文件名 */
export function baseName(file: string): string {
  const i = file.indexOf('/')
  return i < 0 ? file : file.slice(i + 1)
}

/** 把笔记本名和文件名拼成相对路径 */
export function notePath(notebook: string, fileName: string): string {
  return notebook ? `${notebook}/${fileName}` : fileName
}

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function firstHeading(body: string): string {
  const m = /^\s*#{1,3}\s+(.+)$/m.exec(body)
  return m ? m[1].trim() : ''
}

function stripExt(name: string): string {
  return baseName(name).replace(/\.md$/i, '')
}

/** 逗号分隔的标记串 → 数组（也兼容中文逗号、空格） */
export function splitTags(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ]
}

export function parseNote(file: string, content: string): Note {
  const meta: Record<string, string> = {}
  let body = content.replace(/\r\n/g, '\n')

  const m = FM.exec(body)
  if (m) {
    body = body.slice(m[0].length)
    for (const line of m[1].split('\n')) {
      const idx = line.indexOf(':')
      if (idx > 0) {
        meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
      }
    }
  }

  const created = Date.parse(meta.created ?? '')
  const updated = Date.parse(meta.updated ?? '')
  const tags = splitTags(meta.tags ?? '').filter((t) => t !== LEDGER_TAG)

  return {
    file,
    notebook: notebookOf(file),
    title: meta.title || firstHeading(body) || stripExt(file) || '未命名',
    body: body.replace(/^\n+/, ''),
    createdAt: Number.isNaN(created) ? Date.now() : created,
    updatedAt: Number.isNaN(updated) ? Date.now() : updated,
    pinned: meta.pinned === 'true',
    tags,
    ledger: meta.ledger === 'true',
  }
}

export function serializeNote(note: Note): string {
  const lines = [
    '---',
    `title: ${note.title.replace(/\n/g, ' ')}`,
    `created: ${new Date(note.createdAt).toISOString()}`,
    `updated: ${new Date(note.updatedAt).toISOString()}`,
    `pinned: ${note.pinned}`,
  ]
  // 没标记、不是记账的普通笔记，不往 frontmatter 里塞空字段
  if (note.tags.length > 0) lines.push(`tags: ${note.tags.join(', ')}`)
  if (note.ledger) lines.push('ledger: true')
  lines.push('---', '')
  return lines.join('\n') + note.body.replace(/\n+$/, '') + '\n'
}

/** 新建笔记的默认标题：年月日时分秒，如 20261021105655 */
export function stampTitle(ts: number = Date.now()): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`
}

/** 标题转文件名：去掉非法字符，限制长度，保证以 .md 结尾 */
export function toFileName(title: string, fallback = '未命名'): string {
  const cleaned = title
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return `${cleaned || fallback}.md`
}

const IMG_MD = /!\[[^\]]*\]\([^)]*\)/g

export function snippet(body: string, len = 48): string {
  const text = body
    .replace(/^---[\s\S]*?---/, '')
    .replace(IMG_MD, '[图片]')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^- \[[ xX]\]\s*/gm, '')
    .replace(/[*_`>~]/g, '')
    .replace(/\n+/g, ' ')
    .trim()
  return text.length > len ? `${text.slice(0, len)}…` : text
}

export function wordCount(body: string): number {
  // 去掉图片（那串 base64 不算字数）和 Markdown 标记，接近「净字数」
  const text = body
    .replace(IMG_MD, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*]\s+(\[[ xX]\]\s*)?/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s/g, '')
  return text.length
}

export function formatDate(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const pad = (n: number) => String(n).padStart(2, '0')
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  ) {
    return '昨天'
  }
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** 待办进度：已完成 / 总数。笔记和清单是同一篇东西，正文里有多少 `- [ ]` 就统计多少 */
export function listProgress(body: string): { done: number; total: number } {
  const lines = body.split('\n')
  let done = 0
  let total = 0
  for (const line of lines) {
    const m = /^\s*- \[( |x|X)\]/.exec(line)
    if (m) {
      total += 1
      if (m[1].toLowerCase() === 'x') done += 1
    }
  }
  return { done, total }
}
