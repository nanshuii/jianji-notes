/**
 * 记账数据模型。
 *
 * 数据就存在笔记正文里，一张普通 Markdown 表格：
 *
 *   | 日期 | 类型 | 分类 | 金额 | 备注 |
 *   | --- | --- | --- | --- | --- |
 *   | 2026-10-21 | 支出 | 餐饮 | 32.00 | 午餐 |
 *
 * 好处：用任何编辑器都能看、能改，Git 能 diff，同步不会打架。
 */

export type EntryType = 'expense' | 'income'

export interface Entry {
  /** YYYY-MM-DD */
  date: string
  type: EntryType
  category: string
  /** 正数，单位元；正负由 type 决定 */
  amount: number
  note: string
}

export interface LedgerSheet {
  entries: Entry[]
  /** 表格之外的正文，原样保留（记账笔记里也能写点别的东西） */
  extra: string
}

export const TYPE_LABEL: Record<EntryType, string> = { expense: '支出', income: '收入' }

export const EXPENSE_CATS = [
  '餐饮',
  '交通',
  '购物',
  '居住',
  '娱乐',
  '医疗',
  '学习',
  '人情',
  '通讯',
  '其他',
]

export const INCOME_CATS = ['工资', '奖金', '兼职', '理财', '红包', '其他']

/** 分类的小图标，让流水看起来像正经记账 App */
export const CAT_ICON: Record<string, string> = {
  餐饮: '🍜',
  交通: '🚌',
  购物: '🛍',
  居住: '🏠',
  娱乐: '🎬',
  医疗: '💊',
  学习: '📚',
  人情: '🎁',
  通讯: '📱',
  工资: '💰',
  奖金: '🏅',
  兼职: '💼',
  理财: '📈',
  红包: '🧧',
  其他: '•',
}

export function catIcon(cat: string): string {
  return CAT_ICON[cat] ?? '•'
}

const HEADER = ['日期', '类型', '分类', '金额', '备注']

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

function parseDate(raw: string): string {
  const s = raw.replace(/[./]/g, '-').trim()
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (!m) return todayISO()
  const p = (n: string) => n.padStart(2, '0')
  return `${m[1]}-${p(m[2])}-${p(m[3])}`
}

function parseAmount(raw: string): number {
  const n = Number.parseFloat(raw.replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? Math.abs(Math.round(n * 100) / 100) : 0
}

/** 把正文里那张表格读成账目列表；表格外的内容原样留着 */
export function parseLedger(body: string): LedgerSheet {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((l) => isTableLine(l))
  if (start < 0) return { entries: [], extra: body.trim() }

  let end = start
  while (end < lines.length && isTableLine(lines[end])) end += 1

  const block = lines.slice(start, end)
  const entries: Entry[] = []

  // 第一行是表头：按列名定位，用户手改过列顺序也不会读错
  const head = cells(block[0])
  const idx = (name: string) => head.indexOf(name)
  const cDate = idx('日期')
  const cType = idx('类型')
  const cCat = idx('分类')
  const cAmount = idx('金额')
  const cNote = idx('备注')

  for (const line of block.slice(1)) {
    const cs = cells(line)
    if (isSeparator(cs)) continue
    const amount = parseAmount(cs[cAmount] ?? '')
    if (!amount) continue
    const type: EntryType = /收入|income/i.test(cs[cType] ?? '') ? 'income' : 'expense'
    entries.push({
      date: parseDate(cs[cDate] ?? ''),
      type,
      category: (cs[cCat] ?? '').trim() || '其他',
      amount,
      note: (cs[cNote] ?? '').trim(),
    })
  }

  const extra = [...lines.slice(0, start), ...lines.slice(end)].join('\n').trim()
  return { entries, extra }
}

export function cell(v: string): string {
  // 竖线会把表格撑坏，换成全角
  return v.replace(/\|/g, '｜').replace(/\n/g, ' ').trim()
}

export function serializeLedger(sheet: LedgerSheet): string {
  const rows = [...sheet.entries]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .map(
      (e) =>
        `| ${e.date} | ${TYPE_LABEL[e.type]} | ${cell(e.category)} | ${e.amount.toFixed(2)} | ${cell(e.note)} |`,
    )
  const table = [`| ${HEADER.join(' | ')} |`, `| ${HEADER.map(() => '---').join(' | ')} |`, ...rows]
  return table.join('\n') + (sheet.extra ? `\n\n${sheet.extra}` : '') + '\n'
}

export function todayISO(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** YYYY-MM */
export function monthOf(iso: string): string {
  return iso.slice(0, 7)
}

export function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-')
  return `${y} 年 ${Number(m)} 月`
}

export interface MonthStat {
  expense: number
  income: number
  balance: number
  /** 按金额从大到小排的支出分类 */
  byCat: { category: string; amount: number; share: number }[]
  count: number
}

export function monthStat(entries: Entry[], ym: string): MonthStat {
  let expense = 0
  let income = 0
  const cats = new Map<string, number>()
  let count = 0
  for (const e of entries) {
    if (monthOf(e.date) !== ym) continue
    count += 1
    if (e.type === 'income') {
      income += e.amount
    } else {
      expense += e.amount
      cats.set(e.category, (cats.get(e.category) ?? 0) + e.amount)
    }
  }
  const byCat = [...cats.entries()]
    .map(([category, amount]) => ({
      category,
      amount,
      share: expense > 0 ? amount / expense : 0,
    }))
    .sort((a, b) => b.amount - a.amount)
  return { expense, income, balance: income - expense, byCat, count }
}

/** 金额显示：1,234.00 */
export function money(n: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** 按日期分组（日期从新到旧，组内保持插入的倒序） */
export function groupByDate(entries: Entry[]): { date: string; items: Entry[] }[] {
  const map = new Map<string, Entry[]>()
  for (const e of entries) {
    const list = map.get(e.date)
    if (list) list.push(e)
    else map.set(e.date, [e])
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, items]) => ({ date, items: [...items].reverse() }))
}

/** 记账笔记的默认标题：记账 2026-10 */
export function defaultLedgerTitle(ts: number = Date.now()): string {
  const d = new Date(ts)
  return `记账 ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 列表里显示的一句话摘要，代替正文摘要 */
export function ledgerSummary(body: string): string {
  const { entries } = parseLedger(body)
  if (entries.length === 0) return '还没记第一笔'
  const stat = monthStat(entries, monthOf(todayISO()))
  return `本月支出 ¥${money(stat.expense)} · 收入 ¥${money(stat.income)}`
}

/* ---------------- 自己起的分类，记在本地，下次还能选 ---------------- */

const CATS_KEY = 'jianji.ledger.cats.v1'

export function readExtraCats(): Record<EntryType, string[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(CATS_KEY) || '{}') as Partial<
      Record<EntryType, string[]>
    >
    const pick = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    return { expense: pick(raw.expense), income: pick(raw.income) }
  } catch {
    return { expense: [], income: [] }
  }
}

export function writeExtraCats(v: Record<EntryType, string[]>) {
  try {
    localStorage.setItem(CATS_KEY, JSON.stringify(v))
  } catch {
    /* 存不进去只影响下次能不能直接选 */
  }
}
