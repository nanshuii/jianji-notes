/**
 * 选中图片时顶部显示的图片工具栏：左/右/整行、裁剪、复制、边框、翻转。
 * 点回文字或空白处时，RichEditor 会切回普通文字工具栏。
 */
import { useEffect, useRef, useState } from 'react'
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

/**
 * 直接按位置改节点属性。
 * 注意：不能用 editor.commands.updateAttributes —— 图片是 NodeSelection（空选区），
 * Tiptap 在空选区下用 nodesBetween(from, to) 找不到节点，命令会静默失效。
 */
export function setImageAttrs(editor: Editor, pos: number, patch: Partial<ImgState>) {
  const cur = editor.state.doc.nodeAt(pos)
  if (!cur || cur.type.name !== 'image') return
  const next: ImgState = { ...readImgState(cur), ...patch }
  const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, ...imgAttrsFrom(next) })
  editor.view.dispatch(tr)
  // 改完属性选区可能被折回文字光标，重新选中这张图，工具栏才不会跳回文字态
  const sel = editor.state.selection
  if (!(sel instanceof NodeSelection) || sel.from !== pos) {
    try {
      editor.commands.setNodeSelection(pos)
    } catch {
      /* 位置失效就算了 */
    }
  }
  // 诊断用：记录最近一次图片属性操作，排查“点了没反应”时读这条
  try {
    localStorage.setItem('jianji.imgTool', `${new Date().toISOString()} ${JSON.stringify(patch)}`)
  } catch {
    /* 忽略 */
  }
}

function apply(editor: Editor, sel: NonNullable<ReturnType<typeof selectedImage>>, patch: Partial<ImgState>) {
  setImageAttrs(editor, sel.from, patch)
}

const BORDER_STEPS = [0, 1, 2, 4, 6]

/** 常用边框颜色（20 个） */
const PALETTE = [
  '#000000', '#4b5563', '#9ca3af', '#ffffff',
  '#ef4444', '#b91c1c', '#f97316', '#f59e0b',
  '#eab308', '#84cc16', '#22c55e', '#15803d',
  '#14b8a6', '#0ea5e9', '#3b82f6', '#6366f1',
  '#a855f7', '#ec4899', '#92400e', '#f5e6c8',
]

export function ImageToolbar({
  editor,
  onCrop,
}: {
  editor: Editor
  onCrop: (src: string, pos: number) => void
}) {
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
    // 保持图片选中，工具栏停在图片态（不要把光标挪走）
  }

  const [copied, setCopied] = useState('')
  const flash = (text: string) => {
    setCopied(text)
    window.setTimeout(() => setCopied(''), 1600)
  }

  /** 画到 canvas 再转 PNG，作为 ClipboardItem 的 Promise（保住用户手势，不然 WebKit 拒绝写） */
  const pngBlob = async (): Promise<Blob> => {
    const res = await fetch(src)
    const blob = await res.blob()
    const bmp = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bmp.width
    canvas.height = bmp.height
    canvas.getContext('2d')?.drawImage(bmp, 0, 0)
    bmp.close()
    return new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
    )
  }

  const copyImage = async () => {
    if (!src) return
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob() })])
      flash('已复制')
      return
    } catch {
      /* 继续走退路 */
    }
    // 退路：把图片放进临时节点，用原生 copy 命令
    try {
      const holder = document.createElement('div')
      holder.contentEditable = 'true'
      holder.style.cssText = 'position:fixed;left:-9999px;top:0'
      const im = document.createElement('img')
      im.src = src
      holder.appendChild(im)
      document.body.appendChild(holder)
      const range = document.createRange()
      range.selectNode(im)
      const sel2 = window.getSelection()
      sel2?.removeAllRanges()
      sel2?.addRange(range)
      const ok = document.execCommand('copy')
      sel2?.removeAllRanges()
      holder.remove()
      if (ok) {
        flash('已复制')
        return
      }
    } catch {
      /* 忽略 */
    }
    try {
      await navigator.clipboard.writeText(`![${String(sel.node.attrs.alt ?? '')}](${src})`)
      flash('已复制为文本')
    } catch {
      flash('复制失败')
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
        onMouseDown={(e) => e.preventDefault()} onClick={() => onCrop(src, sel.from)}>
        裁剪
      </button>
      <button type="button" title="把图片复制到系统剪贴板"
        onMouseDown={(e) => e.preventDefault()} onClick={() => void copyImage()}>
        {copied || '复制'}
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
  const [open, setOpen] = useState(false)

  const pick = (color: string) => {
    apply(editor, sel, { borderColor: color, borderWidth: st.borderWidth ?? 2 })
    setOpen(false)
  }

  return (
    <>
      <button
        type="button"
        className={open || (st.borderColor && st.borderWidth) ? 'on' : ''}
        title="设置边框颜色"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        边框色
        {st.borderColor && <span className="color-dot" style={{ background: st.borderColor }} />}
      </button>
      {open && (
        <div className="color-pop" onMouseDown={(e) => e.preventDefault()}>
          {PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              className={`swatch${st.borderColor === c ? ' on' : ''}`}
              style={{ background: c }}
              title={c}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(c)}
            />
          ))}
        </div>
      )}
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
  const [loaded, setLoaded] = useState(false)
  const dragStart = useRef<{ x: number; y: number } | null>(null)

  // data URL 有时在 React 挂上 onLoad 之前就已经加载完了，补一枪检查
  useEffect(() => {
    const img = boxRef.current?.querySelector('img')
    if (img?.complete && img.naturalWidth > 0) setLoaded(true)
  }, [])

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
    // 图还没加载完（naturalWidth 为 0）就裁，只会得到一张废图，宁可不做
    if (!img || !loaded || !img.naturalWidth || !rect || rect.w < 8 || rect.h < 8) {
      if (!loaded) return
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
          <img src={src} draggable={false} alt="" onLoad={() => setLoaded(true)} />
          {rect && rect.w > 2 && rect.h > 2 && (
            <div className="crop-rect" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} />
          )}
        </div>
        <div className="crop-actions">
          <button type="button" disabled={!loaded} title={loaded ? '' : '图片加载中…'} onClick={doApply}>
            {loaded ? '应用裁剪' : '加载中…'}
          </button>
          <button type="button" className="ghost" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
