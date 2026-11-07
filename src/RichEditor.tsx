import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'
import { ResizableImage } from './ResizableImage'
import { HtmlEmbed, insertHtmlEmbed } from './HtmlEmbed'
import { MdEmbed, insertMdEmbed } from './MdEmbed'
import { MdTable } from './mdtable'
import { isHtmlFile } from './embed'
import { isMdFile } from './mdmeta'
import { getStorage } from './storage'
import { docToMd, mdToDoc } from './md-doc'
import { fileToDataUrl } from './image'
import { classifyPaths, isDroppableFile, pathsToFiles } from './dropped'
import { ImageToolbar, CropModal } from './ImageToolbar'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { undoDepth, redoDepth } from '@tiptap/pm/history'
import { buildNoteLink, parseNoteLink, isExternalUrl } from './notelink'
import { JumpHighlight, flashJump } from './jumpHighlight'
import { NoteLinkDialog } from './NoteLinkDialog'
import type { NoteOption } from './NoteLinkDialog'

/** 撤销/重做栈的上限；连续输入在 500ms 内算一步，避免一个字占掉一步 */
const HISTORY_DEPTH = 100

export type RichEditorHandle = {
  insertFiles: (files: FileList | File[] | null | undefined) => Promise<void>
  /** 弹出系统选图框（顶栏「图片」按钮用） */
  pickImage: () => void
  /** 弹出系统选框，挑 .html 网页或 .md 文档（顶栏「HTML·MD」按钮用） */
  pickHtml: () => void
  focus: () => void
}

type Props = {
  /** 打开时的 Markdown 内容，只在挂载时读一次（切换笔记靠 key 重挂载） */
  initial: string
  onChange: (markdown: string) => void
  /** 出问题时的轻提示（父组件负责显示） */
  onNotice?: (msg: string) => void
  /** 图片按钮入口：把「选文件」交给父组件，父组件调用 ref 上的 insertFiles */
  onReady?: (handle: RichEditorHandle) => void
  /** 所有笔记，供「链接到笔记」弹窗挑目标笔记和目标行 */
  notes?: NoteOption[]
  /** 当前笔记路径，弹窗里不列自己 */
  currentFile?: string
  /** 点了笔记内链接：父组件负责切笔记，并把定位文字带过去 */
  onJumpNote?: (file: string, text: string) => void
  /** 刚跳过来时要高亮的那一段文字；token 保证重复跳同一段也会重新触发 */
  jumpTo?: { text: string; token: number } | null
}

/** 能插进正文的文件：图片和 .html 网页（有些系统拖进来的 File 没有 MIME，按扩展名认） */
function usableFiles(list: FileList | File[] | null | undefined): File[] {
  return Array.from(list ?? []).filter(isDroppableFile)
}

const ONLY_TIP = '只认图片、.html 网页和 .md 文档，其它类型没插进来'

/** 当前文档里的图片数量：插完要数一下，确认编辑器真的收下了 */
function imageCount(ed: Editor): number {
  let n = 0
  ed.state.doc.descendants((node) => {
    if (node.type.name === 'image') n += 1
  })
  return n
}

/**
 * 把图片插到鼠标落点（不再是「管光标在哪儿」）。
 * 图片是行内节点，插进段落中间没问题；万一是原子节点之类的落点，
 * 退到正文末尾用 setImage 兜底，保证文件不会白拖一趟。
 */
function insertImageAt(ed: Editor, src: string, at?: number): boolean {
  const before = imageCount(ed)
  const end = ed.state.doc.content.size
  const sel = ed.state.selection
  let pos = typeof at === 'number' && Number.isFinite(at) ? at : sel.to
  if (sel instanceof NodeSelection && typeof at !== 'number') pos = sel.to
  pos = Math.max(0, Math.min(Math.round(pos), end))
  const node = { type: 'image', attrs: { src, alt: '' } }
  ed.chain().insertContentAt(pos, node).scrollIntoView().run()
  // 只按「文档里到底多没多一张图」判断：chain.run() 会因为 scrollIntoView
  // 之类的后续命令返回 false，但其实图片已经插进去了，照那个判断会再插一张
  if (imageCount(ed) === before) {
    ed.chain().focus('end').setImage({ src, alt: '' }).run()
  }
  if (!ed.isFocused) {
    try {
      ed.commands.focus()
    } catch {
      /* 窗口没聚焦时失败无所谓，图片已经进正文了 */
    }
  }
  return imageCount(ed) > before
}

/**
 * 把光标送到链接末尾，并清掉「接下来打字要继承的 marks」。
 *
 * ProseMirror 会在光标上记一份 storedMarks；插入链接时它往往还带着 link，
 * 结果接着打的每个字都变成链接，用户只能先换行绕开。显式置空后，
 * 已有链接文字不受影响，新打的字就是普通正文。
 */
function exitLink(editor: Editor) {
  const { state, view } = editor
  const pos = Math.max(0, Math.min(state.selection.to, state.doc.content.size))
  const sel = TextSelection.near(state.doc.resolve(pos), 1)
  view.dispatch(
    state.tr
      .setSelection(sel)
      .setStoredMarks([])
      // 只动选区，不该占掉一步撤回，也不该触发保存
      .setMeta('addToHistory', false),
  )
}

export const RichEditor = forwardRef<RichEditorHandle, Props>(function RichEditor(
  { initial, onChange, onNotice, onReady, notes, currentFile, onJumpNote, jumpTo },
  ref,
) {
  const lastEmitted = useRef(initial)
  const busy = useRef(false)
  const pickerRef = useRef<HTMLInputElement | null>(null)
  const htmlPickerRef = useRef<HTMLInputElement | null>(null)
  // 编辑器只在首次创建时读取 options，用 ref 转一层，避免拿到过期的回调
  const insertRef = useRef<
    (files: FileList | File[] | null | undefined, at?: number) => Promise<void>
  >(async () => {})
  const changeRef = useRef(onChange)
  changeRef.current = onChange
  const noticeRef = useRef(onNotice)
  noticeRef.current = onNotice
  // 编辑器只在创建时读一次 options，回调一律用 ref 转一层，避免拿到过期的
  const jumpRef = useRef(onJumpNote)
  jumpRef.current = onJumpNote
  const notesRef = useRef(notes)
  notesRef.current = notes
  const [linkDialog, setLinkDialog] = useState<{ selectedText: string; hasLink: boolean } | null>(null)
  /** 上一次 HTML5 拖放的时间：Tauri 的原生拖放和它可能同时到，用它去重 */
  const lastDropAt = useRef(0)
  /** 反过来也要防：原生事件先到时，紧接着的 HTML5 drop 不能再插一份 */
  const lastNativeDropAt = useRef(0)
  /** 始终指向当前活着的编辑器：拖放的异步过程里编辑器可能被换掉，别再往旧的里插 */
  const editorRef = useRef<Editor | null>(null)
  // 正在裁剪的图片（同时记住它在文档里的位置，裁剪结果按位置写回）
  const [crop, setCrop] = useState<{ src: string; pos: number } | null>(null)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: { HTMLAttributes: { class: 'code' } },
        // 撤回步数写死在这里，和按钮上显示的「最多 N 步」保持一致
        history: { depth: HISTORY_DEPTH, newGroupDelay: 500 },
      }),
      // 笔记内链接用 jianji: 自定义 scheme。Link 默认只放行 http/mailto 等，
      // 不注册的话 setLink 会直接拒绝，renderHTML 还会把 href 清空。
      // 只额外放行 jianji: 一种，javascript: 之类仍然拦着。
      // inclusive 默认跟着 autolink 变成 true：光标停在链接末尾继续打字会把新字
      // 也吞进链接里，用户只能先换行。这里显式关掉，链接就只覆盖它自己的文字。
      Link.extend({ inclusive: false }).configure({
        openOnClick: false,
        autolink: true,
        protocols: ['jianji'],
      }),
      // 行内节点（能挂在段落里，图片可以混在文字中间）；
      // 靠 CSS 浮动实现「图片靠左/靠右，文字绕排成多行」
      ResizableImage.configure({ allowBase64: true, inline: true }),
      // 网页卡片：.html 直接嵌在正文里显示
      HtmlEmbed,
      MdEmbed,
      MdTable,
      TaskList,
      TaskItem.configure({ nested: true }),
      JumpHighlight,
      Placeholder.configure({ placeholder: '从这里开始写…' }),
    ],
    content: mdToDoc(initial),
    // 不在挂载时抢焦点：新建笔记由父组件显式 focus，
    // 否则编辑器一旦重建就会把光标从标题输入框里抢走
    autofocus: false,
    editorProps: {
      attributes: { class: 'rich-body', spellcheck: 'false' },
      /** 点链接：笔记内链接切过去，普通网址交给系统浏览器；⌥点击仍是编辑光标 */
      handleClick(_view, _pos, event) {
        const el = event.target as HTMLElement | null
        const a = el?.closest?.('a[href]') as HTMLAnchorElement | null
        if (!a) return false
        const href = a.getAttribute('href') ?? ''
        if (event.altKey) return false
        const target = parseNoteLink(href)
        if (target) {
          event.preventDefault()
          jumpRef.current?.(target.file, target.text)
          return true
        }
        if (isExternalUrl(href)) {
          event.preventDefault()
          void getStorage()
            .openUrl(href)
            .catch((err) => noticeRef.current?.(String(err)))
          return true
        }
        return false
      },
      handlePaste(_view, event) {
        const dt = event.clipboardData
        let all = Array.from(dt?.files ?? [])
        // 系统截图粘贴时，Chrome 有时只把图片放在 items 里、files 是空的。
        // 只在 files 完全没东西时补，免得复制网页图文时抢走文字粘贴。
        if (all.length === 0) {
          for (const item of Array.from(dt?.items ?? [])) {
            if (item.kind !== 'file') continue
            const f = item.getAsFile()
            if (f) all.push(f)
          }
        }
        const files = usableFiles(all)
        if (files.length === 0) {
          if (all.length) noticeRef.current?.(ONLY_TIP)
          return false
        }
        event.preventDefault()
        void insertRef.current(files)
        return true
      },
      handleDrop(view, event) {
        // 桌面端同一次拖放可能既发原生事件又发 HTML5 drop；原生那条已经插过就别再来一份
        if (Date.now() - lastNativeDropAt.current < 900) {
          event.preventDefault()
          return true
        }
        const dt = (event as DragEvent).dataTransfer
        const dropped = usableFiles(dt?.files)
        if (dropped.length === 0) {
          if (dt?.files?.length) noticeRef.current?.(ONLY_TIP)
          return false
        }
        event.preventDefault()
        lastDropAt.current = Date.now()
        // 按鼠标落点插，而不是插到上一次光标处
        const at = view.posAtCoords({
          left: (event as DragEvent).clientX,
          top: (event as DragEvent).clientY,
        })?.pos
        void insertRef.current(dropped, at)
        return true
      },
      handleDOMEvents: {
        // 拖文件进来时要先放行 dragover，否则浏览器不会发 drop
        dragover(_view, event) {
          const types = Array.from((event as DragEvent).dataTransfer?.types ?? [])
          if (!types.includes('Files')) return false
          event.preventDefault()
          return true
        },
      },
    },
    onUpdate({ editor: ed }) {
      const md = docToMd(ed.getJSON() as never)
      if (md === lastEmitted.current) return
      lastEmitted.current = md
      changeRef.current(md)
    },
  })

  const insertFiles = useCallback(
    async (files: FileList | File[] | null | undefined, at?: number) => {
      // 读文件是异步的，读完可能已经换了编辑器实例，所以最后一步再取一次
      const live = () => editorRef.current ?? editor
      if (!live() || busy.current) return
      const list = usableFiles(files)
      if (list.length === 0) {
        if (Array.from(files ?? []).length > 0) noticeRef.current?.(ONLY_TIP)
        return
      }
      busy.current = true
      try {
        // 一次拖多份时按拖进来的顺序落位：插完一份，下一份落在刚插入内容的后面
        let cursor = at
        for (const file of list) {
          const ed = live()
          if (!ed || ed.isDestroyed) return
          if (isHtmlFile(file) && !file.type.startsWith('image/')) {
            const html = await file.text()
            if (!html.trim()) {
              noticeRef.current?.(`「${file.name}」是空的，没插进来`)
              continue
            }
            await insertHtmlEmbed(ed, html, file.name, cursor)
          } else if (isMdFile(file)) {
            const md = await file.text()
            if (!md.trim()) {
              noticeRef.current?.(`「${file.name}」是空的，没插进来`)
              continue
            }
            await insertMdEmbed(ed, md, file.name, cursor)
          } else {
            const src = await fileToDataUrl(file)
            if (!insertImageAt(ed, src, cursor)) {
              noticeRef.current?.(`「${file.name}」没能插进正文`)
            }
          }
          cursor = ed.state.selection.to
        }
      } catch (e) {
        noticeRef.current?.(`插入失败：${String((e as Error)?.message ?? e)}`)
      } finally {
        busy.current = false
      }
    },
    [editor],
  )

  const pickImage = useCallback(() => pickerRef.current?.click(), [])
  const pickHtml = useCallback(() => htmlPickerRef.current?.click(), [])

  /** 工具条「笔记链接」：先记住当前选区，再让弹窗挑目标笔记和目标行 */
  const openLinkDialog = useCallback(() => {
    const ed = editorRef.current
    if (!ed) return
    const { from, to, empty } = ed.state.selection
    const selectedText = empty ? '' : ed.state.doc.textBetween(from, to, ' ')
    setLinkDialog({ selectedText, hasLink: ed.isActive('link') })
  }, [])

  const applyNoteLink = useCallback((file: string, text: string, label: string) => {
    const ed = editorRef.current
    if (!ed) return
    const href = buildNoteLink(file, text)
    const { from, to, empty } = ed.state.selection
    const marks = [{ type: 'link', attrs: { href } }]
    // 选了字就用选中的字（改过显示文字才替换），没选字就把链接文字插在光标处
    if (empty || label !== ed.state.doc.textBetween(from, to, ' ')) {
      const at = empty ? from : { from, to }
      ed.chain().focus().insertContentAt(at, { type: 'text', text: label, marks }).run()
    } else {
      ed.chain().focus().setLink({ href }).run()
    }
    // 关键：别让链接 mark 粘到光标上，否则接下来打的字全是链接
    exitLink(ed)
    setLinkDialog(null)
  }, [])

  const removeLink = useCallback(() => {
    const ed = editorRef.current
    if (!ed) return
    ed.chain().focus().unsetLink().run()
    exitLink(ed)
    setLinkDialog(null)
  }, [])

  useEffect(() => {
    insertRef.current = insertFiles
  }, [insertFiles])

  useImperativeHandle(
    ref,
    () => ({
      insertFiles,
      pickImage,
      pickHtml,
      focus: () => editor?.commands.focus('end'),
    }),
    [editor, insertFiles, pickImage, pickHtml],
  )

  useEffect(() => {
    if (editor && onReady) {
      onReady({
        insertFiles,
        pickImage,
        pickHtml,
        focus: () => editor.commands.focus('end'),
      })
    }
    // 诊断用：确认富文本编辑器真的挂载成功（排查白屏时读这条记录）
    if (editor) {
      try {
        localStorage.setItem('jianji.richReady', new Date().toISOString())
      } catch {
        /* 忽略 */
      }
    }
  }, [editor, insertFiles, pickImage, pickHtml, onReady])

  // 诊断用：把编辑器实例挂出来，自动化测试和排障时能直接读选区状态
  useEffect(() => {
    editorRef.current = editor ?? null
    if (editor) {
      ;(window as unknown as Record<string, unknown>).__ed = editor
    }
  }, [editor])

  /** 从别的笔记跳过来：按链接里记的那段文字找到目标，滚过去并闪一下 */
  useEffect(() => {
    if (!editor || !jumpTo?.text?.trim()) return
    const timer = window.setTimeout(() => {
      if (!flashJump(editor, jumpTo.text.trim())) {
        noticeRef.current?.('没找到链接指向的那段文字，可能已经改过了，先跳到这篇笔记')
      }
    }, 200)
    return () => window.clearTimeout(timer)
  }, [editor, jumpTo])

  // 桌面端：Tauri 默认走原生拖放，网页拿不到 HTML5 的 drop 事件，
  // 所以再挂一个原生监听，把拖进来的图片 / .html 路径读成 File，
  // 交给和「图片按钮 / ⌘V / 网页内拖放」共用的那条插入流程。
  useEffect(() => {
    if (!editor || !('__TAURI_INTERNALS__' in window)) return
    let dead = false
    let unlisten: (() => void) | null = null
    void (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview')
        const un = await getCurrentWebview().onDragDropEvent((ev) => {
          const p = ev.payload
          if (p.type !== 'drop') return
          // HTML5 那条已经处理过就别重复插
          if (Date.now() - lastDropAt.current < 900) return
          const paths = (p.paths ?? []).filter((x): x is string => typeof x === 'string' && !!x)
          const groups = classifyPaths(paths)
          if (!groups.pages.length && !groups.images.length && !groups.docs.length) {
            if (paths.length) noticeRef.current?.(ONLY_TIP)
            return
          }
          lastNativeDropAt.current = Date.now()
          // Tauri 给的是物理像素，posAtCoords 要 CSS 像素
          const dpr = window.devicePixelRatio || 1
          const xy = { left: p.position.x / dpr, top: p.position.y / dpr }
          void (async () => {
            const files = await pathsToFiles(paths, getStorage(), (name, e) => {
              noticeRef.current?.(`没法插「${name}」：${String((e as Error)?.message ?? e)}`)
            })
            if (files.length === 0) return
            // 读文件的这几毫秒里笔记可能被切走、编辑器被换掉，那就不往旧的里插
            const live = editorRef.current
            if (!live || live.isDestroyed) {
              noticeRef.current?.('正在切换笔记，这批文件先不插了')
              return
            }
            const at = live.view.posAtCoords(xy)?.pos
            await insertRef.current(files, at)
          })()
        })
        if (dead) un()
        else unlisten = un
      } catch {
        /* 浏览器预览模式没有这个能力 */
      }
    })()
    return () => {
      dead = true
      unlisten?.()
    }
  }, [editor])

  if (!editor) return <div className="rich-loading">正在打开…</div>

  // 选中的是图片时，顶部工具栏换成图片工具；点文字/空白自动切回来
  const sel = editor.state.selection
  const imageSelected = sel instanceof NodeSelection && sel.node.type.name === 'image' && !crop

  return (
    <div className="rich">
      {/* 吸顶横条：滚动时挡住正文，里面的工具栏看起来就一直固定在顶上 */}
      <div className="rich-tools-bar">
        {imageSelected ? (
          <ImageToolbar editor={editor} onCrop={(src, pos) => setCrop({ src, pos })} />
        ) : (
          <Toolbar
            editor={editor}
            onPickImage={() => pickerRef.current?.click()}
            onPickHtml={() => htmlPickerRef.current?.click()}
            onPickNoteLink={openLinkDialog}
          />
        )}
      </div>
      <div className="paper">
        <EditorContent editor={editor} />
      </div>
      {crop && (
        <CropModal
          src={crop.src}
          onCancel={() => setCrop(null)}
          onApply={(dataUrl) => {
            const cur = editor.state.doc.nodeAt(crop.pos)
            console.log(
              '[crop-debug] pos=',
              crop.pos,
              'node=',
              cur?.type.name,
              'oldSrcLen=',
              String(cur?.attrs.src ?? '').length,
              'newSrcLen=',
              dataUrl.length,
            )
            if (cur && cur.type.name === 'image') {
              editor.view.dispatch(
                editor.state.tr.setNodeMarkup(crop.pos, undefined, {
                  ...cur.attrs,
                  src: dataUrl,
                }),
              )
            }
            setCrop(null)
          }}
        />
      )}
      <input
        ref={pickerRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void insertFiles(e.target.files)
          e.target.value = ''
        }}
      />
      <input
        ref={htmlPickerRef}
        className="html-picker"
        type="file"
        accept=".html,.htm,.xhtml,.md,.markdown,text/html,text/markdown"
        multiple
        hidden
        onChange={(e) => {
          void insertFiles(e.target.files)
          e.target.value = ''
        }}
      />
      {linkDialog && (
        <NoteLinkDialog
          notes={notesRef.current ?? []}
          currentFile={currentFile}
          selectedText={linkDialog.selectedText}
          hasLink={linkDialog.hasLink}
          onConfirm={applyNoteLink}
          onRemove={removeLink}
          onClose={() => setLinkDialog(null)}
        />
      )}
    </div>
  )
})

function Toolbar({
  editor,
  onPickImage,
  onPickHtml,
  onPickNoteLink,
}: {
  editor: Editor
  onPickImage: () => void
  onPickHtml: () => void
  onPickNoteLink: () => void
}) {
  // useEditor 默认每个事务都会重渲染，这里读到的步数是实时的
  const undoSteps = Math.min(undoDepth(editor.state), HISTORY_DEPTH)
  const redoSteps = Math.min(redoDepth(editor.state), HISTORY_DEPTH)

  const mark = (name: string, label: string, title: string, attrs?: Record<string, unknown>) => (
    <button
      key={name}
      type="button"
      className={editor.isActive(name, attrs) ? 'on' : ''}
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const chain = editor.chain().focus()
        if (name === 'heading') chain.toggleHeading({ level: 2 }).run()
        else if (name === 'bulletList') chain.toggleBulletList().run()
        else if (name === 'taskList') chain.toggleTaskList().run()
        else if (name === 'blockquote') chain.toggleBlockquote().run()
        else if (name === 'bold') chain.toggleBold().run()
        else if (name === 'italic') chain.toggleItalic().run()
        else if (name === 'strike') chain.toggleStrike().run()
        else if (name === 'code') chain.toggleCode().run()
      }}
    >
      {label}
    </button>
  )

  return (
    <div className="rich-tools">
      <button
        type="button"
        className="t-text"
        title="普通正文"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.chain().focus().setParagraph().run()}
      >
        正文
      </button>
      {mark('heading', '标题', '标题（⌘⌥2）')}
      <span className="sep" />
      {mark('bold', 'B', '加粗（⌘B）')}
      {mark('italic', 'I', '斜体（⌘I）')}
      {mark('strike', 'S', '删除线')}
      {mark('code', '</>', '行内代码')}
      <span className="sep" />
      {mark('bulletList', '•', '圆点列表')}
      {mark('taskList', '☑', '待办清单')}
      {mark('blockquote', '❝', '引用')}
      <span className="sep" />
      <button
        type="button"
        title="插入图片（Finder 或网页里的图片可以直接拖进来，截图也可以 ⌘V 粘贴）"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onPickImage}
      >
        图片
      </button>
      <button
        type="button"
        title="插入 HTML 网页或 .md 文档（WorkBuddy 生成的文件可以直接拖进来）"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onPickHtml}
      >
        HTML·MD
      </button>
      <button
        type="button"
        title="链接到另一篇笔记的某一行（点链接就跳过去并高亮那一行）"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onPickNoteLink}
      >
        🔗 链接
      </button>
      <span className="sep" />
      <button
        type="button"
        className="hist-btn"
        title={`撤回上一步（还能撤 ${undoSteps} 步，最多 ${HISTORY_DEPTH} 步；⌘Z）`}
        aria-label="撤回"
        disabled={undoSteps === 0}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.commands.undo()}
      >
        ↶ 撤回<span className="hist-count">{undoSteps}</span>
      </button>
      <button
        type="button"
        className="hist-btn"
        title={`重做刚撤回的那步（还能重做 ${redoSteps} 步；⌘⇧Z）`}
        aria-label="重做"
        disabled={redoSteps === 0}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.commands.redo()}
      >
        ↷ 重做<span className="hist-count">{redoSteps}</span>
      </button>
    </div>
  )
}
