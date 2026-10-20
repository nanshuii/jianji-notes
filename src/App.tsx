import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getStorage, isDesktop } from './storage'
import {
  type Note,
  type NoteType,
  formatDate,
  listProgress,
  parseNote,
  serializeNote,
  snippet,
  toFileName,
  wordCount,
} from './types'
import { mdToHtml, renderInline } from './markdown'

const WELCOME_TITLE = '欢迎使用简记'
const WELCOME_BODY = `欢迎。这是一个完全本地运行的笔记应用，数据都在你自己的电脑里。

## 怎么用

- 左边栏是全部笔记，点左上角可以新建
- 笔记用 Markdown 写，点「预览」看渲染效果
- 清单里的 \`- [ ]\` 会变成可勾选的事项

## 关于文件

每篇笔记对应一个 \`.md\` 文件，标题就是文件名。你可以用任何编辑器打开，也可以直接把整个文件夹丢进 Git 或网盘备份。

> 没有账号，没有云端，断网也能用。
`

const WELCOME_LIST_TITLE = '今日清单'
const WELCOME_LIST_BODY = `- [x] 装好简记
- [ ] 点一下左边的圆圈试试
- [ ] 新建一篇自己的笔记
`

function byUpdated(a: Note, b: Note): number {
  return Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt
}

export default function App() {
  const storage = useMemo(() => getStorage(), [])
  const [notes, setNotes] = useState<Note[]>([])
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [preview, setPreview] = useState(false)
  const [ready, setReady] = useState(false)
  const [location, setLocation] = useState('')
  const [error, setError] = useState('')
  const [savedAt, setSavedAt] = useState(0)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const notesRef = useRef<Note[]>([])
  const lastSaved = useRef<Map<string, string>>(new Map())
  const timer = useRef<number | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  notesRef.current = notes

  /* ---------------- 首次加载 ---------------- */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [raws, dir] = await Promise.all([storage.loadAll(), storage.describe()])
        let loaded = raws.map((r) => parseNote(r.file, r.content))

        if (loaded.length === 0) {
          const now = Date.now()
          const seeds: Note[] = [
            {
              file: toFileName(WELCOME_LIST_TITLE),
              title: WELCOME_LIST_TITLE,
              type: 'list',
              body: WELCOME_LIST_BODY,
              createdAt: now,
              updatedAt: now,
              pinned: false,
            },
            {
              file: toFileName(WELCOME_TITLE),
              title: WELCOME_TITLE,
              type: 'note',
              body: WELCOME_BODY,
              createdAt: now - 1000,
              updatedAt: now - 1000,
              pinned: false,
            },
          ]
          for (const s of seeds) {
            await storage.save(s.file, serializeNote(s))
          }
          loaded = seeds
        }

        for (const n of loaded) {
          lastSaved.current.set(n.file, serializeNote(n))
        }

        loaded.sort(byUpdated)
        if (cancelled) return
        setNotes(loaded)
        setActiveFile(loaded[0]?.file ?? null)
        setLocation(dir)
      } catch (e) {
        if (!cancelled) setError(String(e))
      } finally {
        if (!cancelled) setReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [storage])

  /* ---------------- 持久化 ---------------- */
  const persist = useCallback(
    async (note: Note) => {
      const content = serializeNote(note)
      if (lastSaved.current.get(note.file) === content) return

      const taken = new Set(
        notesRef.current.filter((n) => n.file !== note.file).map((n) => n.file),
      )
      let desired = toFileName(note.title)
      if (desired !== note.file) {
        const base = desired.replace(/\.md$/, '')
        let n = 2
        while (taken.has(desired)) {
          desired = `${base} ${n}.md`
          n += 1
        }
      }

      try {
        if (desired !== note.file) {
          await storage.save(desired, content)
          await storage.remove(note.file)
          lastSaved.current.delete(note.file)
          lastSaved.current.set(desired, content)
          setNotes((prev) =>
            prev.map((n) => (n.file === note.file ? { ...n, file: desired } : n)),
          )
          setActiveFile((f) => (f === note.file ? desired : f))
        } else {
          await storage.save(note.file, content)
          lastSaved.current.set(note.file, content)
        }
        setSavedAt(Date.now())
      } catch (e) {
        setError(String(e))
      }
    },
    [storage],
  )

  useEffect(() => {
    if (!ready || !activeFile) return
    const note = notes.find((n) => n.file === activeFile)
    if (!note) return
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void persist(note), 500)
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [notes, activeFile, ready, persist])

  /* ---------------- 操作 ---------------- */
  const patch = useCallback(
    (fields: Partial<Note>) => {
      setNotes((prev) =>
        prev.map((n) =>
          n.file === activeFile ? { ...n, ...fields, updatedAt: Date.now() } : n,
        ),
      )
    },
    [activeFile],
  )

  const createNote = useCallback(
    async (type: NoteType) => {
      const now = Date.now()
      const base = type === 'list' ? '新的清单' : '新的笔记'
      const taken = new Set(notesRef.current.map((n) => n.file))
      let file = toFileName(base)
      let i = 2
      while (taken.has(file)) {
        file = `${base} ${i}.md`
        i += 1
      }
      const note: Note = {
        file,
        title: base,
        type,
        body: type === 'list' ? '- [ ] ' : '',
        createdAt: now,
        updatedAt: now,
        pinned: false,
      }
      try {
        await storage.save(file, serializeNote(note))
        lastSaved.current.set(file, serializeNote(note))
      } catch (e) {
        setError(String(e))
      }
      setNotes((prev) => [note, ...prev])
      setActiveFile(file)
      setPreview(false)
      setQuery('')
      window.setTimeout(() => {
        const el = document.querySelector<HTMLTextAreaElement>('textarea.editor')
        el?.focus()
      }, 50)
    },
    [storage],
  )

  const removeNote = useCallback(
    async (file: string) => {
      try {
        await storage.remove(file)
      } catch (e) {
        setError(String(e))
      }
      lastSaved.current.delete(file)
      const rest = notesRef.current.filter((n) => n.file !== file)
      setNotes(rest)
      setActiveFile(rest[0]?.file ?? null)
      setPendingDelete(null)
    },
    [storage],
  )

  const togglePin = useCallback(() => {
    const note = notesRef.current.find((n) => n.file === activeFile)
    if (note) patch({ pinned: !note.pinned })
  }, [activeFile, patch])

  /* ---------------- 快捷键 ---------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      if (!meta) return
      const key = e.key.toLowerCase()
      if (key === 'n') {
        e.preventDefault()
        void createNote('note')
      } else if (key === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (key === 's') {
        e.preventDefault()
        const note = notesRef.current.find((n) => n.file === activeFile)
        if (note) void persist(note)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeFile, createNote, persist])

  /* ---------------- 派生数据 ---------------- */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = q
      ? notes.filter(
          (n) =>
            n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q),
        )
      : notes
    return [...base].sort(byUpdated)
  }, [notes, query])

  const active = notes.find((n) => n.file === activeFile) ?? null
  const progress = active && active.type === 'list' ? listProgress(active.body) : null

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">简</span>
          <div className="brand-text">
            <strong>简记</strong>
            <small>{notes.length} 篇</small>
          </div>
        </div>

        <div className="new-buttons">
          <button onClick={() => void createNote('note')} title="⌘N">
            <span className="plus">＋</span> 笔记
          </button>
          <button onClick={() => void createNote('list')}>
            <span className="plus">＋</span> 清单
          </button>
        </div>

        <div className="search-wrap">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            ref={searchRef}
            value={query}
            placeholder="搜索"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="note-list">
          {filtered.length === 0 && (
            <div className="list-empty">{query ? '没有匹配的内容' : '还没有笔记'}</div>
          )}
          {filtered.map((n) => {
            const p = n.type === 'list' ? listProgress(n.body) : null
            return (
              <button
                key={n.file}
                className={`note-item${n.file === activeFile ? ' active' : ''}`}
                onClick={() => {
                  setActiveFile(n.file)
                  setPreview(false)
                }}
              >
                <div className="note-item-top">
                  <span className={`dot ${n.type}`} />
                  <span className="note-title">{n.title || '未命名'}</span>
                  {n.pinned && <span className="pin">·</span>}
                  <span className="note-time">{formatDate(n.updatedAt)}</span>
                </div>
                <div className="note-sub">
                  {p && p.total > 0 ? `${p.done}/${p.total} 项完成` : snippet(n.body) || '空白'}
                </div>
              </button>
            )
          })}
        </div>

        <footer className="sidebar-foot" title={location}>
          {isDesktop ? location : '预览模式 · 数据存在浏览器'}
        </footer>
      </aside>

      <main className="main">
        {!active ? (
          <div className="empty">
            <div className="empty-logo">简</div>
            <h2>开始记录</h2>
            <p>从左边新建一篇笔记，或者写一份今天的清单。</p>
          </div>
        ) : (
          <>
            <header className="editor-head">
              <input
                className="title-input"
                value={active.title}
                placeholder="标题"
                onChange={(e) => patch({ title: e.target.value })}
              />
              <div className="head-row">
                <div className="meta">
                  <span>{formatDate(active.updatedAt)}</span>
                  <span>{wordCount(active.body)} 字</span>
                  {progress && progress.total > 0 && (
                    <span>
                      {progress.done}/{progress.total} 项
                    </span>
                  )}
                  <span className="saved">
                    {savedAt > 0 && Math.abs(savedAt - active.updatedAt) < 1500
                      ? '已保存'
                      : ''}
                  </span>
                </div>
                <div className="tools">
                  <button
                    className={active.pinned ? 'on' : ''}
                    onClick={togglePin}
                    title="置顶"
                  >
                    置顶
                  </button>
                  <button
                    onClick={() =>
                      patch({ type: active.type === 'list' ? 'note' : 'list' })
                    }
                    title="切换类型"
                  >
                    {active.type === 'list' ? '清单' : '笔记'}
                  </button>
                  <button className={preview ? 'on' : ''} onClick={() => setPreview((v) => !v)}>
                    {preview ? '编辑' : '预览'}
                  </button>
                  <button className="danger" onClick={() => setPendingDelete(active.file)}>
                    删除
                  </button>
                </div>
              </div>
            </header>

            <section className="editor-body">
              {preview ? (
                <div
                  className="markdown"
                  dangerouslySetInnerHTML={{ __html: mdToHtml(active.body) }}
                />
              ) : active.type === 'list' ? (
                <ListView note={active} onChange={(body) => patch({ body })} />
              ) : (
                <textarea
                  className="editor"
                  value={active.body}
                  placeholder="从这里开始写…&#10;&#10;支持 Markdown：## 标题、- 列表、- [ ] 待办、**粗体**、`代码`"
                  onChange={(e) => patch({ body: e.target.value })}
                  spellCheck={false}
                />
              )}
            </section>
          </>
        )}

        {error && (
          <div className="error-bar" onClick={() => setError('')}>
            存储出错：{error}
          </div>
        )}
      </main>

      {pendingDelete && (
        <div className="modal-mask" onClick={() => setPendingDelete(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>删除这篇？</h3>
            <p>文件会从磁盘移除，无法撤销。</p>
            <div className="modal-actions">
              <button onClick={() => setPendingDelete(null)}>取消</button>
              <button className="danger" onClick={() => void removeNote(pendingDelete)}>
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------------- 清单视图 ---------------- */

function ListView({ note, onChange }: { note: Note; onChange: (body: string) => void }) {
  const [draft, setDraft] = useState('')
  const lines = note.body.split('\n')
  const { done, total } = listProgress(note.body)

  const setLine = (idx: number, value: string) => {
    const next = [...lines]
    next[idx] = value
    onChange(next.join('\n'))
  }

  const toggle = (idx: number) => {
    const m = /^(\s*)- \[( |x|X)\]\s?/.exec(lines[idx])
    if (!m) return
    const mark = m[2].toLowerCase() === 'x' ? ' ' : 'x'
    setLine(idx, `${m[1]}- [${mark}] ${lines[idx].slice(m[0].length)}`)
  }

  const editText = (idx: number, text: string) => {
    const m = /^(\s*)- \[( |x|X)\]\s?/.exec(lines[idx])
    if (!m) return
    setLine(idx, `${m[1]}- [${m[2]}] ${text}`)
  }

  const add = () => {
    const t = draft.trim()
    if (!t) return
    const body = note.body.replace(/\n+$/, '')
    onChange(`${body}${body ? '\n' : ''}- [ ] ${t}`)
    setDraft('')
  }

  const removeAt = (idx: number) => {
    onChange(lines.filter((_, j) => j !== idx).join('\n'))
  }

  return (
    <div className="list-view">
      {total > 0 && (
        <div className="progress">
          <div className="bar">
            <i style={{ width: `${Math.round((done / total) * 100)}%` }} />
          </div>
          <span>
            {done}/{total}
          </span>
        </div>
      )}

      {lines.map((line, idx) => {
        const m = /^(\s*)- \[( |x|X)\]\s?(.*)$/.exec(line)
        if (m) {
          const checked = m[2].toLowerCase() === 'x'
          return (
            <div className={`todo-row${checked ? ' done' : ''}`} key={idx}>
              <button className="check" onClick={() => toggle(idx)} aria-label="切换完成">
                {checked ? '✓' : ''}
              </button>
              <input
                value={m[3]}
                onChange={(e) => editText(idx, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    const next = [...lines]
                    next.splice(idx + 1, 0, '- [ ] ')
                    onChange(next.join('\n'))
                  }
                }}
              />
              <button className="row-del" onClick={() => removeAt(idx)} title="删除">
                ×
              </button>
            </div>
          )
        }
        if (line.trim() === '') return null
        return (
          <div
            className="list-text"
            key={idx}
            dangerouslySetInnerHTML={{ __html: renderInline(line) }}
          />
        )
      })}

      <div className="todo-row add-row">
        <span className="check ghost">＋</span>
        <input
          value={draft}
          placeholder="添加一项，回车确认"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
      </div>
    </div>
  )
}
