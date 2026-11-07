/**
 * 笔记里的 .md 文档：把一份 Markdown 文件直接嵌进正文里显示。
 *
 * 和网页卡片（HtmlEmbed.tsx）同一套交互，但实现完全不同：
 * - .md 就是笔记自己的语言，不用 iframe —— 直接解析成正文节点摆进去，
 *   高度天然贴着内容，**没有**「先占位再撑开」的抖动；
 * - 排版复用正文样式（.rich-body），看起来就是笔记的一部分；
 * - ✎ 编辑打开源码窗（Markdown 本来就该改源码），保存写回 .assets/ 里的文件，
 *   覆盖前留一份 .bak.md；frontmatter 原样保留；
 * - 卡片 ⇄ 融入正文随时切换，双击标题改名，和网页卡片一样。
 */
import { Node, mergeAttributes } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'
import { NodeSelection } from '@tiptap/pm/state'
import { DOMSerializer } from '@tiptap/pm/model'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getStorage } from './storage'
import { mdToDoc } from './md-doc'
import {
  DEFAULT_HEIGHT,
  DEFAULT_MODE,
  INSERT_MODE,
  MAX_HEIGHT,
  MIN_HEIGHT,
  humanSize,
} from './embed'
import {
  backupNameMd,
  makeMdAssetName,
  stripFrontmatter,
  titleOfMd,
  type MdMeta,
} from './mdmeta'

export const MdEmbed = Node.create({
  name: 'mdEmbed',
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
      mode: {
        default: DEFAULT_MODE,
        parseHTML: (el: HTMLElement) => (el.getAttribute('data-mode') === 'inline' ? 'inline' : 'card'),
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-mode': attrs.mode }),
      },
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-md-embed]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-md-embed': '' })]
  },
  addNodeView() {
    return ReactNodeViewRenderer(MdCard)
  },
})

/** 正文里现在有几张文档卡片 */
function mdCount(editor: Editor): number {
  let n = 0
  editor.state.doc.descendants((child) => {
    if (child.type.name === 'mdEmbed') n++
  })
  return n
}

/**
 * 把一份 .md 的文本存成附件并插进正文；at 是落点（拖拽时按鼠标位置插）。
 * 落点策略与网页卡片一致：桌面端拖文件时窗口没聚焦，不能靠 focus 算位置；
 * 插不进去就退到正文末尾，再不行就删掉刚存的文件并报错，不留孤儿。
 */
export async function insertMdEmbed(
  editor: Editor,
  md: string,
  fileName: string,
  at?: number,
): Promise<MdMeta> {
  const file = await getStorage().saveAsset(makeMdAssetName(), md)
  // 新插入的文档默认「融入正文」：整篇排进笔记里，和网页卡片一个习惯
  const attrs: MdMeta = {
    file,
    title: titleOfMd(fileName),
    height: DEFAULT_HEIGHT,
    mode: INSERT_MODE,
  }
  // 后面补一个空段落：光标才有地方落脚接着写
  const nodes = [{ type: 'mdEmbed', attrs }, { type: 'paragraph' }]
  const before = mdCount(editor)
  const doc = editor.state.doc
  const sel = editor.state.selection
  const end = doc.content.size

  let pos = typeof at === 'number' && Number.isFinite(at) ? at : sel.to
  if (sel instanceof NodeSelection && typeof at !== 'number') pos = sel.to
  pos = Math.max(0, Math.min(Math.round(pos), end))

  const put = (p: number) => editor.chain().insertContentAt(p, nodes).scrollIntoView().run()

  try {
    if (editor.isDestroyed) throw new Error('编辑器已经关了（笔记可能刚被切走），这份文档没能插进来')
    if (!put(pos) || mdCount(editor) === before) put(end)
    if (mdCount(editor) === before) throw new Error('文档没插进正文（编辑器拒绝了这次插入）')
  } catch (e) {
    try {
      await getStorage().removeAsset(file)
    } catch {
      /* 删不掉也无所谓 */
    }
    throw e instanceof Error ? e : new Error(String(e))
  }

  try {
    if (!editor.isFocused) editor.commands.focus()
  } catch {
    /* 窗口没聚焦时失败无所谓 */
  }
  return attrs
}

/** 渲染出来的静态正文里，嵌套的网页卡片只能显示成一块占位（真正的网页要在笔记顶层才跑得起来） */
function markNestedHtmlEmbeds(container: HTMLElement) {
  container.querySelectorAll('div[data-html-embed]').forEach((el) => {
    const t = el.getAttribute('data-title') || '网页'
    el.textContent = ''
    const chip = document.createElement('div')
    chip.className = 'md-nested-html'
    chip.textContent = `🧩 网页附件：${t}（这份 .md 里嵌的网页，在文档卡片里以占位显示）`
    el.appendChild(chip)
  })
}

function MdCard({ node, updateAttributes, selected, deleteNode, editor, getPos }: NodeViewProps) {
  const file = String(node.attrs.file ?? '')
  const title = String(node.attrs.title ?? '') || file || '文档'
  const height = Math.min(
    MAX_HEIGHT,
    Math.max(MIN_HEIGHT, Number(node.attrs.height) || DEFAULT_HEIGHT),
  )
  const inline = node.attrs.mode === 'inline'

  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  /** 源码编辑窗 */
  const [srcOpen, setSrcOpen] = useState(false)
  const [srcText, setSrcText] = useState('')
  const [saving, setSaving] = useState(false)
  /** 卡片模式的实时高度（拖拽时变） */
  const [liveH, setLiveH] = useState(height)
  const [resizing, setResizing] = useState(false)
  /** 改名 */
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(title)
  const nameRef = useRef<HTMLInputElement | null>(null)

  const bodyRef = useRef<HTMLDivElement | null>(null)
  /** 解析结果摆这里（命令式渲染，和 React 的提示框分开，互不覆盖） */
  const renderRef = useRef<HTMLDivElement | null>(null)

  /* 载入文件 */
  useEffect(() => {
    let alive = true
    setError('')
    setSrc(null)
    if (!file) {
      setError('这份文档没记录文件名，显示不了')
      return
    }
    getStorage()
      .readAsset(file)
      .then((text) => {
        if (alive) setSrc(text)
      })
      .catch((e) => {
        if (alive) setError(String((e as Error)?.message ?? e))
      })
    return () => {
      alive = false
    }
  }, [file, tick])

  /* 解析并渲染：md → 正文节点 → 静态 DOM（复用正文的排版样式） */
  useEffect(() => {
    const el = renderRef.current
    if (!el || src === null) return
    el.textContent = ''
    if (!src.trim()) return
    try {
      const { body } = stripFrontmatter(src)
      const doc = mdToDoc(body)
      const pmDoc = editor.schema.nodeFromJSON(doc)
      const frag = DOMSerializer.fromSchema(editor.schema).serializeFragment(pmDoc.content)
      el.replaceChildren(frag)
      markNestedHtmlEmbeds(el)
    } catch (e) {
      // 解析不动就把源码摆出来，至少内容不丢
      el.textContent = ''
      const pre = document.createElement('pre')
      pre.className = 'md-fallback-src'
      pre.textContent = String((e as Error)?.message ?? e) + '\n\n' + src
      el.appendChild(pre)
    }
  }, [src, tick, editor])

  /* 改名：双击标题，回车确认 */
  const startRename = useCallback(() => {
    setDraft(title)
    setRenaming(true)
    window.setTimeout(() => {
      nameRef.current?.focus()
      nameRef.current?.select()
    }, 0)
  }, [title])
  const commitRename = useCallback(() => {
    setRenaming(false)
    const t = draft.trim()
    if (t && t !== title) updateAttributes({ title: t })
  }, [draft, title, updateAttributes])

  /* 模式切换 */
  const switchMode = (next: 'card' | 'inline') => {
    if (next === 'inline') {
      updateAttributes({ mode: 'inline' })
    } else {
      // 融入切回卡片：按内容实际高度起步（量一次就行，md 渲染是同步的）
      const h = renderRef.current?.scrollHeight ?? 0
      updateAttributes({
        mode: 'card',
        height: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, h || height)),
      })
    }
  }

  /* 拖底部调卡片高度（同网页卡片） */
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const startH = liveH
    let next = startH
    document.body.style.userSelect = 'none'
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

  /* 链接：锚点滚到文内标题，外链交给系统浏览器，其余一律不放行（防止 webview 被导航走） */
  const onBodyClick = (ev: React.MouseEvent) => {
    const target = ev.target as Element | null
    const a = target?.closest?.('a') as HTMLAnchorElement | null
    if (!a) return
    ev.preventDefault()
    ev.stopPropagation()
    const href = a.getAttribute('href') ?? ''
    if (href.startsWith('#')) {
      let id = href.slice(1)
      try {
        id = decodeURIComponent(id)
      } catch {
        /* 编码不合法就按原值找 */
      }
      const el = renderRef.current
      if (!el) return
      const hit =
        (id && (el.querySelector(`#${CSS.escape(id)}`) as HTMLElement | null)) ||
        (id
          ? (Array.from(el.querySelectorAll('h1,h2,h3,h4,h5,h6')).find(
              (h) => (h.textContent ?? '').trim() === id,
            ) as HTMLElement | null)
          : null)
      if (hit) hit.scrollIntoView({ block: 'start', behavior: 'smooth' })
      else if (!id) bodyRef.current?.scrollIntoView({ block: 'start' })
      return
    }
    if (/^https?:\/\//i.test(href)) void getStorage().openUrl(href)
  }

  /* 源码编辑：保存写回文件，覆盖前留 .bak.md */
  const openSource = () => {
    if (src === null) return
    setSrcText(src)
    setSrcOpen(true)
  }
  const saveSource = async () => {
    if (!file) return
    setSaving(true)
    try {
      const st = getStorage()
      if (src !== null) {
        try {
          await st.saveAsset(backupNameMd(file), src)
        } catch {
          /* 留不了备份也不挡保存 */
        }
      }
      // srcText 是整份文件的原文（frontmatter 就在里面），原样写回，不要再拼一遍
      await st.saveAsset(file, srcText)
      setSrc(srcText)
      setSrcOpen(false)
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setSaving(false)
    }
  }

  const shownH = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, liveH))

  return (
    <NodeViewWrapper
      className={`html-card md-card${inline ? ' inline' : ''}${selected ? ' selected' : ''}${error ? ' broken' : ''}`}
      contentEditable={false}
      onClick={(e: React.MouseEvent) => {
        const pos = getPos()
        if (typeof pos !== 'number') return
        if (editor.state.selection.from === pos) return
        e.preventDefault()
        editor.commands.setNodeSelection(pos)
      }}
    >
      {/* 融入正文：淡工具条，移上去才清晰 */}
      {inline && (
        <div
          className="html-inline-tools"
          contentEditable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {renaming ? (
            <input
              ref={nameRef}
              className="html-inline-name"
              value={draft}
              spellCheck={false}
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
              className="html-inline-title"
              title="双击改名字"
              onDoubleClick={(e) => {
                e.stopPropagation()
                startRename()
              }}
            >
              {title}
            </span>
          )}
          <button
            type="button"
            className="html-inline-mode"
            title="改 Markdown 源码，改完存回文件"
            onClick={() => openSource()}
          >
            ✎ 编辑
          </button>
          <button
            type="button"
            className="html-inline-mode"
            title="切回卡片模式：固定高度、可拖动调整"
            onClick={() => switchMode('card')}
          >
            ▣ 卡片
          </button>
          <button type="button" className="html-act" title="重新载入（文件被改过时用）" onClick={() => setTick((v) => v + 1)}>
            ↻
          </button>
          <button type="button" className="html-act del" title="从笔记里移除（不会删掉 .assets 里的文件）" onClick={() => deleteNode()}>
            ×
          </button>
        </div>
      )}

      {!inline && (
        <div className="html-card-head" data-drag-handle title="按住拖动可挪位置">
          <span className="html-card-icon">M↓</span>
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
          {src !== null && <span className="html-card-size">{humanSize(src.length)}</span>}
          <span className="html-card-acts">
            <button
              type="button"
              className="html-inline-mode"
              title="融入正文：去掉卡片外框，整篇跟着笔记一起排"
              onClick={(e) => {
                e.stopPropagation()
                switchMode('inline')
              }}
            >
              ⤢ 融入
            </button>
            <button
              type="button"
              className="html-act"
              title="改 Markdown 源码，改完存回文件"
              onClick={(e) => {
                e.stopPropagation()
                openSource()
              }}
            >
              ✎
            </button>
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
      )}

      <div
        className="html-card-body md-card-body"
        style={inline ? undefined : { height: shownH }}
        onClickCapture={onBodyClick}
        ref={bodyRef}
      >
        {error ? (
          <div className="html-card-err">
            <b>这个文档打不开</b>
            <span>{error}</span>
          </div>
        ) : src === null ? (
          <div className="html-card-loading">正在载入文档…</div>
        ) : (
          <div className="md-render rich-body" ref={renderRef} />
        )}
      </div>

      {!inline && (
        <>
          <span
            className="html-resize"
            title="拖动调整高度"
            onMouseDownCapture={(e) => startResize(e)}
          />
          <span className="html-drag-hint">文档 · 拖底部可调高度</span>
        </>
      )}

      {resizing && createPortal(<div className="html-resize-mask" />, document.body)}

      {srcOpen &&
        createPortal(
          <div
            className="html-full"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setSrcOpen(false)
            }}
          >
            <div className="html-src-box">
              <div className="html-full-head">
                <span className="html-full-title">改源码 · {title}</span>
                <span className="html-full-acts">
                  <button type="button" disabled={saving} onClick={() => setSrcOpen(false)}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={saving}
                    onClick={() => void saveSource()}
                  >
                    {saving ? '保存中…' : '保存'}
                  </button>
                </span>
              </div>
              <textarea
                className="html-src-text"
                value={srcText}
                spellCheck={false}
                placeholder="这里是这份文档的 Markdown 源码，改完点保存（⌘S）"
                onChange={(e) => setSrcText(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault()
                    void saveSource()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setSrcOpen(false)
                  }
                }}
              />
            </div>
          </div>,
          document.body,
        )}
    </NodeViewWrapper>
  )
}
