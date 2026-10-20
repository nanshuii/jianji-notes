/**
 * 可拖动、可缩放的图片节点。
 *
 * - 拖动：按住图片拖到别的位置（ProseMirror 原生节点拖拽）
 * - 缩放：选中图片后拖右下角圆点，宽度按像素记进节点属性
 * - 宽度通过 Markdown 图片语法的 title 存盘：![说明](地址 "480")，
 *   关掉再打开不会丢
 */
import { useRef } from 'react'
import Image from '@tiptap/extension-image'
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'

const MIN_WIDTH = 80

function ImageView({ node, updateAttributes, selected }: NodeViewProps) {
  const imgRef = useRef<HTMLImageElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const width = typeof node.attrs.width === 'number' ? (node.attrs.width as number) : null

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
      // 拖到几乎满宽就当没设置过，随窗口自适应
      updateAttributes({ width: w >= maxW - 6 ? null : w })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <NodeViewWrapper
      ref={wrapRef}
      as="span"
      className={`img-wrap${selected ? ' selected' : ''}`}
      data-drag-handle
      title="按住拖动可挪位置，缩小后旁边还能写字"
    >
      <img
        ref={imgRef}
        src={String(node.attrs.src ?? '')}
        alt={String(node.attrs.alt ?? '')}
        draggable={false}
        style={width ? { width: `${width}px` } : undefined}
      />
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
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView)
  },
})
