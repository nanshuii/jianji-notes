/**
 * 重要事项数据模型。
 *
 * 和记账一样，数据就存在笔记正文里，一张普通 Markdown 表格：
 *
 *   | 日期 | 事项 | 级别 | 状态 | 进度 | 子事项 | 备注 | 失败原因 |
 *   | --- | --- | --- | --- | --- | --- | --- | --- |
 *   | 2026-10-25 | 交房租 | 重要 | 待办 | | | 房东账号没变 | |
 *   | 2026-10-30 | 装修 | 紧急 | 待办 | 3/10 | 买水泥 ✓；找师傅 | | |
 *
 * 打开时按月份分组展示（2026年10月 …），带倒计时、进度条、子事项、完成勾选。
 * 好处同样是：用任何编辑器都能看、能改，Git 能 diff。
 * 老版本只有 5 列的表格也能直接读（缺的列按默认值补）。
 */

export type FocusLevel = 'normal' | 'important' | 'urgent'
export type FocusStatus = 'open' | 'done' | 'failed'

/** 子事项：只有「待完成 / 已完成」两种状态 */
export interface SubTask {
  title: string
  done: boolean
}

export interface FocusItem {
  /** YYYY-MM-DD */
  date: string
  title: string
  level: FocusLevel
  status: FocusStatus
  /** 进度类才有意义：一共几步；0 表示不是进度类事项 */
  steps: number
  /** 已经走到第几步 */
  progress: number
  /** 子事项（进度类事项才有） */
  subs: SubTask[]
  note: string
  /** 失败原因 */
  reason: string
}

export interface FocusSheet {
  items: FocusItem[]
  /** 表格之外的正文，原样保留 */
  extra: string
}

export const LEVELS: { key: FocusLevel; label: string; icon: string }[] = [
  { key: 'urgent', label: '紧急', icon: '🔥' },
  { key: 'important', label: '重要', icon: '❗' },
  { key: 'normal', label: '普通', icon: '•' },
]

const LEVEL_BY_LABEL = new Map(LEVELS.map((l) => [l.label, l.key]))

export function levelLabel(level: FocusLevel): string {
  return LEVELS.find((l) => l.key === level)?.label ?? '重要'
}

export function levelIcon(level: FocusLevel): string {
  return LEVELS.find((l) => l.key === level)?.icon ?? '•'
}

export function statusLabel(status: FocusStatus): string {
  return status === 'done' ? '已完成' : status === 'failed' ? '已失败' : '待办'
}

export function isDone(it: FocusItem): boolean {
  return it.status === 'done'
}

export function isFailed(it: FocusItem): boolean {
  return it.status === 'failed'
}

export function isOpen(it: FocusItem): boolean {
  return it.status === 'open'
}

/** 进度类事项的「3/10」；非进度类返回空串 */
export function progressLabel(it: FocusItem): string {
  return it.steps > 0 ? `${it.progress}/${it.steps}` : ''
}

/** 进度条百分比（0-100） */
export function progressPct(it: FocusItem): number {
  if (it.steps <= 0) return 0
  return Math.round((Math.min(it.progress, it.steps) / it.steps) * 100)
}

export function subDoneCount(it: FocusItem): number {
  return it.subs.filter((s) => s.done).length
}

/** 默认进度步数 */
export const DEFAULT_STEPS = 10
export const MIN_STEPS = 2
export const MAX_STEPS = 100

const HEADER = ['日期', '事项', '级别', '状态', '进度', '子事项', '备注', '失败原因']

function cells(line: string): string[] {
  const t = line.trim()
  const inner = t.startsWith('|') ? t.slice(1) : t
  const out = inner.endsWith('|') ? inner.slice(0, -1) : inner
  return out.split('|').map((s) => s.trim())
}

function isTableLine(line: string): boolean {
  return /^\s*\|/.test(line)
}

function isSeparator(cs: string[]): boolean {
  return cs.length > 0 && cs.every((c) => /^:?-{2,}:?$/.test(c) || c === '')
}

export function todayISO(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 把用户输入的日期字符串尽量读成 YYYY-MM-DD。
 * 认得 2026-10-21 / 2026/10/21 / 2026.10.21 / 20261021 / 10-21 / 21。
 * 实在读不出来就返回空串，由调用方决定回退。
 */
export function coerceDate(raw: string, base: string = todayISO()): string {
  const s = raw.trim().replace(/[./年月]/g, '-').replace(/日/g, '')
  const p = (n: string) => n.padStart(2, '0')
  const [by, bm] = base.split('-')

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (m) return `${m[1]}-${p(m[2])}-${p(m[3])}`

  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`

  // 只写了月-日，年份沿用 base
  m = /^(\d{1,2})-(\d{1,2})$/.exec(s)
  if (m) return `${by}-${p(m[1])}-${p(m[2])}`

  // 只写了日
  m = /^(\d{1,2})$/.exec(s)
  if (m) return `${by}-${bm}-${p(m[1])}`

  return ''
}

function parseDate(raw: string): string {
  return coerceDate(raw) || todayISO()
}

function parseLevel(raw: string): FocusLevel {
  return LEVEL_BY_LABEL.get(raw.trim()) ?? 'important'
}

function parseStatus(raw: string): FocusStatus {
  const s = raw.trim()
  if (/失败|fail|✗|×/i.test(s)) return 'failed'
  if (/完成|done|√|✓/i.test(s)) return 'done'
  return 'open'
}

/** 「3/10」→ {steps:10, progress:3}；读不出就当成不是进度类 */
function parseProgress(raw: string): { steps: number; progress: number } {
  const m = /(\d+)\s*[/／]\s*(\d+)/.exec(raw)
  if (!m) return { steps: 0, progress: 0 }
  const steps = Math.min(MAX_STEPS, Number(m[2]))
  const progress = Math.min(steps, Number(m[1]))
  return steps >= MIN_STEPS ? { steps, progress } : { steps: 0, progress: 0 }
}

/** 子事项：用；分隔，「名称 ✓」表示已完成 */
function parseSubs(raw: string): SubTask[] {
  return raw
    .split(/[;；]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const marked = /[✓√]\s*$/.test(s) || /^\[[xX]\]/.test(s)
      const title = s
        .replace(/[✓√]\s*$/, '')
        .replace(/^\[[xX ]\]\s*/, '')
        .trim()
      return { title, done: marked }
    })
    .filter((s) => s.title.length > 0)
}

/** 把正文里那张表格读成事项列表；表格外的内容原样留着 */
export function parseFocus(body: string): FocusSheet {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((l) => isTableLine(l))
  if (start < 0) return { items: [], extra: body.trim() }

  let end = start
  while (end < lines.length && isTableLine(lines[end])) end += 1

  const block = lines.slice(start, end)
  const items: FocusItem[] = []

  // 第一行是表头：按列名定位，用户手改过列顺序、或还是老的 5 列表格都不会读错
  const head = cells(block[0])
  const idx = (name: string) => head.indexOf(name)
  const cDate = idx('日期')
  const cTitle = idx('事项')
  const cLevel = idx('级别')
  const cState = idx('状态')
  const cSteps = idx('进度')
  const cSubs = idx('子事项')
  const cNote = idx('备注')
  const cReason = idx('失败原因')

  const at = (cs: string[], i: number) => (i >= 0 ? (cs[i] ?? '') : '')

  for (const line of block.slice(1)) {
    const cs = cells(line)
    if (isSeparator(cs)) continue
    const title = at(cs, cTitle).trim()
    if (!title) continue
    const { steps, progress } = parseProgress(at(cs, cSteps))
    items.push({
      date: parseDate(at(cs, cDate)),
      title,
      level: parseLevel(at(cs, cLevel)),
      status: parseStatus(at(cs, cState)),
      steps,
      progress,
      subs: parseSubs(at(cs, cSubs)),
      note: at(cs, cNote).trim(),
      reason: at(cs, cReason).trim(),
    })
  }

  const extra = [...lines.slice(0, start), ...lines.slice(end)].join('\n').trim()
  return { items, extra }
}

export function cell(v: string): string {
  // 竖线会把表格撑坏，换成全角
  return v.replace(/\|/g, '｜').replace(/\n/g, ' ').trim()
}

function serializeSubs(subs: SubTask[]): string {
  return subs.map((s) => (s.done ? `${cell(s.title)} ✓` : cell(s.title))).join('；')
}

export function serializeFocus(sheet: FocusSheet): string {
  const rows = [...sheet.items]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((it) => {
      const row = [
        it.date,
        cell(it.title),
        levelLabel(it.level),
        statusLabel(it.status),
        it.steps > 0 ? `${it.progress}/${it.steps}` : '',
        serializeSubs(it.subs),
        cell(it.note),
        cell(it.reason),
      ]
      return `| ${row.join(' | ')} |`
    })
  const table = [`| ${HEADER.join(' | ')} |`, `| ${HEADER.map(() => '---').join(' | ')} |`, ...rows]
  return table.join('\n') + (sheet.extra ? `\n\n${sheet.extra}` : '') + '\n'
}

/** YYYY-MM */
export function monthOf(iso: string): string {
  return iso.slice(0, 7)
}

/** 2026-10 → 2026年10月 */
export function monthTitle(ym: string): string {
  const [y, m] = ym.split('-')
  return `${y}年${Number(m)}月`
}

export interface FocusMonth {
  ym: string
  label: string
  items: FocusItem[]
  /** 这个月还没完成的 */
  open: number
}

/** 排在前面的优先级：待办 → 失败（要重排） → 已完成 */
function statusRank(it: FocusItem): number {
  return it.status === 'open' ? 0 : it.status === 'failed' ? 1 : 2
}

/**
 * 按月份分组：月份从早到晚（2026年9月、2026年10月…）；
 * 同一个月里未完成的排前面，再按日期从早到晚 —— 打开就能看到「接下来要做什么」。
 */
export function groupByMonth(items: FocusItem[]): FocusMonth[] {
  const map = new Map<string, FocusItem[]>()
  for (const it of items) {
    const list = map.get(monthOf(it.date))
    if (list) list.push(it)
    else map.set(monthOf(it.date), [it])
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([ym, list]) => {
      const sorted = [...list].sort(
        (a, b) =>
          statusRank(a) - statusRank(b) || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0),
      )
      return {
        ym,
        label: monthTitle(ym),
        items: sorted,
        open: sorted.filter((i) => i.status === 'open').length,
      }
    })
}

export interface FocusStat {
  total: number
  done: number
  failed: number
  open: number
  /** 已过期还没做的 */
  overdue: number
  /** 7 天内要做的 */
  soon: number
}

export function todayStart(): number {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** 距离今天还有几天（负数是已经过去几天） */
export function daysAway(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  const target = new Date(y, m - 1, d).getTime()
  return Math.round((target - todayStart()) / 86400000)
}

/** 「今天」「还有 3 天」「已过 2 天」 */
export function dayHint(iso: string): string {
  const n = daysAway(iso)
  if (n === 0) return '就是今天'
  if (n > 0) return `还有 ${n} 天`
  return `已过 ${-n} 天`
}

export function focusStat(items: FocusItem[]): FocusStat {
  let done = 0
  let failed = 0
  let overdue = 0
  let soon = 0
  for (const it of items) {
    if (it.status === 'done') {
      done += 1
      continue
    }
    if (it.status === 'failed') {
      failed += 1
      continue
    }
    const n = daysAway(it.date)
    if (n < 0) overdue += 1
    else if (n <= 7) soon += 1
  }
  return {
    total: items.length,
    done,
    failed,
    open: items.length - done - failed,
    overdue,
    soon,
  }
}

/** 重要事项笔记的默认标题：重要事项 2026-10 */
export function defaultFocusTitle(ts: number = Date.now()): string {
  const d = new Date(ts)
  return `重要事项 ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 列表里显示的一句话摘要，代替正文摘要 */
export function focusSummary(body: string): string {
  const { items } = parseFocus(body)
  if (items.length === 0) return '还没记第一件'
  const s = focusStat(items)
  const fail = s.failed > 0 ? ` · 失败 ${s.failed}` : ''
  return `共 ${s.total} 项 · 待办 ${s.open}${s.overdue > 0 ? ` · 逾期 ${s.overdue}` : ''}${fail}`
}

export function weekdayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
}

/** 10月25日 周六 */
export function dateLabel(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${Number(m)}月${Number(d)}日 ${weekdayOf(iso)}`
}

/** 短一点：10-25 */
export function shortDate(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${Number(m)}月${Number(d)}日`
}
