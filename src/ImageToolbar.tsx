/**
 * 选中图片时顶部显示的图片工具栏：左/右/整行、裁剪、复制、边框、翻转。
 * 点回文字或空白处时，RichEditor 会切回普通文字工具栏。
 */
import { useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { imgAttrsFrom, readImgState, type ImgState } from './ResizableImage'

function selectedImage(editor: Editor) {
  const sel = editor.state.selection
  if (!(sel instanceof NodeSelection)) return null
  const node = sel.node
  if (node.type.name !== 'image') return null
  return { node, from: sel.from }
}

function apply(editor: Editor, node: ReturnType<typeof selectedImage>, patch: Partial<ImgState>) {
  if (!node) return
  const next: ImgState = { ...readImgState(node.node), ...patch }
  editor.chain().updateAttributes('image', imgAttrsFrom(next)).run()
}

/** 光标移到图片后面，方便接着打字 */
function focusAfterImage(editor: Editor, from: number, nodeSize: number) {
  window.setTimeout(() => {
    try {
      editor.chain().setTextSelection(Math.min(from + nodeSize, editor.state.doc.content.size)).focus().run()
    } catch {
      /* 忽略 */
    }
  }, 20)
}

const BORDER_STEPS = [0, 1, 2, 4, 6]

export function ImageToolbar({ editor, onCrop }: { editor: Editor; onCrop: (src: string) => void }) {
  const sel = selectedImage(editor)
  if (!sel) return null
  const st = readImgState(sel.node)
  const src = String(sel.node.attrs.src ?? '')

  const setAlign = (align: ImgState['align']) => {
    let width = st.width
    if (align && !width) {
      // 没设过宽度就给容器的一半，绕排才有意义
      const body = document.querySelector('.rich-body')
      width = body ? Math.round(body.getBoundingClientRect().width * 0.5) : 360
    }
    apply(editor, sel, { align, width: align ? width : null })
    if (align) focusAfterImage(editor, sel.from, sel.node.nodeSize)
  }

  const copyImage = async () => {
    try {
      const res = await fetch(src)
      const blob = await res.blob()
      const bmp = await createImageBitmap(blob)
      const canvas = document.createElement('canvas')
      canvas.width = bmp.width
      canvas.height = bmp.height
      canvas.getContext('2d')?.drawImage(bmp, 0, 0)
      bmp.close()
      const png = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
      )
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    } catch {
      // 剪贴板不给写图片时，退而求其次复制 Markdown
      try {
        await navigator.clipboard.writeText(`![${String(sel.node.attrs.alt ?? '')}](${src})`)
      } catch {
        /* 忽略 */
      }
    }
  }

  const nextBorder = () => {
    const cur = st.borderWidth ?? 0
    const idx = BORDER_STEPS.indexOf(cur)
    const next = BORDER_STEPS[(idx + 1) % BORDER_STEPS.length]
    apply(editor, sel, { borderWidth: next === 0 ? null : next, borderColor: st.borderColor ?? '#3a362e' })
  }

  return (
    <div className="rich-tools">
      <button type="button" className={st.align === 'left' ? 'on' : ''} title="图片靠左，文字在右边绕排"
        onMouseDown={(e) => e.preventDefault()} onClick={() => setAlign('left')}>
        向左
      </button>
      <button type="button" className={st.align === 'right' ? 'on' : ''} title="图片靠右，文字在左边绕排"
        onMouseDown={(e) => e.preventDefault()} onClick={() => setAlign('right')}>
        向右
      </button>
      <button type="button" className={st.align === null ? 'on' : ''} title="独占一行，不环绕"
        onMouseDown={(e) => e.preventDefault()} onClick={() => setAlign(null)}>
        整行
      </button>
      <span className="sep" />
      <button type="button" title="裁剪这张图片"
        onMouseDown={(e) => e.preventDefault()} onClick={() => onCrop(src)}>
        裁剪
      </button>
      <button type="button" title="把图片复制到系统剪贴板"
        onMouseDown={(e) => e.preventDefault()} onClick={() => void copyImage()}>
        复制
      </button>
      <span className="sep" />
      <ColorButton editor={editor} sel={sel} st={st} />
      <button type="button" title="边框粗细（点击切换）"
        onMouseDown={(e) => e.preventDefault()} onClick={nextBorder}>
        粗细{st.borderWidth ? ` ${st.borderWidth}px` : ''}
      </button>
      <span className="sep" />
      <button type="button" className={st.flipx ? 'on' : ''} title="水平翻转（左右镜像）"
        onMouseDown={(e) => e.preventDefault()} onClick={() => apply(editor, sel, { flipx: !st.flipx })}>
        ⇋
      </button>
      <button type="button" className={st.flipy ? 'on' : ''} title="垂直翻转（上下镜像）"
        onMouseDown={(e) => e.preventDefault()} onClick={() => apply(editor, sel, { flipy: !st.flipy })}>
        ⥯
      </button>
    </div>
  )
}

function ColorButton({
  editor,
  sel,
  st,
}: {
  editor: Editor
  sel: NonNullable<ReturnType<typeof selectedImage>>
  st: ImgState
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  return (
    <>
      <button
        type="button"
        className={st.borderColor && st.borderWidth ? 'on' : ''}
        title="设置边框颜色"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => inputRef.current?.click()}
      >
        边框色
        {st.borderColor && <span className="color-dot" style={{ background: st.borderColor }} />}
      </button>
      <input
        ref={inputRef}
        type="color"
        hidden
        value={st.borderColor ?? '#3a362e'}
        onChange={(e) => apply(editor, sel, { borderColor: e.target.value, borderWidth: st.borderWidth ?? 2 })}
      />
    </>
  )
}

/* ---------------- 裁剪弹窗 ---------------- */

type Rect = { x: number; y: number; w: number; h: number }

export function CropModal({
  src,
  onCancel,
  onApply,
}: {
  src: string
  onCancel: () => void
  onApply: (dataUrl: string) => void
}) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [rect, setRect] = useState<Rect | null>(null)
  const dragStart = useRef<{ x: number; y: number } | null>(null)

  const rel = (e: React.MouseEvent | MouseEvent) => {
    const box = boxRef.current!.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(box.width, e.clientX - box.left)),
      y: Math.max(0, Math.min(box.height, e.clientY - box.top)),
    }
  }

  const start = (e: React.MouseEvent) => {
    e.preventDefault()
    dragStart.current = rel(e)
    const move = (ev: MouseEvent) => {
      if (!dragStart.current) return
      const p = rel(ev)
      const s = dragStart.current
      setRect({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) })
    }
    const up = () => {
      dragStart.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const doApply = () => {
    const img = boxRef.current?.querySelector('img')
    if (!img || !rect || rect.w < 8 || rect.h < 8) {
      onCancel()
      return
    }
    const box = boxRef.current!.getBoundingClientRect()
    const scaleX = img.naturalWidth / box.width
    const scaleY = img.naturalHeight / box.height
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(rect.w * scaleX))
    canvas.height = Math.max(1, Math.round(rect.h * scaleY))
    canvas
      .getContext('2d')!
      .drawImage(img, rect.x * scaleX, rect.y * scaleY, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height)
    onApply(canvas.toDataURL('image/png'))
  }

  return (
    <div className="crop-mask" onMouseDown={(e) => e.preventDefault()}>
      <div className="crop-panel">
        <div className="crop-hint">在图上拖一个框，只保留框里的部分</div>
        <div className="crop-box" ref={boxRef} onMouseDown={start}>
          <img src={src} draggable={false} alt="" />
          {rect && rect.w > 2 && rect.h > 2 && (
            <div className="crop-rect" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} />
          )}
        </div>
        <div className="crop-actions">
          <button type="button" onClick={doApply}>
            应用裁剪
          </button>
          <button type="button" className="ghost" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
