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
import { isHtmlFile } from './embed'
import { getStorage } from './storage'
import { docToMd, mdToDoc } from './md-doc'
import { fileToDataUrl } from './image'
import { ImageToolbar, CropModal } from './ImageToolbar'
import { NodeSelection } from '@tiptap/pm/state'
import { undoDepth, redoDepth } from '@tiptap/pm/history'

/** 撤销/重做栈的上限；连续输入在 500ms 内算一步，避免一个字占掉一步 */
const HISTORY_DEPTH = 100

export type RichEditorHandle = {
  insertFiles: (files: FileList | File[] | null | undefined) => Promise<void>
  /** 弹出系统选图框（顶栏「图片」按钮用） */
  pickImage: () => void
  /** 弹出系统选框，挑 .html 网页（顶栏「HTML」按钮用） */
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
}

/** 能插进正文的文件：图片和 .html 网页 */
function usableFiles(list: FileList | File[] | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith('image/') || isHtmlFile(f))
}

const ONLY_TIP = '只认图片和 .html 网页文件，其它类型没插进来'

export const RichEditor = forwardRef<RichEditorHandle, Props>(function RichEditor(
  { initial, onChange, onNotice, onReady },
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
  /** 上一次 HTML5 拖放的时间：Tauri 的原生拖放和它可能同时到，用它去重 */
  const lastDropAt = useRef(0)
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
      Link.configure({ openOnClick: false, autolink: true }),
      // 行内节点（能挂在段落里，图片可以混在文字中间）；
      // 靠 CSS 浮动实现「图片靠左/靠右，文字绕排成多行」
      ResizableImage.configure({ allowBase64: true, inline: true }),
      // 网页卡片：.html 直接嵌在正文里显示
      HtmlEmbed,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: '从这里开始写…' }),
    ],
    content: mdToDoc(initial),
    // 不在挂载时抢焦点：新建笔记由父组件显式 focus，
    // 否则编辑器一旦重建就会把光标从标题输入框里抢走
    autofocus: false,
    editorProps: {
      attributes: { class: 'rich-body', spellcheck: 'false' },
      handlePaste(_view, event) {
        const all = event.clipboardData?.files
        const files = usableFiles(all)
        if (files.length === 0) {
          if (all?.length) noticeRef.current?.(ONLY_TIP)
          return false
        }
        event.preventDefault()
        void insertRef.current(files)
        return true
      },
      handleDrop(view, event) {
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
        for (const file of list) {
          const ed = live()
          if (!ed || ed.isDestroyed) return
          if (isHtmlFile(file) && !file.type.startsWith('image/')) {
            const html = await file.text()
            if (!html.trim()) {
              noticeRef.current?.(`「${file.name}」是空的，没插进来`)
              continue
            }
            await insertHtmlEmbed(ed, html, file.name, at)
          } else {
            const src = await fileToDataUrl(file)
            ed.chain().focus().setImage({ src, alt: '' }).run()
          }
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

  // 桌面端：Tauri 默认走原生拖放，网页拿不到 HTML5 的 drop 事件，
  // 所以再挂一个原生监听，把拖进来的 .html 读出来插成卡片。
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
          const pages = (p.paths ?? []).filter((path) => /\.(html?|xhtml)$/i.test(path))
          if (pages.length === 0) return
          const dpr = window.devicePixelRatio || 1
          const at = editor.view.posAtCoords({
            left: p.position.x / dpr,
            top: p.position.y / dpr,
          })?.pos
          void (async () => {
            for (const path of pages) {
              const name = path.split(/[\\/]/).pop() || '网页'
              try {
                const html = await getStorage().readDroppedFile(path)
                // 读文件的这几毫秒里笔记可能被切走、编辑器被换掉，那就不往旧的里插
                const live = editorRef.current
                if (!live || live.isDestroyed) {
                  noticeRef.current?.('正在切换笔记，这张网页先不插了')
                  continue
                }
                await insertHtmlEmbed(live, html, name, at)
              } catch (e) {
                noticeRef.current?.(`没法插「${name}」：${String((e as Error)?.message ?? e)}`)
              }
            }
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
        accept=".html,.htm,.xhtml,text/html"
        multiple
        hidden
        onChange={(e) => {
          void insertFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
})

function Toolbar({
  editor,
  onPickImage,
  onPickHtml,
}: {
  editor: Editor
  onPickImage: () => void
  onPickHtml: () => void
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
        title="插入图片（也可以直接 ⌘V 粘贴或拖进来）"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onPickImage}
      >
        图片
      </button>
      <button
        type="button"
        title="插入 HTML 网页（WorkBuddy 生成的页面可以直接拖进来）"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onPickHtml}
      >
        HTML
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
