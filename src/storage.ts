import type { RawFile } from './types'

export interface Storage {
  /** 存储位置说明，用于界面展示 */
  describe(): Promise<string>
  loadAll(): Promise<RawFile[]>
  save(file: string, content: string): Promise<void>
  remove(file: string): Promise<void>
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
}

/* ---------------- 浏览器降级：localStorage ---------------- */

const KEY = 'jianji.notes.v1'

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
}

export function getStorage(): Storage {
  return inTauri() ? tauriStorage : webStorage
}

export const isDesktop = inTauri()
