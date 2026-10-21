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
import { docToMd, mdToDoc } from './md-doc'
import { fileToDataUrl } from './image'
import { ImageToolbar, CropModal } from './ImageToolbar'
import { NodeSelection } from '@tiptap/pm/state'

export type RichEditorHandle = {
  insertFiles: (files: FileList | File[] | null | undefined) => Promise<void>
  /** 弹出系统选图框（顶栏「图片」按钮用） */
  pickImage: () => void
  focus: () => void
}

type Props = {
  /** 打开时的 Markdown 内容，只在挂载时读一次（切换笔记靠 key 重挂载） */
  initial: string
  onChange: (markdown: string) => void
  /** 图片按钮入口：把「选文件」交给父组件，父组件调用 ref 上的 insertFiles */
  onReady?: (handle: RichEditorHandle) => void
}

/** 选中的是图片文件就拦下来，交给 Tiptap 自己插节点 */
function imageFilesOf(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith('image/'))
}

export const RichEditor = forwardRef<RichEditorHandle, Props>(function RichEditor(
  { initial, onChange, onReady },
  ref,
) {
  const lastEmitted = useRef(initial)
  const busy = useRef(false)
  const pickerRef = useRef<HTMLInputElement | null>(null)
  // 编辑器只在首次创建时读取 options，用 ref 转一层，避免拿到过期的回调
  const insertRef = useRef<(files: FileList | File[] | null | undefined) => Promise<void>>(
    async () => {},
  )
  const changeRef = useRef(onChange)
  changeRef.current = onChange
  // 正在裁剪的图片（同时记住它在文档里的位置，裁剪结果按位置写回）
  const [crop, setCrop] = useState<{ src: string; pos: number } | null>(null)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: { HTMLAttributes: { class: 'code' } },
      }),
      Link.configure({ openOnClick: false, autolink: true }),
      // 行内节点（能挂在段落里，图片可以混在文字中间）；
      // 靠 CSS 浮动实现「图片靠左/靠右，文字绕排成多行」
      ResizableImage.configure({ allowBase64: true, inline: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: '从这里开始写…' }),
    ],
    content: mdToDoc(initial),
    autofocus: 'end',
    editorProps: {
      attributes: { class: 'rich-body', spellcheck: 'false' },
      handlePaste(_view, event) {
        const files = imageFilesOf(event.clipboardData?.files)
        if (files.length === 0) return false
        event.preventDefault()
        void insertRef.current(files)
        return true
      },
      handleDrop(_view, event) {
        const files = imageFilesOf((event as DragEvent).dataTransfer?.files)
        if (files.length === 0) return false
        event.preventDefault()
        void insertRef.current(files)
        return true
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
    async (files: FileList | File[] | null | undefined) => {
      if (!editor || busy.current) return
      const list = imageFilesOf(files as FileList)
      if (list.length === 0) return
      busy.current = true
      try {
        for (const file of list) {
          const src = await fileToDataUrl(file)
          editor.chain().focus().setImage({ src, alt: '' }).run()
        }
      } finally {
        busy.current = false
      }
    },
    [editor],
  )

  const pickImage = useCallback(() => pickerRef.current?.click(), [])

  useEffect(() => {
    insertRef.current = insertFiles
  }, [insertFiles])

  useImperativeHandle(
    ref,
    () => ({
      insertFiles,
      pickImage,
      focus: () => editor?.commands.focus('end'),
    }),
    [editor, insertFiles, pickImage],
  )

  useEffect(() => {
    if (editor && onReady) {
      onReady({ insertFiles, pickImage, focus: () => editor.commands.focus('end') })
    }
    // 诊断用：确认富文本编辑器真的挂载成功（排查白屏时读这条记录）
    if (editor) {
      try {
        localStorage.setItem('jianji.richReady', new Date().toISOString())
      } catch {
        /* 忽略 */
      }
    }
  }, [editor, insertFiles, pickImage, onReady])

  // 诊断用：把编辑器实例挂出来，自动化测试和排障时能直接读选区状态
  useEffect(() => {
    if (editor) {
      ;(window as unknown as Record<string, unknown>).__ed = editor
    }
  }, [editor])

  if (!editor) return <div className="rich-loading">正在打开…</div>

  // 选中的是图片时，顶部工具栏换成图片工具；点文字/空白自动切回来
  const sel = editor.state.selection
  const imageSelected = sel instanceof NodeSelection && sel.node.type.name === 'image' && !crop

  return (
    <div className="rich">
      {imageSelected ? (
        <ImageToolbar editor={editor} onCrop={(src, pos) => setCrop({ src, pos })} />
      ) : (
        <Toolbar editor={editor} onPickImage={() => pickerRef.current?.click()} />
      )}
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
    </div>
  )
})

function Toolbar({ editor, onPickImage }: { editor: Editor; onPickImage: () => void }) {
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
    </div>
  )
}
