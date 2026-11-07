/**
 * 「文档卡片」的纯逻辑：把一份 .md 放进笔记里显示。
 *
 * 和网页卡片（embed.ts）同一套思路：文件本体存 .assets/，正文里只留一行元信息：
 *
 *   ```jianji-md
 *   {"file":"md-20261107-153000-1a2b.md","title":"十月复盘","height":520,"mode":"inline"}
 *   ```
 *
 * 区别在于 .md 是笔记自己的排版语言：不用 iframe、不用量高度，
 * 直接解析成正文节点摆进去 —— 高度天然就贴着内容，没有「先占位再撑开」的抖动。
 */
import { DEFAULT_HEIGHT, MAX_HEIGHT, MIN_HEIGHT, embedMode, parseEmbedMeta, type EmbedMode } from './embed'

export const EMBED_MD_LANG = 'jianji-md'

const MD_EXT = /\.(md|markdown)$/i

/** 是不是一份 Markdown 文件（Finder 拖进来的常常没有 MIME，按扩展名认） */
export function isMdFile(f: { name?: string; type?: string } | null | undefined): boolean {
  if (!f) return false
  if (typeof f.name === 'string' && MD_EXT.test(f.name)) return true
  return f.type === 'text/markdown'
}

/** 文件名 → 卡片标题：去掉扩展名，空的退回「文档」 */
export function titleOfMd(fileName: string): string {
  const t = (fileName || '').replace(MD_EXT, '').trim()
  return t || '文档'
}

/** 不会撞车的附件名：md-20261107-153000-1a2b.md（和网页的 html- 前缀区分开） */
export function makeMdAssetName(now: number = Date.now(), rand: number = Math.random()): string {
  const d = new Date(now)
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`
  const tail = Math.floor(rand * 0xffff)
    .toString(16)
    .padStart(4, '0')
  return `md-${stamp}-${tail}.md`
}

export type MdMeta = {
  /** .assets 里的文件名 */
  file: string
  /** 卡片上显示的标题 */
  title: string
  /** 卡片模式的高度（像素）；融入模式用不到，但留着让两种模式能来回切 */
  height: number
  /** card = 卡片；inline = 融入正文（新插入的默认） */
  mode: EmbedMode
}

/** 解析围栏里的元信息；直接复用网页卡片的解析（字段是同一套），多余字段忽略 */
export function parseMdMeta(raw: string): MdMeta | null {
  const m = parseEmbedMeta(raw)
  if (!m) return null
  return { file: m.file, title: m.title, height: m.height, mode: embedMode(m.mode) }
}

/** 元信息 → 一行 JSON；默认值不写，保持老格式干净 */
export function mdMetaJson(m: MdMeta): string {
  const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(m.height || DEFAULT_HEIGHT)))
  const mode = embedMode(m.mode)
  const out: Record<string, unknown> = { file: m.file, title: m.title ?? '', height }
  if (mode !== 'card') out.mode = mode
  return JSON.stringify(out)
}

/** `xxx.md` → `xxx.bak.md`：保存前留的上一版（同网页卡片的 .bak.html） */
export function backupNameMd(file: string): string {
  return `${file.replace(/\.md$/i, '')}.bak.md`
}

/**
 * 拖进来的 .md 可能带着 frontmatter（文件头两行 --- 之间那段），
 * 那是给发布器看的元数据，渲染时去掉；保存时原样接回去，一个字不动。
 */
export function stripFrontmatter(src: string): { front: string; body: string } {
  const m = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(src)
  if (!m) return { front: '', body: src }
  const front = m[0]
  return { front, body: src.slice(front.length) }
}
