/**
 * Markdown 表格（GFM 管道表）在笔记里的呈现。
 *
 * 简记的正文本来没有表格，但拖进来的 .md（尤其是各种研报）几乎都有表。
 * 这里做一个「原子节点」：整张表是一个块，内部不做单元格级编辑，
 * 数据原样存进节点 attrs，回写成 Markdown 时原样还原（管道分隔）。
 * 真正的单元格编辑以后要加再换成 @tiptap/extension-table。
 */
import { Node } from '@tiptap/core'

export type MdTableAttrs = {
  /** 表头（已经去掉行内标记的纯文字） */
  header: string[]
  /** 数据行 */
  rows: string[][]
  /** 每列对齐：'' | 'left' | 'center' | 'right' */
  align: string[]
}

export function emptyTableAttrs(): MdTableAttrs {
  return { header: [], rows: [], align: [] }
}

/** attrs → 一张真的 <table>（renderHTML 和 md 卡片的静态渲染共用） */
export function buildTableDom(raw: Partial<MdTableAttrs>): HTMLElement {
  const header = Array.isArray(raw.header) ? raw.header : []
  const rows = Array.isArray(raw.rows) ? raw.rows : []
  const align = Array.isArray(raw.align) ? raw.align : []

  const table = document.createElement('table')
  const colCls = (idx: number) => (align[idx] ? ` ta-${align[idx]}` : '')

  if (header.length) {
    const thead = document.createElement('thead')
    const tr = document.createElement('tr')
    header.forEach((text, idx) => {
      const th = document.createElement('th')
      th.textContent = text
      th.className = colCls(idx).trim()
      tr.appendChild(th)
    })
    thead.appendChild(tr)
    table.appendChild(thead)
  }

  if (rows.length) {
    const tbody = document.createElement('tbody')
    rows.forEach((cells) => {
      const tr = document.createElement('tr')
      header.forEach((_, idx) => {
        const td = document.createElement('td')
        td.textContent = cells[idx] ?? ''
        td.className = colCls(idx).trim()
        tr.appendChild(td)
      })
      tbody.appendChild(tr)
    })
    table.appendChild(tbody)
  }
  return table
}

export const MdTable = Node.create({
  name: 'mdTable',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      header: { default: [] },
      rows: { default: [] },
      align: { default: [] },
    }
  },
  parseHTML() {
    // 正文里不会从 HTML 解析出这种节点（只在 md → doc 时产生）
    return []
  },
  renderHTML({ node }) {
    return { dom: buildTableDom(node.attrs as MdTableAttrs) }
  },
})
