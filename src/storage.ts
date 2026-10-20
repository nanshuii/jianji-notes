import type { RawFile } from './types'

export interface Storage {
  /** 存储位置说明，用于界面展示 */
  describe(): Promise<string>
  loadAll(): Promise<RawFile[]>
  save(file: string, content: string): Promise<void>
  remove(file: string): Promise<void>
  /* 笔记本（磁盘上的子目录） */
  listNotebooks(): Promise<string[]>
  createNotebook(name: string): Promise<void>
  renameNotebook(from: string, to: string): Promise<void>
  removeNotebook(name: string): Promise<void>
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

let cachedInvoke: Invoke | null = null

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!cachedInvoke) {
    const mod = await import('@tauri-apps/api/core')
    cachedInvoke = mod.invoke as Invoke
  }
  return cachedInvoke<T>(cmd, args)
}

const tauriStorage: Storage = {
  async describe() {
    const dir = await tauriInvoke<string>('notes_dir')
    return dir
  },
  async loadAll() {
    return tauriInvoke<RawFile[]>('load_all')
  },
  async save(file, content) {
    await tauriInvoke('save_note', { file, content })
  },
  async remove(file) {
    await tauriInvoke('delete_note', { file })
  },
  async listNotebooks() {
    return tauriInvoke<string[]>('list_notebooks')
  },
  async createNotebook(name) {
    await tauriInvoke('create_notebook', { name })
  },
  async renameNotebook(from, to) {
    await tauriInvoke('rename_notebook', { from, to })
  },
  async removeNotebook(name) {
    await tauriInvoke('delete_notebook', { name })
  },
}

/* ---------------- 浏览器降级：localStorage ---------------- */

const KEY = 'jianji.notes.v1'
const NB_KEY = 'jianji.notebooks.v1'

function readStore(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, string>
  } catch {
    return {}
  }
}

function writeStore(data: Record<string, string>) {
  localStorage.setItem(KEY, JSON.stringify(data))
}

function readNotebooks(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(NB_KEY) || '[]') as string[]
    // 空笔记本只能靠这份清单记住（浏览器里没有目录这个概念），
    // 同时补上笔记路径里出现过的前缀，防止清单丢失后分组消失
    const derived = Object.keys(readStore())
      .filter((f) => f.includes('/'))
      .map((f) => f.slice(0, f.indexOf('/')))
    return [...new Set([...saved, ...derived])].sort()
  } catch {
    return []
  }
}

function writeNotebooks(list: string[]) {
  localStorage.setItem(NB_KEY, JSON.stringify([...new Set(list)].sort()))
}

const webStorage: Storage = {
  async describe() {
    return '浏览器本地存储（预览模式）'
  },
  async loadAll() {
    return Object.entries(readStore()).map(([file, content]) => ({ file, content }))
  },
  async save(file, content) {
    const data = readStore()
    data[file] = content
    writeStore(data)
  },
  async remove(file) {
    const data = readStore()
    delete data[file]
    writeStore(data)
  },
  async listNotebooks() {
    return readNotebooks()
  },
  async createNotebook(name) {
    const list = readNotebooks()
    if (list.includes(name)) throw new Error(`笔记本「${name}」已存在`)
    writeNotebooks([...list, name])
  },
  async renameNotebook(from, to) {
    const list = readNotebooks()
    if (list.includes(to)) throw new Error(`笔记本「${to}」已存在`)
    // 把该笔记本下的所有笔记 key 前缀换掉
    const data = readStore()
    const next: Record<string, string> = {}
    for (const [file, content] of Object.entries(data)) {
      next[file.startsWith(`${from}/`) ? `${to}/${file.slice(from.length + 1)}` : file] = content
    }
    writeStore(next)
    writeNotebooks(list.map((n) => (n === from ? to : n)))
  },
  async removeNotebook(name) {
    const data = readStore()
    if (Object.keys(data).some((f) => f.startsWith(`${name}/`))) {
      throw new Error('这个笔记本里还有笔记，先把笔记移走或删除')
    }
    writeNotebooks(readNotebooks().filter((n) => n !== name))
  },
}

export function getStorage(): Storage {
  return inTauri() ? tauriStorage : webStorage
}

export const isDesktop = inTauri()
