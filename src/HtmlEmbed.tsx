/**
 * 笔记里的「网页卡片」：把一份 .html 直接嵌进正文里显示。
 *
 * - 拖进来 / 粘贴 / 点工具栏「HTML」选文件都会生成一张卡片
 * - 卡片里是真的网页（iframe），可以滚、可以点、能跑脚本
 * - 高度可以拖着调，能全屏看，也能一键丢到浏览器里打开
 * - 正文里只留一行元信息，网页文件存在 笔记目录/.assets/
 */
import { Node, mergeAttributes } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'
import { NodeSelection } from '@tiptap/pm/state'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getStorage } from './storage'
import {
  DEFAULT_HEIGHT,
  MAX_HEIGHT,
  MIN_HEIGHT,
  humanSize,
  makeAssetName,
  titleOf,
} from './embed'

/**
 * 允许脚本、表单、弹窗：生成出来的网页往往靠内联 JS 画图表。
 * 这些文件是用户自己拖进来的本地文件，按可信内容处理（关掉脚本很多页面会白屏）。
 */
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals'

/**
 * 找卡片外面的滚动容器：鼠标在网页里滚到底还想接着往下滚时，把滚动接力给它。
 * 从卡片往上找第一个「真的能滚」的元素，找不到就用整页。
 */
function outerScroller(from: HTMLElement | null): HTMLElement | null {
  let n = from?.parentElement ?? null
  while (n) {
    const style = getComputedStyle(n)
    if (/(auto|scroll)/.test(style.overflowY) && n.scrollHeight > n.clientHeight + 1) return n
    n = n.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) ?? null
}

export const HtmlEmbed = Node.create({
  name: 'htmlEmbed',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      file: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-file') ?? '',
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-file': attrs.file }),
      },
      title: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-title') ?? '',
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-title': attrs.title }),
      },
      height: {
        default: DEFAULT_HEIGHT,
        parseHTML: (el: HTMLElement) => Number(el.getAttribute('data-height')) || DEFAULT_HEIGHT,
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-height': attrs.height }),
      },
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-html-embed]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-html-embed': '' })]
  },
  addNodeView() {
    return ReactNodeViewRenderer(HtmlCard)
  },
})

/** 正文里现在有几张网页卡片 */
function embedCount(editor: Editor): number {
  let n = 0
  editor.state.doc.descendants((child) => {
    if (child.type.name === 'htmlEmbed') n++
  })
  return n
}

/**
 * 把一段 HTML 存成附件并插进正文；at 是落点（拖拽时按鼠标位置插）。
 *
 * 这里不靠 focus 决定落点 —— 桌面端拖文件时窗口本身没聚焦，focus 那条路会
 * 悄悄失败，结果文件写进 .assets 了、正文里却什么都没有。改成直接算位置 +
 * insertContentAt，插完再验一次，没落地就退到「追加到末尾」并报错。
 */
export async function insertHtmlEmbed(
  editor: Editor,
  html: string,
  fileName: string,
  at?: number,
): Promise<{ file: string; title: string; height: number }> {
  const file = await getStorage().saveAsset(makeAssetName(), html)
  const attrs = { file, title: titleOf(fileName), height: DEFAULT_HEIGHT }
  // 后面补一个空段落：不然卡片落在正文末尾时，光标没地方落脚没法接着写
  const nodes = [{ type: 'htmlEmbed', attrs }, { type: 'paragraph' }]
  const before = embedCount(editor)
  const doc = editor.state.doc
  const sel = editor.state.selection
  const end = doc.content.size

  // 落点：拖拽按鼠标位置；选中别的卡片时插到它后面（免得把它替换掉）；否则按光标
  let pos = typeof at === 'number' && Number.isFinite(at) ? at : sel.to
  if (sel instanceof NodeSelection && typeof at !== 'number') pos = sel.to
  pos = Math.max(0, Math.min(Math.round(pos), end))

  const put = (p: number) => editor.chain().insertContentAt(p, nodes).scrollIntoView().run()

  try {
    if (editor.isDestroyed) throw new Error('编辑器已经关了（笔记可能刚被切走），这张卡片没能插进来')
    if (!put(pos) || embedCount(editor) === before) {
      // 位置上插不进去（落点在叶子节点里之类），退一步：追加到正文末尾
      put(end)
    }
    if (embedCount(editor) === before) throw new Error('卡片没插进正文（编辑器拒绝了这次插入）')
  } catch (e) {
    // 插不进去就别把孤儿文件留在 .assets 里
    try {
      await getStorage().removeAsset(file)
    } catch {
      /* 删不掉也无所谓 */
    }
    throw e instanceof Error ? e : new Error(String(e))
  }

  // 光标已经跟着插入内容落到卡片后面，这里只是把焦点给回编辑器，接着就能打字
  try {
    if (!editor.isFocused) editor.commands.focus()
  } catch {
    /* 窗口没聚焦时失败无所谓，不影响卡片已经在正文里 */
  }
  return attrs
}

function HtmlCard({ node, updateAttributes, selected, deleteNode, editor, getPos }: NodeViewProps) {
  const file = String(node.attrs.file ?? '')
  const title = String(node.attrs.title ?? '') || file || '网页'
  const height = Math.min(
    MAX_HEIGHT,
    Math.max(MIN_HEIGHT, Number(node.attrs.height) || DEFAULT_HEIGHT),
  )

  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const [liveH, setLiveH] = useState(height)
  const [full, setFull] = useState(false)
  const [resizing, setResizing] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const cardRef = useRef<HTMLDivElement | null>(null)
  const nameRef = useRef<HTMLInputElement | null>(null)
  const wheelOff = useRef<(() => void) | null>(null)

  useEffect(() => setLiveH(height), [height])

  // 进改名状态时把原名整段选上，直接打字就替换
  useEffect(() => {
    if (renaming) nameRef.current?.select()
  }, [renaming])

  useEffect(() => () => wheelOff.current?.(), [])

  useEffect(() => {
    let alive = true
    setHtml(null)
    setError('')
    getStorage()
      .readAsset(file)
      .then((text) => {
        if (alive) setHtml(text)
      })
      .catch((e: unknown) => {
        if (alive) setError(String((e as Error)?.message ?? e))
      })
    return () => {
      alive = false
    }
  }, [file, tick])

  // 全屏时按 Esc 退出
  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFull(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full])

  const openInBrowser = useCallback(async () => {
    try {
      await getStorage().openAsset(file)
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    }
  }, [file])

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const startH = liveH
    let next = startH
    document.body.style.userSelect = 'none'
    // 铺一层全屏透明罩接住鼠标：往下拖时指针会滑到别的网页卡片上，
    // 那些 iframe 会把 mousemove 吃掉，主文档就收不到、高度也拖不动
    setResizing(true)
    const move = (ev: MouseEvent) => {
      next = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startH + ev.clientY - startY)))
      setLiveH(next)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.userSelect = ''
      setResizing(false)
      updateAttributes({ height: next })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  /** 双击标题改名：回车/点别处保存，Esc 放弃，空名字当没改 */
  const startRename = () => {
    setDraft(title)
    setRenaming(true)
  }
  const commitRename = () => {
    const next = draft.trim()
    setRenaming(false)
    if (next && next !== title) updateAttributes({ title: next })
  }

  /** 网页里滚到头了，剩下的滚动量接着滚笔记正文（不然鼠标停在卡片上就滚不动页面） */
  const attachWheel = (frame: HTMLIFrameElement) => {
    wheelOff.current?.()
    wheelOff.current = null
    const doc = frame.contentDocument
    if (!doc) return
    const onWheel = (ev: WheelEvent) => {
      const root = (doc.scrollingElement ?? doc.documentElement) as HTMLElement | null
      if (!root) return
      const atTop = root.scrollTop <= 0
      const atBottom = Math.ceil(root.scrollTop + root.clientHeight) >= root.scrollHeight - 1
      if (!((ev.deltaY > 0 && atBottom) || (ev.deltaY < 0 && atTop))) return
      const outer = outerScroller(cardRef.current)
      if (!outer) return
      ev.preventDefault()
      outer.scrollTop += ev.deltaY
    }
    doc.addEventListener('wheel', onWheel, { passive: false })
    wheelOff.current = () => doc.removeEventListener('wheel', onWheel)
  }

  /** 短的网页别留一大片空白：第一次载入时按内容把高度收一收（只收不放） */
  const fitRef = useRef('')
  const onFrameLoad = (e: React.SyntheticEvent<HTMLIFrameElement>) => {
    const frameEl = e.currentTarget
    attachWheel(frameEl)
    if (fitRef.current === file) return
    // 只收「还没动过」的默认高度，用户自己拖过的高度一律尊重
    if (Math.abs(liveH - DEFAULT_HEIGHT) > 2) return
    const doc = frameEl.contentDocument
    if (!doc) return
    fitRef.current = file
    // 量 body 的高度：html 的 scrollHeight 至少等于视口，量出来永远「刚好装满」
    const body = doc.body
    const h = body
      ? Math.max(body.scrollHeight, Math.ceil(body.getBoundingClientRect().height))
      : (doc.documentElement?.scrollHeight ?? 0)
    if (h > 60 && h < liveH - 12) {
      const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, h + 6))
      setLiveH(next)
      updateAttributes({ height: next })
    }
  }

  const frame = (
    <iframe
      className="html-frame"
      title={title}
      srcDoc={html ?? ''}
      sandbox={SANDBOX}
      style={{ height: liveH }}
      onLoad={onFrameLoad}
    />
  )

  return (
    <NodeViewWrapper
      className={`html-card${selected ? ' selected' : ''}${error ? ' broken' : ''}`}
      contentEditable={false}
      ref={cardRef}
      onClick={(e: React.MouseEvent) => {
        const pos = getPos()
        if (typeof pos !== 'number') return
        if (editor.state.selection.from === pos) return
        // 点卡片就选中它（方便看到边框、按删除键删掉）
        e.preventDefault()
        editor.commands.setNodeSelection(pos)
      }}
    >
      <div className="html-card-head" data-drag-handle title="按住拖动可挪位置">
        <span className="html-card-icon">{'</>'}</span>
        {renaming ? (
          <input
            ref={nameRef}
            className="html-card-name"
            value={draft}
            spellCheck={false}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                e.preventDefault()
                commitRename()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setRenaming(false)
              }
            }}
          />
        ) : (
          <span
            className="html-card-title"
            title="双击改名字"
            onDoubleClick={(e) => {
              e.stopPropagation()
              startRename()
            }}
          >
            {title}
          </span>
        )}
        {html !== null && <span className="html-card-size">{humanSize(html.length)}</span>}
        <span className="html-card-acts">
          <button
            type="button"
            className="html-act"
            title="重新载入（文件被改过时用）"
            onClick={(e) => {
              e.stopPropagation()
              setTick((v) => v + 1)
            }}
          >
            ↻
          </button>
          <button
            type="button"
            className="html-act"
            title="全屏看"
            onClick={(e) => {
              e.stopPropagation()
              setFull(true)
            }}
          >
            ⛶
          </button>
          <button
            type="button"
            className="html-act"
            title="用浏览器打开原文件"
            onClick={(e) => {
              e.stopPropagation()
              void openInBrowser()
            }}
          >
            ↗
          </button>
          <button
            type="button"
            className="html-act del"
            title="从笔记里移除（不会删掉 .assets 里的文件）"
            onClick={(e) => {
              e.stopPropagation()
              deleteNode()
            }}
          >
            ×
          </button>
        </span>
      </div>

      <div className="html-card-body">
        {error ? (
          <div className="html-card-err">
            <b>这个网页打不开</b>
            <span>{error}</span>
          </div>
        ) : html === null ? (
          <div className="html-card-loading">正在载入网页…</div>
        ) : html.trim() ? (
          frame
        ) : (
          <div className="html-card-err">
            <b>这个网页是空的</b>
          </div>
        )}
      </div>

      <span
        className="html-resize"
        title="拖动调整高度"
        // 用捕获阶段：先于编辑器的 mousedown 拿到事件，否则 ProseMirror 会把这次拖动
        // 当成「拖动整个卡片」，页面收不到 mousemove，高度就拖不动
        onMouseDownCapture={(e) => startResize(e)}
      />
      <span className="html-drag-hint">网页 · 拖底部可调高度</span>

      {resizing && createPortal(<div className="html-resize-mask" />, document.body)}

      {full &&
        createPortal(
          <div
            className="html-full"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setFull(false)
            }}
          >
            <div className="html-full-box">
              <div className="html-full-head">
                <span className="html-full-title">{title}</span>
                <span className="html-full-acts">
                  <button type="button" onClick={() => void openInBrowser()}>
                    在浏览器中打开
                  </button>
                  <button type="button" className="primary" onClick={() => setFull(false)}>
                    关闭（Esc）
                  </button>
                </span>
              </div>
              <div className="html-full-body">
                {html === null ? (
                  <div className="html-card-loading">正在载入网页…</div>
                ) : (
                  <iframe
                    className="html-frame"
                    title={title}
                    srcDoc={html}
                    sandbox={SANDBOX}
                    style={{ height: '100%' }}
                  />
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </NodeViewWrapper>
  )
}
