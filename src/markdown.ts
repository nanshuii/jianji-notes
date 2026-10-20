function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 行内样式：粗体、斜体、删除线、行内代码、链接 */
export function renderInline(src: string): string {
  let t = esc(src)
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>')
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  t = t.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
  )
  return t
}

const BLOCK_START = /^(#{1,6}\s|>|```|\s*[-*]\s|\s*\d+[.)]\s)/

/** 极简 Markdown 渲染，覆盖笔记场景常用语法 */
export function mdToHtml(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  let i = 0

  const closeList = () => {
    if (list) {
      out.push(`</${list}>`)
      list = null
    }
  }

  while (i < lines.length) {
    const line = lines[i]

    if (/^```/.test(line.trim())) {
      closeList()
      const lang = line.trim().slice(3).trim()
      const buf: string[] = []
      i += 1
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i])
        i += 1
      }
      i += 1
      out.push(
        `<pre class="code"><code${lang ? ` data-lang="${esc(lang)}"` : ''}>${esc(
          buf.join('\n'),
        )}</code></pre>`,
      )
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      const level = heading[1].length
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      i += 1
      continue
    }

    if (/^\s*([-*_])\1\1\s*$/.test(line)) {
      closeList()
      out.push('<hr />')
      i += 1
      continue
    }

    if (/^>\s?/.test(line)) {
      closeList()
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''))
        i += 1
      }
      out.push(`<blockquote>${mdToHtml(buf.join('\n'))}</blockquote>`)
      continue
    }

    const todo = /^\s*[-*]\s+\[( |x|X)\]\s*(.*)$/.exec(line)
    if (todo) {
      if (list !== 'ul') {
        closeList()
        out.push('<ul class="md-todo">')
        list = 'ul'
      }
      const checked = todo[1].toLowerCase() === 'x'
      out.push(
        `<li class="${checked ? 'done' : ''}"><span class="box">${
          checked ? '✓' : ''
        }</span><span>${renderInline(todo[2])}</span></li>`,
      )
      i += 1
      continue
    }

    const ul = /^\s*[-*]\s+(.*)$/.exec(line)
    if (ul) {
      if (list !== 'ul') {
        closeList()
        out.push('<ul>')
        list = 'ul'
      }
      out.push(`<li>${renderInline(ul[1])}</li>`)
      i += 1
      continue
    }

    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ol) {
      if (list !== 'ol') {
        closeList()
        out.push('<ol>')
        list = 'ol'
      }
      out.push(`<li>${renderInline(ol[1])}</li>`)
      i += 1
      continue
    }

    if (line.trim() === '') {
      closeList()
      i += 1
      continue
    }

    closeList()
    const buf: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !BLOCK_START.test(lines[i])
    ) {
      buf.push(lines[i])
      i += 1
    }
    if (buf.length === 0) {
      buf.push(line)
      i += 1
    }
    out.push(`<p>${buf.map(renderInline).join('<br />')}</p>`)
  }

  closeList()
  return out.join('\n')
}
