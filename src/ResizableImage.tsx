/**
 * 可拖动、可缩放、可环绕的图片节点。
 *
 * - 拖动：按住图片拖到别的位置（ProseMirror 原生节点拖拽）
 * - 缩放：选中图片后拖右下角圆点，宽度按像素记进节点属性
 * - 环绕：选中后点「左 / 右 / 整行」，文字自动绕排成多行
 *   左 = 图片靠左、文字在右边排；右 = 图片靠右、文字在左边排
 * - 宽度和对齐通过 Markdown 图片语法的 title 存盘：![说明](地址 "480 left")
 */
import { useRef } from 'react'
import Image from '@tiptap/extension-image'
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'

const MIN_WIDTH = 80

type Align = 'left' | 'right' | null

/** title 字段 ⇄ 宽度 + 对齐，例如 "480 left" */
function parseTitle(title: unknown): { width: number | null; align: Align } {
  const s = typeof title === 'string' ? title.trim() : ''
  let width: number | null = null
  let align: Align = null
  for (const token of s.split(/\s+/)) {
    const n = Number(token)
    if (Number.isFinite(n) && n > 0 && width === null) width = n
    if (token === 'left' || token === 'right') align = token
  }
  return { width, align }
}

function toTitle(width: number | null, align: Align): string {
  return [width ?? '', align ?? ''].join(' ').trim()
}

function ImageView({ node, updateAttributes, selected, editor, getPos }: NodeViewProps) {
  const imgRef = useRef<HTMLImageElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  const parsed = parseTitle(node.attrs.title)
  const width = typeof node.attrs.width === 'number' ? (node.attrs.width as number) : parsed.width
  const align: Align =
    (node.attrs.align === 'left' || node.attrs.align === 'right'
      ? (node.attrs.align as Align)
      : null) ?? parsed.align

  /** 把光标放到图片后面那一段，环排完可以直接打字 */
  const focusAfterImage = () => {
    const pos = getPos()
    window.setTimeout(() => {
      try {
        const end = pos + node.nodeSize
        const $pos = editor.state.doc.resolve(Math.min(end + 1, editor.state.doc.content.size))
        editor.chain().focus($pos.pos).run()
      } catch {
        editor.chain().focus('end').run()
      }
    }, 30)
  }

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const img = imgRef.current
    const body = wrapRef.current?.closest('.rich-body')
    if (!img || !body) return

    const startX = e.clientX
    const startW = img.getBoundingClientRect().width
    const maxW = body.getBoundingClientRect().width
    document.body.style.userSelect = 'none'

    const move = (ev: MouseEvent) => {
      const w = Math.round(Math.max(MIN_WIDTH, Math.min(startW + ev.clientX - startX, maxW)))
      img.style.width = `${w}px`
    }
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.userSelect = ''
      const w = Math.round(Math.max(MIN_WIDTH, Math.min(startW + ev.clientX - startX, maxW)))
      const next = w >= maxW - 6 ? null : w
      updateAttributes({ width: next, title: toTitle(next, align) })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const setAlign = (al: Align) => {
    // 选左右环绕但还没设过宽度时，给一个默认的半宽
    let w = width
    if (al && !w) {
      const body = wrapRef.current?.closest('.rich-body')
      w = body ? Math.round(body.getBoundingClientRect().width * 0.5) : 360
    }
    updateAttributes({ align: al, width: w, title: toTitle(w, al) })
    if (al) focusAfterImage()
  }

  return (
    <NodeViewWrapper
      ref={wrapRef}
      className={`img-wrap${selected ? ' selected' : ''}${align ? ` img-float-${align}` : ''}`}
      data-drag-handle
      title="按住拖动可挪位置"
    >
      <img
        ref={imgRef}
        src={String(node.attrs.src ?? '')}
        alt={String(node.attrs.alt ?? '')}
        draggable={false}
        style={width ? { width: `${width}px` } : undefined}
      />
      {selected && (
        <span className="img-tools" contentEditable={false}>
          <button
            type="button"
            className={align === 'left' ? 'on' : ''}
            title="图片靠左，文字在右边绕排"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setAlign('left')}
          >
            左
          </button>
          <button
            type="button"
            className={align === 'right' ? 'on' : ''}
            title="图片靠右，文字在左边绕排"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setAlign('right')}
          >
            右
          </button>
          <button
            type="button"
            className={align === null ? 'on' : ''}
            title="独占一行，不环绕"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setAlign(null)}
          >
            整行
          </button>
        </span>
      )}
      <span className="img-resize" title="拖动调整大小" onMouseDown={startResize} />
    </NodeViewWrapper>
  )
}

export const ResizableImage = Image.extend({
  draggable: true,
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => {
          const raw = el.getAttribute('data-width') ?? el.getAttribute('width')
          const n = raw ? Number(raw) : NaN
          return Number.isFinite(n) && n > 0 ? n : null
        },
        renderHTML: (attrs) =>
          typeof attrs.width === 'number' ? { 'data-width': attrs.width } : {},
      },
      align: {
        default: null,
        parseHTML: (el) => {
          const v = el.getAttribute('data-align')
          return v === 'left' || v === 'right' ? v : null
        },
        renderHTML: (attrs) =>
          attrs.align === 'left' || attrs.align === 'right'
            ? { 'data-align': attrs.align }
            : {},
      },
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView)
  },
})
