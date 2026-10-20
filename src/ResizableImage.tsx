/**
 * 可拖动、可缩放、可环绕的图片节点。
 *
 * - 拖动：按住图片拖到别的位置（ProseMirror 原生节点拖拽）
 * - 缩放：选中图片后拖右下角圆点，宽度按像素记进节点属性
 * - 环绕 / 边框 / 翻转：顶部工具栏（ImageToolbar）设置
 * - 全部样式通过 Markdown 图片语法的 title 存盘：
 *   ![说明](地址 "480 left #ff0000 2px flipx")
 */
import { useRef } from 'react'
import Image from '@tiptap/extension-image'
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'

const MIN_WIDTH = 80

export type ImgAlign = 'left' | 'right' | null

export type ImgState = {
  width: number | null
  align: ImgAlign
  borderColor: string | null
  borderWidth: number | null
  flipx: boolean
  flipy: boolean
}

/** title 字段 ⇄ 图片状态，token：宽度 / left|right / #颜色 / Npx / flipx / flipy */
export function parseImgTitle(title: unknown): ImgState {
  const s = typeof title === 'string' ? title.trim() : ''
  const st: ImgState = { width: null, align: null, borderColor: null, borderWidth: null, flipx: false, flipy: false }
  if (!s) return st
  for (const token of s.split(/\s+/)) {
    const n = Number(token)
    if (Number.isFinite(n) && n > 0 && st.width === null) st.width = n
    if (token === 'left' || token === 'right') st.align = token
    if (/^#[0-9a-fA-F]{3,8}$/.test(token)) st.borderColor = token
    const bw = /^(\d+)px$/.exec(token)
    if (bw) st.borderWidth = Number(bw[1])
    if (token === 'flipx') st.flipx = true
    if (token === 'flipy') st.flipy = true
  }
  return st
}

export function buildImgTitle(st: ImgState): string {
  return [
    st.width ?? '',
    st.align ?? '',
    st.borderColor ?? '',
    st.borderWidth && st.borderWidth > 0 ? `${st.borderWidth}px` : '',
    st.flipx ? 'flipx' : '',
    st.flipy ? 'flipy' : '',
  ]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 编辑器节点当前状态：先取 title，再用 attrs 覆盖 */
export function readImgState(node: { attrs?: Record<string, unknown> | null }): ImgState {
  const a = node.attrs ?? {}
  const t = parseImgTitle(a.title)
  const width = typeof a.width === 'number' ? (a.width as number) : t.width
  const align: ImgAlign =
    a.align === 'left' || a.align === 'right' ? (a.align as ImgAlign) : t.align
  const borderColor =
    typeof a.borderColor === 'string' && a.borderColor ? a.borderColor : t.borderColor
  const borderWidth =
    typeof a.borderWidth === 'number' ? (a.borderWidth as number) : t.borderWidth
  return {
    width,
    align,
    borderColor: borderColor ?? null,
    borderWidth: borderWidth ?? null,
    flipx: a.flipx === true || t.flipx,
    flipy: a.flipy === true || t.flipy,
  }
}

/** 把整份状态打回节点（attrs + title 同步） */
export function imgAttrsFrom(st: ImgState): Record<string, unknown> {
  return {
    width: st.width,
    align: st.align,
    borderColor: st.borderColor,
    borderWidth: st.borderWidth,
    flipx: st.flipx,
    flipy: st.flipy,
    title: buildImgTitle(st),
  }
}

function ImageView({ node, updateAttributes, selected, editor, getPos }: NodeViewProps) {
  const imgRef = useRef<HTMLImageElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const st = readImgState(node)

  const apply = (patch: Partial<ImgState>) => {
    updateAttributes(imgAttrsFrom({ ...st, ...patch }))
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
      // 拖到几乎满宽就当没设置过，随窗口自适应
      apply({ width: w >= maxW - 6 ? null : w })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const flips: React.CSSProperties = {}
  if (st.flipx && st.flipy) flips.transform = 'scale(-1, -1)'
  else if (st.flipx) flips.transform = 'scaleX(-1)'
  else if (st.flipy) flips.transform = 'scaleY(-1)'

  const border: React.CSSProperties = {}
  if (st.borderWidth && st.borderWidth > 0) {
    border.border = `${st.borderWidth}px solid ${st.borderColor ?? '#3a362e'}`
    // 翻转不翻边框，边框画在外层
  }

  return (
    <NodeViewWrapper
      ref={wrapRef}
      className={`img-wrap${selected ? ' selected' : ''}${st.align ? ` img-float-${st.align}` : ''}`}
      data-drag-handle
      title="按住拖动可挪位置"
      // 点一下就把自己选中（否则点回图片只会落成文字光标，工具栏切不回来）
      onClick={(e: React.MouseEvent) => {
        const pos = getPos()
        if (typeof pos !== 'number') return
        e.preventDefault()
        if (editor.state.selection.from !== pos) editor.commands.setNodeSelection(pos)
      }}
    >
      <span
        className="img-frame"
        style={{
          ...border,
          display: 'inline-block',
          lineHeight: 0,
          borderRadius: 8,
          overflow: 'hidden',
          transform: flips.transform,
        }}
      >
        <img
          ref={imgRef}
          src={String(node.attrs.src ?? '')}
          alt={String(node.attrs.alt ?? '')}
          draggable={false}
          style={{
            width: st.width ? `${st.width}px` : undefined,
            transform: border.transform,
            display: 'block',
            borderRadius: st.borderWidth && st.borderWidth > 0 ? 0 : 8,
          }}
        />
      </span>
      <span className="img-resize" title="拖动调整大小" onMouseDown={startResize} />
    </NodeViewWrapper>
  )
}

export const ResizableImage = Image.extend({
  draggable: true,
  addAttributes() {
    return {
      ...this.parent?.(),
      width: { default: null },
      align: { default: null },
      borderColor: { default: null },
      borderWidth: { default: null },
      flipx: { default: false },
      flipy: { default: false },
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView)
  },
})
