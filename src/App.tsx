import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getStorage, isDesktop } from './storage'
import {
  type Note,
  LEDGER_TAG,
  FOCUS_TAG,
  BUILTIN_TAGS,
  allTags,
  baseName,
  formatDate,
  listProgress,
  notePath,
  parseNote,
  serializeNote,
  snippet,
  splitTags,
  stampTitle,
  toFileName,
  wordCount,
} from './types'
import { LedgerView } from './LedgerView'
import { FocusView } from './FocusView'
import { defaultLedgerTitle, ledgerSummary, parseLedger, serializeLedger } from './ledger'
import { defaultFocusTitle, focusSummary, parseFocus, serializeFocus } from './focus'
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

## 记账

左边有个「记账本」，已经帮你建好并置顶了。点「＋ 新建笔记」右边的「更多 ▾」，
选「记账笔记」就能开始记账：选支出还是收入、填金额、点分类，一笔就记上了。
流水按天分组，点日期那一行能把当天收起来。

## 重要事项

同一个「更多 ▾」里选「重要事项」，会建到置顶的「重要事项」笔记本里。
写要做什么、定个日期，打开就按月份排好（2026年10月…），还写着「还有 N 天」，
过了日子还没做的会标红。做完了点前面的圈打勾。

## 标记

标题下面可以给笔记加标记，随便起名（比如「重要」「待读」）。左边最下面的
「标记」分组能按标记筛选。

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

/* ---------------- 笔记本置顶（笔记的置顶存在文件 frontmatter，笔记本没有文件可存） ---------------- */
const NB_PIN_KEY = 'jianji.nb.pinned.v1'

function readPinnedNbs(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(NB_PIN_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function writePinnedNbs(list: string[]) {
  try {
    localStorage.setItem(NB_PIN_KEY, JSON.stringify([...new Set(list)]))
  } catch {
    /* 存不进去也不影响本次会话 */
  }
}

/* ---------------- 内置笔记本：记账本、重要事项 ---------------- */
/** 记账笔记默认落在这个笔记本里 */
const LEDGER_NB = '记账本'
/** 重要事项笔记默认落在这个笔记本里 */
const FOCUS_NB = '重要事项'

/** 两个内置笔记本在左栏的固定顺序：记账本在上、重要事项紧跟着 */
const BUILTIN_NBS = [LEDGER_NB, FOCUS_NB]

const LEDGER_SEEDED_KEY = 'jianji.ledger.v1'
const FOCUS_SEEDED_KEY = 'jianji.focus.v1'

function wasSeeded(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function markSeeded(key: string) {
  try {
    localStorage.setItem(key, '1')
  } catch {
    /* 同上 */
  }
}

function byUpdated(a: Note, b: Note): number {
  return Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt
}

/** 内置笔记本排最前（记账本 → 重要事项），其余排后面 */
function nbRank(name: string): number {
  const i = BUILTIN_NBS.indexOf(name)
  return i < 0 ? BUILTIN_NBS.length : i
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
  const [pendingNbDelete, setPendingNbDelete] = useState<{ name: string; count: number } | null>(
    null,
  )
  const [prompt, setPrompt] = useState<
    | { mode: 'new'; value: string }
    | { mode: 'rename-nb'; value: string; target: string }
    | { mode: 'rename-note'; value: string; target: string }
    | { mode: 'tag'; value: string; target: string }
    | null
  >(null)
  /** 左栏按标记筛选；null 表示不筛 */
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  /** 「新建笔记」旁边的下拉：选普通笔记还是记账笔记 */
  const [newMenu, setNewMenu] = useState<{ x: number; y: number } | null>(null)
  /** 右键菜单：笔记或笔记本，坐标是鼠标位置 */
  const [menu, setMenu] = useState<
    | { kind: 'note'; file: string; x: number; y: number }
    | { kind: 'notebook'; name: string; x: number; y: number }
    | null
  >(null)
  const [pinnedNbs, setPinnedNbs] = useState<string[]>([])

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
              tags: [],
              ledger: false,
              focus: false,
            },
            {
              file: toFileName(WELCOME_TITLE),
              notebook: '',
              title: WELCOME_TITLE,
              body: WELCOME_BODY,
              createdAt: now - 2000,
              updatedAt: now - 2000,
              pinned: false,
              tags: [],
              ledger: false,
              focus: false,
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

        // 内置笔记本（记账本、重要事项）：第一次运行自动建好并置顶；
        // 用户自己删掉后不再反复重建
        let allNbs = nbs
        let pins = readPinnedNbs()
        for (const [nb, key] of [
          [LEDGER_NB, LEDGER_SEEDED_KEY],
          [FOCUS_NB, FOCUS_SEEDED_KEY],
        ] as const) {
          if (wasSeeded(key)) continue
          if (!allNbs.includes(nb)) {
            try {
              await storage.createNotebook(nb)
            } catch {
              /* 已经存在就算了 */
            }
            allNbs = [...new Set([...allNbs, nb])].sort()
          }
          if (!pins.includes(nb)) {
            // 内置的排在置顶区最前面，顺序按 BUILTIN_NBS
            pins = [...pins.filter((p) => p !== nb), nb]
            writePinnedNbs(pins)
          }
          markSeeded(key)
        }
        // 记账本在前、重要事项在后，剩下的保持原样
        pins = [...pins].sort((a, b) => nbRank(a) - nbRank(b))
        setNotebooks(allNbs)
        setPinnedNbs(pins.filter((n) => allNbs.includes(n)))
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

  /**
   * 新建笔记。
   * - kind='ledger'：记账笔记，进「记账本」、带「记账」标记、正文是空的流水表
   * - kind='focus'：重要事项笔记，进「重要事项」、带「重要事项」标记、正文是空的事项表
   * - kind='note'：普通笔记
   */
  const createNote = useCallback(
    async (kind: 'note' | 'ledger' | 'focus' = 'note') => {
      const now = Date.now()
      const isLedger = kind === 'ledger'
      const isFocus = kind === 'focus'
      const target = isLedger ? LEDGER_NB : isFocus ? FOCUS_NB : ''
      const nb = isLedger || isFocus ? target : (scope ?? '')

      // 内置笔记本被删掉了就顺手补回来
      if ((isLedger || isFocus) && !notebooks.includes(target)) {
        try {
          await storage.createNotebook(target)
        } catch {
          /* 已经有同名目录就不再建 */
        }
        setNotebooks((prev) => [...new Set([...prev, target])].sort())
      }

      // 默认标题：普通笔记用当前时间，记账/重要事项用「记账 2026-10」「重要事项 2026-10」
      const base = isLedger
        ? defaultLedgerTitle(now)
        : isFocus
          ? defaultFocusTitle(now)
          : stampTitle(now)
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
        body: isLedger
          ? serializeLedger({ entries: [], extra: '' })
          : isFocus
            ? serializeFocus({ items: [], extra: '' })
            : '',
        createdAt: now,
        updatedAt: now,
        pinned: false,
        tags: [],
        ledger: isLedger,
        focus: isFocus,
      }
      try {
        await storage.save(file, serializeNote(note))
        lastSaved.current.set(file, serializeNote(note))
      } catch (e) {
        setError(String(e))
      }
      setNotes((prev) => [note, ...prev])
      setTagFilter(null)
      openNote(file)
      // 在「全部」里新建会落到未分类，把视图跟过去，免得找不到
      if (isLedger || isFocus) setScope(target)
      else if (scope === null) setScope('')
      setQuery('')
      if (!isLedger && !isFocus) window.setTimeout(() => richRef.current?.focus(), 60)
    },
    [storage, scope, openNote, notebooks],
  )

  const removeNote = useCallback(
    async (file: string) => {
      const wasActive = activeFileRef.current === file
      try {
        await storage.remove(file)
      } catch (e) {
        setError(String(e))
      }
      lastSaved.current.delete(file)
      const rest = notesRef.current.filter((n) => n.file !== file)
      setNotes(rest)
      // 删的是别的笔记时，当前打开的笔记保持不动
      if (wasActive) {
        setActiveFile(rest[0]?.file ?? null)
        setDocSeq((v) => v + 1)
      }
      setPendingDelete(null)
      setMenu(null)
    },
    [storage],
  )

  const togglePin = useCallback(() => {
    const note = notesRef.current.find((n) => n.file === activeFile)
    if (note) patch({ pinned: !note.pinned })
  }, [activeFile, patch])

  /** 列表 / 右键菜单里的置顶：不用先打开这篇笔记 */
  const toggleNotePin = useCallback(
    (file: string) => {
      const note = notesRef.current.find((n) => n.file === file)
      if (!note) return
      const next = { ...note, pinned: !note.pinned }
      setNotes((prev) => prev.map((n) => (n.file === file ? next : n)))
      void persist(next)
    },
    [persist],
  )

  /** 右键「重命名」：改标题，并把文件改成同名 */
  const renameNoteTo = useCallback(
    (file: string, title: string) => {
      const note = notesRef.current.find((n) => n.file === file)
      const clean = title.trim()
      if (!note || !clean) return
      const next = { ...note, title: clean, updatedAt: Date.now() }
      setNotes((prev) => prev.map((n) => (n.file === file ? next : n)))
      void persist(next, true)
    },
    [persist],
  )

  const toggleNbPin = useCallback((name: string) => {
    setPinnedNbs((prev) => {
      const next = prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
      writePinnedNbs(next)
      return next
    })
  }, [])

  /** 给某篇笔记加标记（可以一次加好几个，用逗号分隔） */
  const addTags = useCallback(
    (file: string, raw: string) => {
      const wanted = splitTags(raw).filter((t) => !BUILTIN_TAGS.includes(t))
      if (wanted.length === 0) return
      const note = notesRef.current.find((n) => n.file === file)
      if (!note) return
      const next = [...new Set([...note.tags, ...wanted])]
      if (file === activeFileRef.current) {
        patch({ tags: next })
      } else {
        const updated = { ...note, tags: next, updatedAt: Date.now() }
        setNotes((prev) => prev.map((n) => (n.file === file ? updated : n)))
        void persist(updated)
      }
    },
    [patch, persist],
  )

  const removeTag = useCallback(
    (file: string, tag: string) => {
      const note = notesRef.current.find((n) => n.file === file)
      if (!note) return
      const next = note.tags.filter((t) => t !== tag)
      if (file === activeFileRef.current) {
        patch({ tags: next })
      } else {
        const updated = { ...note, tags: next, updatedAt: Date.now() }
        setNotes((prev) => prev.map((n) => (n.file === file ? updated : n)))
        void persist(updated)
      }
    },
    [patch, persist],
  )

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
      setPinnedNbs((prev) => {
        const next = prev.map((n) => (n === from ? to : n))
        writePinnedNbs(next)
        return next
      })
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
        } else if (prompt.mode === 'rename-nb') {
          const from = prompt.target
          if (from === name) {
            setPrompt(null)
            return
          }
          await storage.renameNotebook(from, name)
          applyNotebookRename(from, name)
        } else if (prompt.mode === 'rename-note') {
          renameNoteTo(prompt.target, name)
        } else if (prompt.mode === 'tag') {
          addTags(prompt.target, value)
        }
        setPrompt(null)
      } catch (e) {
        setError(String(e))
        setPrompt(null)
      }
    },
    [prompt, storage, applyNotebookRename, renameNoteTo, addTags],
  )

  /**
   * 删除笔记本。
   * 以前只允许删空目录，笔记本里一有笔记就删不掉（点了没反应）。
   * 现在两种处理方式：purge=false 把笔记挪到「未分类」，purge=true 连笔记一起删。
   */
  const deleteNotebook = useCallback(
    async (name: string, purge: boolean) => {
      const inside = notesRef.current.filter((n) => n.notebook === name)
      const taken = new Set(
        notesRef.current.filter((n) => n.notebook === '').map((n) => baseName(n.file)),
      )
      const moved = new Map<string, string>() // 旧路径 → 新路径
      const kept: Note[] = []
      try {
        for (const n of inside) {
          if (purge) {
            await storage.remove(n.file)
          } else {
            const base = baseName(n.file)
            let target = base
            let i = 2
            while (taken.has(target)) {
              target = `${base.replace(/\.md$/i, '')} ${i}.md`
              i += 1
            }
            taken.add(target)
            const next = { ...n, notebook: '', file: target }
            const content = serializeNote(next)
            await storage.save(target, content)
            await storage.remove(n.file)
            lastSaved.current.set(target, content)
            moved.set(n.file, target)
            kept.push(next)
          }
          lastSaved.current.delete(n.file)
        }

        await storage.removeNotebook(name, purge)

        const rest = notesRef.current.filter((n) => n.notebook !== name)
        const all = [...rest, ...kept]
        setNotes(all)
        setNotebooks((prev) => prev.filter((n) => n !== name))
        setPinnedNbs((prev) => {
          const next = prev.filter((n) => n !== name)
          writePinnedNbs(next)
          return next
        })
        setScope((s) => (s === name ? null : s))
        if (scope === name) setQuery('')

        const cur = activeFileRef.current
        if (cur && inside.some((n) => n.file === cur)) {
          if (moved.has(cur)) {
            setActiveFile(moved.get(cur) as string) // 跟着挪到未分类，正文继续看
          } else {
            setActiveFile(all[0]?.file ?? null)
            setDocSeq((v) => v + 1)
          }
        }
      } catch (e) {
        setError(String(e))
      }
      setPendingNbDelete(null)
      setMenu(null)
    },
    [storage, scope],
  )

  /* ---------------- 快捷键 ---------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      if (!meta) return
      const key = e.key.toLowerCase()
      if (key === 'n') {
        e.preventDefault()
        void createNote(e.shiftKey ? 'ledger' : 'note')
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

  /** 所有标记及使用次数（含内置的「记账」「重要事项」） */
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of notes) {
      for (const t of allTags(n)) m.set(t, (m.get(t) ?? 0) + 1)
    }
    // 内置标记排最前（记账 → 重要事项），其余按用得多得排
    const rank = (t: string) => {
      const i = BUILTIN_TAGS.indexOf(t)
      return i < 0 ? BUILTIN_TAGS.length : i
    }
    return [...m.entries()].sort(
      (a, b) =>
        rank(a[0]) - rank(b[0]) || b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'),
    )
  }, [notes])

  /** 置顶的排前面；里面按「记账本 → 重要事项 → 其他」再按名称 */
  const orderedNotebooks = useMemo(() => {
    const pin = new Set(pinnedNbs)
    return [...notebooks].sort(
      (a, b) =>
        Number(pin.has(b)) - Number(pin.has(a)) ||
        nbRank(a) - nbRank(b) ||
        a.localeCompare(b, 'zh-Hans-CN'),
    )
  }, [notebooks, pinnedNbs])

  // 搜索时跨全部笔记本，否则只看当前范围；标记筛选是叠加条件
  const filtered = useMemo(() => {
    const byTag = (list: Note[]) =>
      tagFilter ? list.filter((n) => allTags(n).includes(tagFilter)) : list
    const q = query.trim().toLowerCase()
    if (q) {
      const hits = notes.filter(
        (n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q),
      )
      return [...byTag(hits)].sort(byUpdated)
    }
    const base =
      scope === null
        ? notes
        : scope === ''
          ? notes.filter((n) => !n.notebook)
          : notes.filter((n) => n.notebook === scope)
    return [...byTag(base)].sort(byUpdated)
  }, [notes, query, scope, tagFilter])

  const active = notes.find((n) => n.file === activeFile) ?? null
  // 任何一篇正文里有 `- [ ]` 就算有待办，不再是「清单」这种类型专属
  const activeStat = active ? statsOf(active.body) : null

  const scopeLabel = tagFilter
    ? `标记：${tagFilter}`
    : query.trim()
      ? '搜索结果'
      : scope === null
        ? '全部笔记'
        : scope === ''
          ? '未分类'
          : scope

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
            className={`rail-item${scope === null && !query && !tagFilter ? ' active' : ''}`}
            onClick={() => {
              setScope(null)
              setQuery('')
              setTagFilter(null)
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
            className={`rail-item${scope === '' && !query && !tagFilter ? ' active' : ''}`}
            onClick={() => {
              setScope('')
              setQuery('')
              setTagFilter(null)
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
          {orderedNotebooks.length === 0 && railOpen && (
            <div className="rail-empty">还没有笔记本</div>
          )}
          {orderedNotebooks.map((nb) => {
            const nbPinned = pinnedNbs.includes(nb)
            return (
              <div
                key={nb}
                className={`rail-item nb${scope === nb && !query ? ' active' : ''}`}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setMenu({ kind: 'notebook', name: nb, x: e.clientX, y: e.clientY })
                }}
              >
                <button
                  className="rail-main"
                  onClick={() => {
                    setScope(nb)
                    setQuery('')
                  }}
                  title={nb}
                >
                  <span className={`rail-ico${nbPinned ? ' pinned' : ''}`}>
                    {nbPinned ? '★' : '▸'}
                  </span>
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
                      onClick={() => setPrompt({ mode: 'rename-nb', value: nb, target: nb })}
                      title="重命名"
                    >
                      ✎
                    </button>
                    <button
                      onClick={() =>
                        setPendingNbDelete({ name: nb, count: counts.map.get(nb) ?? 0 })
                      }
                      title="删除"
                    >
                      ×
                    </button>
                  </span>
                )}
              </div>
            )
          })}
        </div>

        {railOpen && tagCounts.length > 0 && <div className="rail-label">标记</div>}

        {railOpen && tagCounts.length > 0 && (
          <div className="rail-group rail-tags">
            {tagCounts.map(([t, c]) => (
              <button
                key={t}
                className={`rail-item tag${tagFilter === t ? ' active' : ''}`}
                onClick={() => {
                  setTagFilter((cur) => (cur === t ? null : t))
                  setQuery('')
                }}
                title={`只看带「${t}」标记的笔记`}
              >
                <span className={`rail-ico${BUILTIN_TAGS.includes(t) ? ' pinned' : ''}`}>
                  {t === LEDGER_TAG ? '¥' : t === FOCUS_TAG ? '⚑' : '#'}
                </span>
                <span className="rail-name">{t}</span>
                <b className="rail-count">{c}</b>
              </button>
            ))}
          </div>
        )}

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
          {tagFilter && (
            <button className="scope-clear" onClick={() => setTagFilter(null)} title="取消标记筛选">
              清除
            </button>
          )}
          {canDeleteNotebook && (
            <button
              className="scope-del"
              onClick={() =>
                setPendingNbDelete({ name: scope, count: counts.map.get(scope) ?? 0 })
              }
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
          <button className="new-main" onClick={() => void createNote('note')} title="⌘N">
            <span className="plus">＋</span> 新建笔记
          </button>
          <button
            className="new-more"
            title="更多新建：记账笔记（⌘⇧N）、重要事项"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setNewMenu({ x: Math.max(6, r.right - 200), y: r.bottom + 6 })
            }}
          >
            更多 ▾
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
            const tags = allTags(n)
            // 记账/重要事项的正文是一张表，摘要换成各自的概览
            const special = n.ledger || n.focus
            const sub = n.ledger
              ? ledgerSummary(n.body)
              : n.focus
                ? focusSummary(n.body)
                : st.sub
            return (
              <button
                key={n.file}
                className={`note-item${n.file === activeFile ? ' active' : ''}`}
                onClick={() => openNote(n.file)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setMenu({ kind: 'note', file: n.file, x: e.clientX, y: e.clientY })
                }}
              >
                <div className="note-item-top">
                  <span
                    className={`dot${st.total > 0 && st.done < st.total ? ' open' : ''}${
                      n.ledger ? ' is-ledger' : ''
                    }${n.focus ? ' is-focus' : ''}`}
                  />
                  <span className="note-title">{n.title || '未命名'}</span>
                  {n.pinned && <span className="pin">·</span>}
                  <span className="note-time">{formatDate(n.updatedAt)}</span>
                </div>
                <div className="note-sub">
                  {!special && st.total > 0 && (
                    <span className="note-prog">
                      {st.done}/{st.total}
                    </span>
                  )}
                  {!special && st.total > 0 && st.sub ? ' · ' : ''}
                  {sub || (st.total > 0 ? '' : '空白')}
                </div>
                {tags.length > 0 && (
                  <div className="note-tags">
                    {tags.slice(0, 3).map((t) => (
                      <span
                        key={t}
                        className={`tag-mini${t === LEDGER_TAG ? ' is-ledger' : ''}${
                          t === FOCUS_TAG ? ' is-focus' : ''
                        }`}
                      >
                        {t}
                      </span>
                    ))}
                    {tags.length > 3 && <span className="tag-mini">+{tags.length - 3}</span>}
                  </div>
                )}
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
              <div className="tag-row">
                {allTags(active).map((t) => (
                  <span
                    key={t}
                    className={`tag${t === LEDGER_TAG ? ' is-ledger' : ''}${
                      t === FOCUS_TAG ? ' is-focus' : ''
                    }`}
                  >
                    {t}
                    {!BUILTIN_TAGS.includes(t) && (
                      <button
                        className="tag-x"
                        title="去掉这个标记"
                        onClick={() => removeTag(active.file, t)}
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))}
                <button
                  className="tag-add"
                  onClick={() => setPrompt({ mode: 'tag', value: '', target: active.file })}
                  title="给这篇笔记加标记"
                >
                  ＋ 标记
                </button>
              </div>
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
                  {active.ledger ? (
                    <span>{parseLedger(active.body).entries.length} 笔</span>
                  ) : active.focus ? (
                    <span>{parseFocus(active.body).items.length} 项</span>
                  ) : (
                    <span>{activeStat?.words ?? 0} 字</span>
                  )}
                  {!active.ledger && !active.focus && activeStat && activeStat.total > 0 && (
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

            <section
              className={`editor-body${active.ledger || active.focus ? ' ledger-body' : ''}`}
            >
              {active.ledger ? (
                <LedgerView
                  key={active.file}
                  note={active}
                  onChange={(body) => patch({ body })}
                />
              ) : active.focus ? (
                <FocusView
                  key={active.file}
                  note={active}
                  onChange={(body) => patch({ body })}
                />
              ) : (
                <RichEditor
                  key={docSeq}
                  ref={richRef}
                  initial={active.body}
                  onChange={(body) => patch({ body })}
                />
              )}
            </section>
          </>
        )}

        {error && (
          <div className="error-bar" onClick={() => setError('')}>
            出错了：{error}（点一下关掉）
          </div>
        )}
      </main>

      {/* ---------- 「新建」下拉 ---------- */}
      {newMenu && (
        <ContextMenu
          x={newMenu.x}
          y={newMenu.y}
          onClose={() => setNewMenu(null)}
          items={[
            { label: '普通笔记', onClick: () => void createNote('note') },
            {
              label: '记账笔记（存到「记账本」）',
              onClick: () => void createNote('ledger'),
            },
            {
              label: '重要事项（存到「重要事项」）',
              onClick: () => void createNote('focus'),
            },
          ]}
        />
      )}

      {/* ---------- 右键菜单 ---------- */}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={
            menu.kind === 'note'
              ? (() => {
                  const note = notes.find((n) => n.file === menu.file)
                  return [
                    {
                      label: note?.pinned ? '取消置顶' : '置顶',
                      onClick: () => toggleNotePin(menu.file),
                    },
                    {
                      label: '重命名',
                      onClick: () =>
                        setPrompt({
                          mode: 'rename-note',
                          value: note?.title ?? '',
                          target: menu.file,
                        }),
                    },
                    { sep: true },
                    {
                      label: '删除',
                      danger: true,
                      onClick: () => setPendingDelete(menu.file),
                    },
                  ]
                })()
              : [
                  {
                    label: pinnedNbs.includes(menu.name) ? '取消置顶' : '置顶',
                    onClick: () => toggleNbPin(menu.name),
                  },
                  {
                    label: '重命名',
                    onClick: () =>
                      setPrompt({ mode: 'rename-nb', value: menu.name, target: menu.name }),
                  },
                  { sep: true },
                  {
                    label: '删除',
                    danger: true,
                    onClick: () =>
                      setPendingNbDelete({
                        name: menu.name,
                        count: counts.map.get(menu.name) ?? 0,
                      }),
                  },
                ]
          }
        />
      )}

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
          title={`删除笔记本「${pendingNbDelete.name}」？`}
          desc={
            pendingNbDelete.count > 0
              ? `里面有 ${pendingNbDelete.count} 篇笔记。确认后这些笔记会先移到「未分类」，一篇都不会丢。`
              : '这个笔记本是空的，删除不会影响任何笔记。'
          }
          confirmText={pendingNbDelete.count > 0 ? '移到未分类并删除' : '删除'}
          danger
          extra={
            pendingNbDelete.count > 0
              ? {
                  text: `连 ${pendingNbDelete.count} 篇笔记一起删掉`,
                  danger: true,
                  onClick: () => void deleteNotebook(pendingNbDelete.name, true),
                }
              : undefined
          }
          onCancel={() => setPendingNbDelete(null)}
          onConfirm={() => void deleteNotebook(pendingNbDelete.name, false)}
        />
      )}

      {prompt && (
        <PromptModal
          title={
            prompt.mode === 'new'
              ? '新建笔记本'
              : prompt.mode === 'rename-nb'
                ? '重命名笔记本'
                : prompt.mode === 'rename-note'
                  ? '重命名笔记'
                  : '加个标记'
          }
          hint={
            prompt.mode === 'new'
              ? '会在笔记文件夹里建一个同名子目录'
              : prompt.mode === 'rename-nb'
                ? '文件夹会一起改名，里面的笔记跟着走'
                : prompt.mode === 'rename-note'
                  ? '文件名会一起改成这个标题'
                  : '随便起名，多个用逗号分隔。已有的标记可以直接选'
          }
          placeholder={prompt.mode === 'tag' ? '比如：重要, 待读' : prompt.mode === 'rename-note' ? '笔记标题' : '笔记本名称'}
          defaultValue={prompt.value}
          suggestions={
            prompt.mode === 'tag'
              ? tagCounts.map(([t]) => t).filter((t) => !BUILTIN_TAGS.includes(t))
              : undefined
          }
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
  extra,
  onCancel,
  onConfirm,
}: {
  title: string
  desc: string
  confirmText: string
  danger?: boolean
  /** 次要的破坏性操作，比如「连笔记一起删」 */
  extra?: { text: string; danger?: boolean; onClick: () => void }
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{desc}</p>
        <div className="modal-actions">
          {extra && (
            <button className={`ghost${extra.danger ? ' ghost-danger' : ''}`} onClick={extra.onClick}>
              {extra.text}
            </button>
          )}
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
  placeholder,
  defaultValue,
  suggestions,
  onCancel,
  onConfirm,
}: {
  title: string
  hint: string
  placeholder: string
  defaultValue: string
  /** 已有的选项，点一下填进输入框（按标记时用） */
  suggestions?: string[]
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
          placeholder={placeholder}
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
        {suggestions && suggestions.length > 0 && (
          <div className="prompt-sugs">
            {suggestions.map((s) => (
              <button
                key={s}
                className="prompt-sug"
                onClick={() =>
                  setValue((prev) => {
                    const cur = prev.replace(/[,，]\s*$/, '').trim()
                    if (cur.split(/[,，]/).map((x) => x.trim()).includes(s)) return prev
                    return cur ? `${cur}, ${s}` : s
                  })
                }
              >
                {s}
              </button>
            ))}
          </div>
        )}
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

/* ---------------- 右键菜单 ---------------- */

type MenuEntry = { label: string; onClick: () => void; danger?: boolean } | { sep: true }

function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number
  y: number
  items: MenuEntry[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ x, y })

  // 贴着窗口边缘右键时，把菜单收回可视区域
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(6, Math.min(x, window.innerWidth - r.width - 6)),
      y: Math.max(6, Math.min(y, window.innerHeight - r.height - 6)),
    })
  }, [x, y])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    window.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="ctx"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        'sep' in it ? (
          <div key={`s${i}`} className="ctx-sep" />
        ) : (
          <button
            key={it.label}
            className={`ctx-item${it.danger ? ' danger' : ''}`}
            onClick={() => {
              onClose()
              it.onClick()
            }}
          >
            {it.label}
          </button>
        ),
      )}
    </div>
  )
}
