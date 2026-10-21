import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getStorage, isDesktop } from './storage'
import {
  type Note,
  baseName,
  formatDate,
  listProgress,
  notePath,
  parseNote,
  serializeNote,
  snippet,
  stampTitle,
  toFileName,
  wordCount,
} from './types'
import { RichEditor, type RichEditorHandle } from './RichEditor'
import MANUAL_BODY from './manual.md?raw'

const MANUAL_TITLE = '简记操作手册'

const WELCOME_TITLE = '欢迎使用简记'
const WELCOME_BODY = `欢迎。这是一个完全本地运行的笔记应用，数据都在你自己的电脑里。

## 三步上手

- 最左边一栏是**笔记本**，用来把相关的笔记归到一起
- 中间是当前笔记本里的笔记，点「＋ 新建笔记」开始写
- 右边直接写，停手半秒自动保存

## 笔记里也能记待办

不用另外建「清单」：想记待办就点工具条上的 ☑，或者在行首敲 \`- [ ] \`，
勾掉就完成，正文照样能写别的。

- [x] 装好简记
- [ ] 点一下左边的圆圈试试
- [ ] 建一个自己的笔记本
- [ ] 写一篇图文混排的笔记

想了解全部功能，看同一个文件夹里的《简记操作手册》。

> 没有账号，没有云端，断网也能用。
`

/** 记录「已经初始化过」，避免用户删光笔记后又被塞回一堆示例 */
const INITED_KEY = 'jianji.inited.v1'

function markInited() {
  try {
    localStorage.setItem(INITED_KEY, '1')
  } catch {
    /* 隐私模式等场景下写不进去，忽略 */
  }
}

function wasInited(): boolean {
  try {
    return localStorage.getItem(INITED_KEY) === '1'
  } catch {
    return false
  }
}

function byUpdated(a: Note, b: Note): number {
  return Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt
}

/** 全部视图用 null，未分类用空串 */
type Scope = string | null

/** 列表项 / 编辑器头部要显示的派生信息，按正文缓存 */
type NoteStat = { sub: string; done: number; total: number; words: number }

export default function App() {
  const storage = useMemo(() => getStorage(), [])
  const [notes, setNotes] = useState<Note[]>([])
  const [notebooks, setNotebooks] = useState<string[]>([])
  const [scope, setScope] = useState<Scope>(null)
  const [activeFile, setActiveFile] = useState<string | null>(null)
  /** 编辑器实例的 key：只在真正换一篇笔记时 +1，文件名变了也不重挂载 */
  const [docSeq, setDocSeq] = useState(0)
  const [query, setQuery] = useState('')
  const [ready, setReady] = useState(false)
  const [location, setLocation] = useState('')
  const [error, setError] = useState('')
  const [savedAt, setSavedAt] = useState(0)
  const [railOpen, setRailOpen] = useState(true)

  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [pendingNbDelete, setPendingNbDelete] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<{
    mode: 'new' | 'rename'
    value: string
    target?: string
  } | null>(null)

  const notesRef = useRef<Note[]>([])
  const lastSaved = useRef<Map<string, string>>(new Map())
  const timer = useRef<number | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const richRef = useRef<RichEditorHandle | null>(null)
  const activeFileRef = useRef<string | null>(null)
  /**
   * 正文摘要是按全量字符串算的（长笔记里塞了图，一次要扫几百 KB），
   * 每敲一个字都重算就会卡。按 body 内容做缓存，内容不变就直接复用。
   */
  const statCache = useRef<Map<string, NoteStat>>(new Map())

  notesRef.current = notes
  activeFileRef.current = activeFile

  /* ---------------- 首次加载 ---------------- */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [raws, dir, nbs] = await Promise.all([
          storage.loadAll(),
          storage.describe(),
          storage.listNotebooks(),
        ])
        let loaded = raws.map((r) => parseNote(r.file, r.content))

        // 只在真正的第一次启动时铺初始内容；删光笔记之后再打开不会被重新塞满
        if (loaded.length === 0 && !wasInited()) {
          const now = Date.now()
          const seeds: Note[] = [
            {
              file: toFileName(MANUAL_TITLE),
              notebook: '',
              title: MANUAL_TITLE,
              body: MANUAL_BODY,
              createdAt: now,
              updatedAt: now,
              pinned: false,
            },
            {
              file: toFileName(WELCOME_TITLE),
              notebook: '',
              title: WELCOME_TITLE,
              body: WELCOME_BODY,
              createdAt: now - 2000,
              updatedAt: now - 2000,
              pinned: false,
            },
          ]
          for (const s of seeds) {
            await storage.save(s.file, serializeNote(s))
          }
          loaded = seeds
        }
        markInited()

        for (const n of loaded) {
          lastSaved.current.set(n.file, serializeNote(n))
        }

        loaded.sort(byUpdated)
        if (cancelled) return
        setNotes(loaded)
        setNotebooks(nbs)
        setActiveFile(loaded[0]?.file ?? null)
        setDocSeq((v) => v + 1)
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
  /**
   * 保存一篇笔记。
   * renameByTitle=false（自动保存）时只写回当前文件，不按标题改名 ——
   * 否则边打标题边改名会让编辑器跟着换 key 重挂载，光标被抢走、滚动跳回顶部。
   * 真正的改名由 commitTitle（标题失焦 / ⌘S / 切换笔记）触发一次。
   */
  const persist = useCallback(
    async (note: Note, renameByTitle = false) => {
      const content = serializeNote(note)

      const taken = new Set(
        notesRef.current.filter((n) => n.file !== note.file).map((n) => n.file),
      )
      const wanted = renameByTitle ? toFileName(note.title) : baseName(note.file)
      let name = wanted
      let i = 2
      while (name !== baseName(note.file) && taken.has(notePath(note.notebook, name))) {
        name = `${wanted.replace(/\.md$/i, '')} ${i}.md`
        i += 1
      }
      const desired = notePath(note.notebook, name)

      // 路径没变、内容也没变，才真的什么都不用做
      if (desired === note.file && lastSaved.current.get(note.file) === content) return

      try {
        if (desired !== note.file) {
          // 改名或换笔记本：写新文件、删旧文件
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

  /** 标题改完了：这时候才把文件改成和标题同名 */
  const commitTitle = useCallback(() => {
    const note = notesRef.current.find((n) => n.file === activeFileRef.current)
    if (!note) return
    if (toFileName(note.title) === baseName(note.file)) return
    void persist(note, true)
  }, [persist])

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

  // 切走窗口/关窗前把没落盘的改动（含标题改名）冲一次
  useEffect(() => {
    const flush = () => {
      const note = notesRef.current.find((n) => n.file === activeFileRef.current)
      if (note) void persist(note, true)
    }
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('beforeunload', flush)
    window.addEventListener('blur', flush)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener('blur', flush)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [persist])

  /* ---------------- 笔记操作 ---------------- */
  /** 切换打开的笔记：先把上一篇存了，再换 key 重挂载编辑器 */
  const openNote = useCallback(
    (file: string | null) => {
      const prev = notesRef.current.find((n) => n.file === activeFileRef.current)
      if (prev && prev.file !== file) {
        if (timer.current) window.clearTimeout(timer.current)
        timer.current = null
        void persist(prev, true) // 切走前顺手把改过的标题落成文件名
      }
      setActiveFile(file)
      setDocSeq((v) => v + 1)
    },
    [persist],
  )

  const statsOf = useCallback((body: string): NoteStat => {
    const cache = statCache.current
    const hit = cache.get(body)
    if (hit) return hit
    const p = listProgress(body)
    const stat: NoteStat = {
      sub: snippet(body),
      done: p.done,
      total: p.total,
      words: wordCount(body),
    }
    if (cache.size > 400) cache.clear() // 防止反复编辑时无限堆积
    cache.set(body, stat)
    return stat
  }, [])

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
    async () => {
      const nb = scope ?? ''
      const now = Date.now()
      // 默认标题就是当前时间（年月日时分秒），撞名了加序号
      const base = stampTitle(now)
      const taken = new Set(notesRef.current.map((n) => n.file))
      let name = toFileName(base)
      let i = 2
      while (taken.has(notePath(nb, name))) {
        name = `${base} ${i}.md`
        i += 1
      }
      const file = notePath(nb, name)
      const note: Note = {
        file,
        notebook: nb,
        title: base,
        body: '',
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
      openNote(file)
      // 在「全部」里新建会落到未分类，把视图跟过去，免得找不到
      if (scope === null) setScope('')
      setQuery('')
      window.setTimeout(() => richRef.current?.focus(), 60)
    },
    [storage, scope, openNote],
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
      setDocSeq((v) => v + 1)
      setPendingDelete(null)
    },
    [storage],
  )

  const togglePin = useCallback(() => {
    const note = notesRef.current.find((n) => n.file === activeFile)
    if (note) patch({ pinned: !note.pinned })
  }, [activeFile, patch])

  /* ---------------- 笔记本操作 ---------------- */
  const applyNotebookRename = useCallback(
    (from: string, to: string) => {
      setNotes((prev) => {
        const next = prev.map((n) =>
          n.notebook === from
            ? { ...n, notebook: to, file: notePath(to, baseName(n.file)) }
            : n,
        )
        // 路径全变了，重建「已保存内容」索引，否则会被判定成新内容再写一遍
        lastSaved.current.clear()
        for (const n of next) lastSaved.current.set(n.file, serializeNote(n))
        return next
      })
      // 当前打开的笔记在被重命名的笔记本里，选中项要跟着换路径
      setActiveFile((f) => {
        if (!f) return f
        const note = notesRef.current.find((n) => n.file === f)
        return note && note.notebook === from ? notePath(to, baseName(f)) : f
      })
      setNotebooks((prev) => prev.map((n) => (n === from ? to : n)).sort())
      setScope((s) => (s === from ? to : s))
    },
    [],
  )

  const submitPrompt = useCallback(
    async (value: string) => {
      const name = value.trim()
      if (!name || !prompt) return
      try {
        if (prompt.mode === 'new') {
          await storage.createNotebook(name)
          setNotebooks((prev) => [...new Set([...prev, name])].sort())
          setScope(name)
        } else if (prompt.mode === 'rename' && prompt.target) {
          const from = prompt.target
          if (from === name) {
            setPrompt(null)
            return
          }
          await storage.renameNotebook(from, name)
          applyNotebookRename(from, name)
        }
        setPrompt(null)
      } catch (e) {
        setError(String(e))
        setPrompt(null)
      }
    },
    [prompt, storage, applyNotebookRename],
  )

  const deleteNotebook = useCallback(
    async (name: string) => {
      try {
        await storage.removeNotebook(name)
        setNotebooks((prev) => prev.filter((n) => n !== name))
        setScope((s) => (s === name ? null : s))
      } catch (e) {
        setError(String(e))
      }
      setPendingNbDelete(null)
    },
    [storage],
  )

  /* ---------------- 快捷键 ---------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      if (!meta) return
      const key = e.key.toLowerCase()
      if (key === 'n') {
        e.preventDefault()
        void createNote()
      } else if (key === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (key === 's') {
        e.preventDefault()
        const note = notesRef.current.find((n) => n.file === activeFile)
        if (note) void persist(note, true)
      } else if (key === '\\') {
        e.preventDefault()
        setRailOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeFile, createNote, persist])

  /* ---------------- 派生数据 ---------------- */
  const counts = useMemo(() => {
    const map = new Map<string, number>()
    let uncategorized = 0
    for (const n of notes) {
      if (n.notebook) map.set(n.notebook, (map.get(n.notebook) ?? 0) + 1)
      else uncategorized += 1
    }
    return { map, uncategorized }
  }, [notes])

  // 搜索时跨全部笔记本，否则只看当前范围
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q) {
      const hits = notes.filter(
        (n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q),
      )
      return [...hits].sort(byUpdated)
    }
    const base =
      scope === null
        ? notes
        : scope === ''
          ? notes.filter((n) => !n.notebook)
          : notes.filter((n) => n.notebook === scope)
    return [...base].sort(byUpdated)
  }, [notes, query, scope])

  const active = notes.find((n) => n.file === activeFile) ?? null
  // 任何一篇正文里有 `- [ ]` 就算有待办，不再是「清单」这种类型专属
  const activeStat = active ? statsOf(active.body) : null

  const scopeLabel =
    query.trim() ? '搜索结果' : scope === null ? '全部笔记' : scope === '' ? '未分类' : scope

  const canDeleteNotebook = scope !== null && scope !== ''

  return (
    <div className="app">
      {/* ---------- 第一栏：笔记本 ---------- */}
      <nav className={`rail${railOpen ? '' : ' closed'}`}>
        <div className="rail-top">
          <span className="logo">简</span>
          {railOpen && <strong>简记</strong>}
        </div>

        <button
          className="rail-toggle"
          onClick={() => setRailOpen((v) => !v)}
          title={railOpen ? '收起笔记本栏（⌘\\）' : '展开笔记本栏（⌘\\）'}
        >
          {railOpen ? '‹' : '›'}
        </button>

        <div className="rail-group">
          <button
            className={`rail-item${scope === null && !query ? ' active' : ''}`}
            onClick={() => {
              setScope(null)
              setQuery('')
            }}
            title="全部笔记"
          >
            <span className="rail-ico">▤</span>
            {railOpen && (
              <>
                <span className="rail-name">全部笔记</span>
                <b className="rail-count">{notes.length}</b>
              </>
            )}
          </button>

          <button
            className={`rail-item${scope === '' && !query ? ' active' : ''}`}
            onClick={() => {
              setScope('')
              setQuery('')
            }}
            title="未分类"
          >
            <span className="rail-ico">▢</span>
            {railOpen && (
              <>
                <span className="rail-name">未分类</span>
                <b className="rail-count">{counts.uncategorized}</b>
              </>
            )}
          </button>
        </div>

        {railOpen && <div className="rail-label">笔记本</div>}

        <div className="rail-group rail-scroll">
          {notebooks.length === 0 && railOpen && (
            <div className="rail-empty">还没有笔记本</div>
          )}
          {notebooks.map((nb) => (
            <div
              key={nb}
              className={`rail-item nb${scope === nb && !query ? ' active' : ''}`}
            >
              <button
                className="rail-main"
                onClick={() => {
                  setScope(nb)
                  setQuery('')
                }}
                title={nb}
              >
                <span className="rail-ico">▸</span>
                {railOpen && (
                  <>
                    <span className="rail-name">{nb}</span>
                    <b className="rail-count">{counts.map.get(nb) ?? 0}</b>
                  </>
                )}
              </button>
              {railOpen && (
                <span className="rail-acts">
                  <button
                    onClick={() => setPrompt({ mode: 'rename', value: nb, target: nb })}
                    title="重命名"
                  >
                    ✎
                  </button>
                  <button onClick={() => setPendingNbDelete(nb)} title="删除">
                    ×
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>

        <button
          className="rail-add"
          onClick={() => setPrompt({ mode: 'new', value: '' })}
          title="新建笔记本"
        >
          <span className="plus">＋</span>
          {railOpen && '新建笔记本'}
        </button>

        {railOpen && (
          <footer className="rail-foot" title={location}>
            {isDesktop ? location.replace(/^.*\//, '') : '浏览器预览'}
          </footer>
        )}
      </nav>

      {/* ---------- 第二栏：笔记列表 ---------- */}
      <aside className="sidebar">
        <div className="list-head">
          <span className="list-scope" title={scopeLabel}>
            {scopeLabel}
          </span>
          {canDeleteNotebook && (
            <button
              className="scope-del"
              onClick={() => setPendingNbDelete(scope)}
              title="删除当前笔记本"
            >
              删除
            </button>
          )}
        </div>

        <div className="search-wrap">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            ref={searchRef}
            value={query}
            placeholder="搜索全部笔记"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="new-buttons">
          <button onClick={() => void createNote()} title="⌘N">
            <span className="plus">＋</span> 新建笔记
          </button>
        </div>

        <div className="note-list">
          {filtered.length === 0 && (
            <div className="list-empty">
              {query ? '没有匹配的内容' : scope === '' ? '未分类里还没有笔记' : '这个笔记本还是空的'}
            </div>
          )}
          {filtered.map((n) => {
            // 有待办的笔记显示完成数，剩下的照常显示摘要（都走缓存，不每次重算）
            const st = statsOf(n.body)
            return (
              <button
                key={n.file}
                className={`note-item${n.file === activeFile ? ' active' : ''}`}
                onClick={() => openNote(n.file)}
              >
                <div className="note-item-top">
                  <span className={`dot${st.total > 0 && st.done < st.total ? ' open' : ''}`} />
                  <span className="note-title">{n.title || '未命名'}</span>
                  {n.pinned && <span className="pin">·</span>}
                  <span className="note-time">{formatDate(n.updatedAt)}</span>
                </div>
                <div className="note-sub">
                  {st.total > 0 && (
                    <span className="note-prog">
                      {st.done}/{st.total}
                    </span>
                  )}
                  {st.total > 0 && st.sub ? ' · ' : ''}
                  {st.sub || (st.total > 0 ? '' : '空白')}
                </div>
                {query.trim() && (
                  <div className="note-nb">{n.notebook || '未分类'}</div>
                )}
              </button>
            )
          })}
        </div>

        {!isDesktop && <footer className="sidebar-foot">数据存在浏览器 · 预览模式</footer>}
      </aside>

      {/* ---------- 第三栏：编辑器 ---------- */}
      <main className="main">
        {!active ? (
          <div className="empty">
            <div className="empty-logo">简</div>
            <h2>开始记录</h2>
            <p>从左边新建一篇笔记；想记待办，就在正文里点一下 ☑。</p>
          </div>
        ) : (
          <>
            <header className="editor-head">
              <input
                className="title-input"
                value={active.title}
                placeholder="标题"
                onChange={(e) => patch({ title: e.target.value })}
                // 改名放在失焦时做一次，边打边改文件名会把编辑器重挂载、光标被抢走
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    e.currentTarget.blur()
                  }
                }}
              />
              <div className="head-row">
                <div className="meta">
                  <select
                    className="nb-select"
                    value={active.notebook}
                    onChange={(e) => patch({ notebook: e.target.value })}
                    title="所属笔记本"
                  >
                    <option value="">未分类</option>
                    {notebooks.map((nb) => (
                      <option key={nb} value={nb}>
                        {nb}
                      </option>
                    ))}
                  </select>
                  <span>{formatDate(active.updatedAt)}</span>
                  <span>{activeStat?.words ?? 0} 字</span>
                  {activeStat && activeStat.total > 0 && (
                    <span>
                      待办 {activeStat.done}/{activeStat.total}
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
                  <button className="danger" onClick={() => setPendingDelete(active.file)}>
                    删除
                  </button>
                </div>
              </div>
            </header>

            <section className="editor-body">
              <RichEditor
                key={docSeq}
                ref={richRef}
                initial={active.body}
                onChange={(body) => patch({ body })}
              />
            </section>
          </>
        )}

        {error && (
          <div className="error-bar" onClick={() => setError('')}>
            出错了：{error}（点一下关掉）
          </div>
        )}
      </main>

      {/* ---------- 弹窗 ---------- */}
      {pendingDelete && (
        <Modal
          title="删除这篇笔记？"
          desc="文件会从磁盘移除，无法撤销。"
          confirmText="删除"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void removeNote(pendingDelete)}
        />
      )}

      {pendingNbDelete && (
        <Modal
          title={`删除笔记本「${pendingNbDelete}」？`}
          desc="只能删除空的笔记本。里面还有笔记的话，请先把笔记移到别的笔记本或删掉。"
          confirmText="删除"
          danger
          onCancel={() => setPendingNbDelete(null)}
          onConfirm={() => void deleteNotebook(pendingNbDelete)}
        />
      )}

      {prompt && (
        <PromptModal
          title={prompt.mode === 'new' ? '新建笔记本' : '重命名笔记本'}
          hint={
            prompt.mode === 'new'
              ? '会在笔记文件夹里建一个同名子目录'
              : '文件夹会一起改名，里面的笔记跟着走'
          }
          defaultValue={prompt.value}
          onCancel={() => setPrompt(null)}
          onConfirm={(v) => void submitPrompt(v)}
        />
      )}
    </div>
  )
}

/* ---------------- 通用弹窗 ---------------- */

function Modal({
  title,
  desc,
  confirmText,
  danger,
  onCancel,
  onConfirm,
}: {
  title: string
  desc: string
  confirmText: string
  danger?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{desc}</p>
        <div className="modal-actions">
          <button onClick={onCancel}>取消</button>
          <button className={danger ? 'danger' : ''} onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

function PromptModal({
  title,
  hint,
  defaultValue,
  onCancel,
  onConfirm,
}: {
  title: string
  hint: string
  defaultValue: string
  onCancel: () => void
  onConfirm: (value: string) => void
}) {
  const [value, setValue] = useState(defaultValue)
  const ref = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const submit = () => {
    if (value.trim()) onConfirm(value)
  }

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{hint}</p>
        <input
          ref={ref}
          className="modal-input"
          value={value}
          placeholder="笔记本名称"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              onCancel()
            }
          }}
        />
        <div className="modal-actions">
          <button onClick={onCancel}>取消</button>
          <button className="primary" onClick={submit}>
            确定
          </button>
        </div>
      </div>
    </div>
  )
}
