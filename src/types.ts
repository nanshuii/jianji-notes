export type NoteType = 'note' | 'list'

export interface Note {
  /** 文件名，含 .md 后缀，例如 今天的清单.md */
  file: string
  title: string
  type: NoteType
  body: string
  createdAt: number
  updatedAt: number
  pinned: boolean
}

export interface RawFile {
  file: string
  content: string
}

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function firstHeading(body: string): string {
  const m = /^\s*#{1,3}\s+(.+)$/m.exec(body)
  return m ? m[1].trim() : ''
}

function stripExt(name: string): string {
  return name.replace(/\.md$/i, '')
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

  return {
    file,
    title: meta.title || firstHeading(body) || stripExt(file) || '未命名',
    type: meta.type === 'list' ? 'list' : 'note',
    body: body.replace(/^\n+/, ''),
    createdAt: Number.isNaN(created) ? Date.now() : created,
    updatedAt: Number.isNaN(updated) ? Date.now() : updated,
    pinned: meta.pinned === 'true',
  }
}

export function serializeNote(note: Note): string {
  const head = [
    '---',
    `title: ${note.title.replace(/\n/g, ' ')}`,
    `type: ${note.type}`,
    `created: ${new Date(note.createdAt).toISOString()}`,
    `updated: ${new Date(note.updatedAt).toISOString()}`,
    `pinned: ${note.pinned}`,
    '---',
    '',
  ].join('\n')
  return head + note.body.replace(/\n+$/, '') + '\n'
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

export function snippet(body: string, len = 48): string {
  const text = body
    .replace(/^---[\s\S]*?---/, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^- \[[ xX]\]\s*/gm, '')
    .replace(/[*_`>~]/g, '')
    .replace(/\n+/g, ' ')
    .trim()
  return text.length > len ? `${text.slice(0, len)}…` : text
}

export function wordCount(body: string): number {
  const text = body.replace(/\s/g, '')
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

/** 清单进度：已完成 / 总数 */
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
