/**
 * Markdown ⇄ ProseMirror 文档（Tiptap）的互转。
 *
 * 磁盘上仍然是纯 .md 文件（方便备份、同步、进 Git），
 * 但界面上不再显示 Markdown 源码：打开是排好版的正文，输入什么就长成什么样。
 */

export type Mark = { type: string; attrs?: Record<string, unknown> }
export type PMNode = {
  type: string
  attrs?: Record<string, unknown>
  content?: PMNode[]
  text?: string
  marks?: Mark[]
}

const IMG = /^!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?\s*\)/
const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)/
const CODE = /^`([^`]+)`/
const BOLD = /^(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/
const ITALIC = /^(\*|_)(?=\S)([\s\S]+?)(?<=\S)\1/
const STRIKE = /^~~(?=\S)([\s\S]+?)(?<=\S)~~/

function withMark(marks: Mark[], mark: Mark): Mark[] {
  if (marks.some((m) => m.type === mark.type)) return marks
  return [...marks, mark]
}

/** 行内语法 → 文本节点数组 */
export function inlineNodes(src: string, marks: Mark[] = []): PMNode[] {
  const out: PMNode[] = []
  let buf = ''
  let i = 0

  const flush = () => {
    if (!buf) return
    const node: PMNode = { type: 'text', text: buf }
    if (marks.length) node.marks = marks
    out.push(node)
    buf = ''
  }

  while (i < src.length) {
    const rest = src.slice(i)

    // 反斜杠转义
    if (src[i] === '\\' && i + 1 < src.length) {
      buf += src[i + 1]
      i += 2
      continue
    }

    let m = CODE.exec(rest)
    if (m) {
      flush()
      out.push({ type: 'text', text: m[1], marks: withMark(marks, { type: 'code' }) })
      i += m[0].length
      continue
    }

    m = IMG.exec(rest)
    if (m) {
      flush()
      out.push({ type: 'image', attrs: { src: m[2], alt: m[1] } })
      i += m[0].length
      continue
    }

    m = LINK.exec(rest)
    if (m) {
      flush()
      out.push(
        ...inlineNodes(m[1], withMark(marks, { type: 'link', attrs: { href: m[2] } })),
      )
      i += m[0].length
      continue
    }

    m = BOLD.exec(rest)
    if (m) {
      flush()
      out.push(...inlineNodes(m[2], withMark(marks, { type: 'bold' })))
      i += m[0].length
      continue
    }

    m = STRIKE.exec(rest)
    if (m) {
      flush()
      out.push(...inlineNodes(m[1], withMark(marks, { type: 'strike' })))
      i += m[0].length
      continue
    }

    m = ITALIC.exec(rest)
    if (m) {
      flush()
      out.push(...inlineNodes(m[2], withMark(marks, { type: 'italic' })))
      i += m[0].length
      continue
    }

    buf += src[i]
    i += 1
  }

  flush()
  return out
}

function para(text: string): PMNode {
  const content = inlineNodes(text)
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' }
}

const BLOCK_START =
  /^(#{1,6}\s|>|```|\s*[-*]\s|\s*\d+[.)]\s|\s*([-*_])\2{2,}\s*$)/

/** Markdown → Tiptap 文档 */
export function mdToDoc(src: string): PMNode {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const nodes: PMNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (/^\s*```/.test(line)) {
      const lang = line.trim().slice(3).trim()
      const buf: string[] = []
      i += 1
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        buf.push(lines[i])
        i += 1
      }
      i += 1
      nodes.push({
        type: 'codeBlock',
        attrs: { language: lang || null },
        content: buf.length ? [{ type: 'text', text: buf.join('\n') }] : [],
      })
      continue
    }

    if (!line.trim()) {
      i += 1
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      nodes.push({
        type: 'heading',
        attrs: { level: heading[1].length },
        content: inlineNodes(heading[2]),
      })
      i += 1
      continue
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      nodes.push({ type: 'horizontalRule' })
      i += 1
      continue
    }

    if (/^>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''))
        i += 1
      }
      const inner = mdToDoc(buf.join('\n'))
      nodes.push({ type: 'blockquote', content: inner.content ?? [] })
      continue
    }

    // 待办清单
    if (/^\s*[-*]\s+\[[ xX]\]\s?/.test(line)) {
      const items: PMNode[] = []
      while (i < lines.length) {
        const m = /^\s*[-*]\s+\[([ xX])\]\s?(.*)$/.exec(lines[i])
        if (!m) break
        items.push({
          type: 'taskItem',
          attrs: { checked: m[1].toLowerCase() === 'x' },
          content: [para(m[2])],
        })
        i += 1
      }
      nodes.push({ type: 'taskList', content: items })
      continue
    }

    // 圆点列表
    if (/^\s*[-*]\s+/.test(line)) {
      const items: PMNode[] = []
      while (i < lines.length) {
        if (/^\s*[-*]\s+\[[ xX]\]/.test(lines[i])) break
        const m = /^\s*[-*]\s+(.*)$/.exec(lines[i])
        if (!m) break
        items.push({ type: 'listItem', content: [para(m[1])] })
        i += 1
      }
      nodes.push({ type: 'bulletList', content: items })
      continue
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: PMNode[] = []
      let start = 1
      let first = true
      while (i < lines.length) {
        const m = /^\s*(\d+)[.)]\s+(.*)$/.exec(lines[i])
        if (!m) break
        if (first) {
          start = Number(m[1]) || 1
          first = false
        }
        items.push({ type: 'listItem', content: [para(m[2])] })
        i += 1
      }
      nodes.push({ type: 'orderedList', attrs: { start }, content: items })
      continue
    }

    // 独占一行的图片
    const imgOnly = /^\s*!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?\s*\)\s*$/.exec(line)
    if (imgOnly) {
      nodes.push({ type: 'image', attrs: { src: imgOnly[2], alt: imgOnly[1] } })
      i += 1
      continue
    }

    // 普通段落：连续的非空行合成一段，行间用硬换行
    const buf: string[] = [line]
    i += 1
    while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i])) {
      const onlyImg = /^\s*!\[([^\]]*)\]\(/.test(lines[i])
      if (onlyImg) break
      buf.push(lines[i])
      i += 1
    }
    const content: PMNode[] = []
    buf.forEach((text, idx) => {
      if (idx > 0) content.push({ type: 'hardBreak' })
      content.push(...inlineNodes(text))
    })
    nodes.push(content.length ? { type: 'paragraph', content } : { type: 'paragraph' })
  }

  if (nodes.length === 0) nodes.push({ type: 'paragraph' })
  return { type: 'doc', content: nodes }
}

/* ---------------- 回写 Markdown ---------------- */

function inlineToMd(nodes: PMNode[] = []): string {
  return nodes
    .map((n) => {
      if (n.type === 'image') return `![](${String(n.attrs?.src ?? '')})`
      if (n.type === 'hardBreak') return '\n'
      let t = n.text ?? ''
      if (!t) return ''
      const marks = n.marks ?? []
      const has = (k: string) => marks.some((m) => m.type === k)
      if (has('code')) t = `\`${t}\``
      if (has('bold')) t = `**${t}**`
      if (has('italic')) t = `*${t}*`
      if (has('strike')) t = `~~${t}~~`
      const link = marks.find((m) => m.type === 'link')
      const href = link?.attrs?.href
      if (typeof href === 'string' && href) t = `[${t}](${href})`
      return t
    })
    .join('')
}

function childText(node: PMNode): string {
  return (node.content ?? []).map((c) => inlineToMd([c])).join('')
}

function blockToMd(node: PMNode, depth = 0): string {
  const pad = '  '.repeat(depth)
  switch (node.type) {
    case 'paragraph': {
      const kids = node.content ?? []
      if (kids.length === 1 && kids[0].type === 'image') {
        return `![](${String(kids[0].attrs?.src ?? '')})`
      }
      return inlineToMd(kids)
    }
    case 'heading': {
      const level = Number(node.attrs?.level ?? 1)
      return `${'#'.repeat(Math.min(6, Math.max(1, level)))} ${inlineToMd(node.content)}`
    }
    case 'codeBlock': {
      const lang = typeof node.attrs?.language === 'string' ? node.attrs.language : ''
      return `\`\`\`${lang}\n${childText(node)}\n\`\`\``
    }
    case 'blockquote':
      return (node.content ?? [])
        .map((c) => blockToMd(c, 0))
        .join('\n\n')
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n')
    case 'horizontalRule':
      return '---'
    case 'bulletList':
      return (node.content ?? [])
        .map((li) => `${pad}- ${(li.content ?? []).map((c) => blockToMd(c, depth + 1)).join('\n')}`)
        .join('\n')
    case 'orderedList':
      return (node.content ?? [])
        .map((li, idx) => {
          const n = Number(node.attrs?.start ?? 1) + idx
          return `${pad}${n}. ${(li.content ?? [])
            .map((c) => blockToMd(c, depth + 1))
            .join('\n')}`
        })
        .join('\n')
    case 'taskList':
      return (node.content ?? [])
        .map((li) => {
          const mark = li.attrs?.checked ? 'x' : ' '
          const body = (li.content ?? [])
            .map((c) => blockToMd(c, depth + 1))
            .join(' ')
            .trim()
          return `${pad}- [${mark}] ${body}`
        })
        .join('\n')
    case 'image':
      return `![](${String(node.attrs?.src ?? '')})`
    default:
      return inlineToMd(node.content)
  }
}

/** Tiptap 文档 → Markdown */
export function docToMd(doc: PMNode): string {
  const body = (doc.content ?? [])
    .map((n) => blockToMd(n))
    .filter((s) => s.trim() !== '')
    .join('\n\n')
  return body ? `${body}\n` : ''
}
