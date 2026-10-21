import { useEffect, useMemo, useRef, useState } from 'react'
import type { Note } from './types'
import { DatePicker } from './DatePicker'
import {
  type Entry,
  type EntryType,
  EXPENSE_CATS,
  INCOME_CATS,
  catIcon,
  groupByDate,
  money,
  monthLabel,
  monthOf,
  monthStat,
  parseLedger,
  readExtraCats,
  serializeLedger,
  shiftMonth,
  todayISO,
  writeExtraCats,
} from './ledger'

/**
 * 记账界面：上面是当月汇总，中间「记一笔」，下面分类占比 + 流水。
 * 数据由父组件通过 onChange 写回笔记正文（Markdown 表格）。
 */
export function LedgerView({
  note,
  onChange,
}: {
  note: Note
  onChange: (body: string) => void
}) {
  const sheet = useMemo(() => parseLedger(note.body), [note.body])

  // 打开时先看「最近一笔所在的月份」，没记过就看当前月
  const [ym, setYm] = useState(() => {
    const latest = sheet.entries.reduce((acc, e) => (e.date > acc ? e.date : acc), '')
    return monthOf(latest || todayISO())
  })

  const [type, setType] = useState<EntryType>('expense')
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState(EXPENSE_CATS[0])
  const [date, setDate] = useState(todayISO())
  const [memo, setMemo] = useState('')
  const [extraCats, setExtraCats] = useState<Record<EntryType, string[]>>(readExtraCats)
  const [catOpen, setCatOpen] = useState(false)
  const [catText, setCatText] = useState('')
  const [rawOpen, setRawOpen] = useState(false)
  const [raw, setRaw] = useState(note.body)
  const [flash, setFlash] = useState('')
  /** 收起来的日期（YYYY-MM-DD）；默认全部展开 */
  const [closed, setClosed] = useState<string[]>([])

  const amountRef = useRef<HTMLInputElement | null>(null)

  // 分类 = 预设 + 自己起的 + 这篇里已经用过的
  const cats = useMemo(() => {
    const base = type === 'expense' ? EXPENSE_CATS : INCOME_CATS
    const used = sheet.entries.filter((e) => e.type === type).map((e) => e.category)
    return [...new Set([...base, ...extraCats[type], ...used])]
  }, [type, extraCats, sheet.entries])
  const stat = monthStat(sheet.entries, ym)

  // 分类被删掉之类的情况下回退到第一个
  useEffect(() => {
    if (!cats.includes(category)) setCategory(cats[0])
  }, [cats, category])

  useEffect(() => {
    if (!rawOpen) setRaw(note.body)
  }, [note.body, rawOpen])

  const save = (entries: Entry[]) => {
    onChange(serializeLedger({ entries, extra: sheet.extra }))
  }

  const add = () => {
    const n = Number.parseFloat(amount.replace(/[^\d.]/g, ''))
    if (!Number.isFinite(n) || n <= 0) {
      amountRef.current?.focus()
      setFlash('先填个金额')
      window.setTimeout(() => setFlash(''), 1200)
      return
    }
    const entry: Entry = {
      date,
      type,
      category: category.trim() || '其他',
      amount: Math.round(n * 100) / 100,
      note: memo.trim(),
    }
    save([...sheet.entries, entry])
    setAmount('')
    setMemo('')
    setYm(monthOf(date))
    setClosed((prev) => prev.filter((d) => d !== date)) // 记的这天要是收着的，展开它
    setFlash(`已记下 ${type === 'expense' ? '支出' : '收入'} ¥${money(entry.amount)}`)
    window.setTimeout(() => setFlash(''), 1600)
    amountRef.current?.focus()
  }

  const remove = (index: number) => {
    save(sheet.entries.filter((_, i) => i !== index))
  }

  // 当月流水：按日期分组，同一天里后记的排前面
  const groups = useMemo(() => {
    const rows = sheet.entries
      .map((e, i) => ({ e, i }))
      .filter((r) => monthOf(r.e.date) === ym)
    const sorted = rows.sort((a, b) => (a.e.date < b.e.date ? 1 : a.e.date > b.e.date ? -1 : 0))
    return groupByDate(sorted.map((r) => r.e)).map((g) => ({
      date: g.date,
      items: g.items.map((e) => ({ e, i: sheet.entries.indexOf(e) })),
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet.entries, ym])

  const weekday = (iso: string) => {
    const d = new Date(`${iso}T00:00:00`)
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  }

  const isThisMonth = ym === monthOf(todayISO())

  // 全部收起 / 全部展开：只影响当前这个月的分组
  const allClosed = groups.length > 0 && groups.every((g) => closed.includes(g.date))
  const toggleDay = (d: string) =>
    setClosed((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]))

  const daySum = (items: Entry[]) => {
    let out = 0
    let in_ = 0
    for (const e of items) {
      if (e.type === 'income') in_ += e.amount
      else out += e.amount
    }
    return (
      <>
        {out > 0 && <span className="ld-expense">-¥{money(out)}</span>}
        {out > 0 && in_ > 0 && ' '}
        {in_ > 0 && <span className="ld-income">+¥{money(in_)}</span>}
      </>
    )
  }

  return (
    <div className="ledger">
      {/* ---------- 月份 + 汇总 ---------- */}
      <div className="ld-top">
        <div className="ld-month">
          <button onClick={() => setYm(shiftMonth(ym, -1))} title="上个月" aria-label="上个月">
            ‹
          </button>
          <span>{monthLabel(ym)}</span>
          <button onClick={() => setYm(shiftMonth(ym, 1))} title="下个月" aria-label="下个月">
            ›
          </button>
          {!isThisMonth && (
            <button className="ld-today" onClick={() => setYm(monthOf(todayISO()))}>
              回到本月
            </button>
          )}
        </div>

        <div className="ld-sum">
          <div className="ld-sum-cell">
            <span className="ld-sum-k">支出</span>
            <b className="ld-expense">¥{money(stat.expense)}</b>
          </div>
          <div className="ld-sum-cell">
            <span className="ld-sum-k">收入</span>
            <b className="ld-income">¥{money(stat.income)}</b>
          </div>
          <div className="ld-sum-cell">
            <span className="ld-sum-k">结余</span>
            <b className={stat.balance < 0 ? 'ld-expense' : ''}>¥{money(stat.balance)}</b>
          </div>
        </div>
      </div>

      {/* ---------- 记一笔 ---------- */}
      <div className="ld-form">
        <div className="ld-seg">
          <button
            className={type === 'expense' ? 'on' : ''}
            onClick={() => {
              setType('expense')
              setCatOpen(false)
              setCategory(EXPENSE_CATS[0])
            }}
          >
            支出
          </button>
          <button
            className={type === 'income' ? 'on' : ''}
            onClick={() => {
              setType('income')
              setCatOpen(false)
              setCategory(INCOME_CATS[0])
            }}
          >
            收入
          </button>
        </div>

        <div className="ld-amount-row">
          <span className="ld-yen">¥</span>
          <input
            ref={amountRef}
            className="ld-amount"
            value={amount}
            placeholder="0.00"
            inputMode="decimal"
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add()
            }}
          />
          <DatePicker value={date} onChange={setDate} title="这笔是哪天的" />
        </div>

        <div className="ld-cats">
          {cats.map((c) => (
            <button
              key={c}
              className={`ld-chip${category === c ? ' on' : ''}`}
              onClick={() => {
                setCategory(c)
                setCatOpen(false)
              }}
            >
              <span className="ld-chip-ico">{catIcon(c)}</span>
              {c}
            </button>
          ))}
          {catOpen ? (
            <input
              className="ld-chip-input"
              autoFocus
              value={catText}
              placeholder="分类名，回车确认"
              onChange={(e) => setCatText(e.target.value)}
              onBlur={() => {
                if (!catText.trim()) setCatOpen(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const name = catText.trim()
                  if (name) {
                    const next = {
                      ...extraCats,
                      [type]: [...new Set([...extraCats[type], name])],
                    }
                    setExtraCats(next)
                    writeExtraCats(next)
                    setCategory(name)
                  }
                  setCatText('')
                  setCatOpen(false)
                } else if (e.key === 'Escape') {
                  setCatText('')
                  setCatOpen(false)
                }
              }}
            />
          ) : (
            <button className="ld-chip ghost" title="自定义分类" onClick={() => setCatOpen(true)}>
              ＋ 自定义
            </button>
          )}
        </div>

        <div className="ld-memo-row">
          <input
            className="ld-memo"
            value={memo}
            placeholder="备注（可选，比如「和同事吃面」）"
            onChange={(e) => setMemo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add()
            }}
          />
          <button className="ld-add" onClick={add}>
            记一笔
          </button>
        </div>
        {flash && <div className="ld-flash">{flash}</div>}
      </div>

      {/* ---------- 分类占比 ---------- */}
      {stat.byCat.length > 0 && (
        <div className="ld-bars">
          <div className="ld-bars-head">
            <span>花在哪了</span>
            <span className="ld-muted">共 {stat.count} 笔</span>
          </div>
          {stat.byCat.map((c) => (
            <div key={c.category} className="ld-bar-row">
              <span className="ld-bar-name">
                {catIcon(c.category)} {c.category}
              </span>
              <span className="ld-bar-track">
                <i style={{ width: `${Math.max(2, Math.round(c.share * 100))}%` }} />
              </span>
              <span className="ld-bar-amt">¥{money(c.amount)}</span>
              <span className="ld-bar-pct">{Math.round(c.share * 100)}%</span>
            </div>
          ))}
        </div>
      )}

      {/* ---------- 流水 ---------- */}
      <div className="ld-list">
        {groups.length > 0 && (
          <div className="ld-list-bar">
            <span className="ld-muted">共 {stat.count} 笔</span>
            <button
              className="ld-collapse"
              onClick={() => setClosed(allClosed ? [] : groups.map((g) => g.date))}
            >
              {allClosed ? '全部展开' : '全部收起'}
            </button>
          </div>
        )}
        {groups.length === 0 ? (
          <div className="ld-empty">
            {stat.count === 0 ? '这个月还没有记录，上面记一笔试试' : '这个月没有记录'}
          </div>
        ) : (
          groups.map((g) => {
            const open = !closed.includes(g.date)
            return (
              <div key={g.date} className={`ld-day${open ? '' : ' closed'}`}>
                <button
                  className="ld-day-head"
                  onClick={() => toggleDay(g.date)}
                  title={open ? '收起这一天' : '展开这一天'}
                >
                  <span className="ld-fold">{open ? '▾' : '▸'}</span>
                  <span>{g.date}</span>
                  <span className="ld-muted">{weekday(g.date)}</span>
                  <span className="ld-day-sum">{daySum(g.items.map((x) => x.e))}</span>
                </button>
                {open &&
                  g.items.map(({ e, i }) => (
                    <div key={`${e.date}-${i}`} className="ld-item">
                      <span className="ld-item-ico">{catIcon(e.category)}</span>
                      <span className="ld-item-main">
                        <span className="ld-item-cat">{e.category}</span>
                        {e.note && <span className="ld-item-note">{e.note}</span>}
                      </span>
                      <span className={`ld-item-amt ${e.type}`}>
                        {e.type === 'expense' ? '-' : '+'}¥{money(e.amount)}
                      </span>
                      <button className="ld-item-del" title="删掉这笔" onClick={() => remove(i)}>
                        ×
                      </button>
                    </div>
                  ))}
              </div>
            )
          })
        )}
      </div>

      {/* ---------- 原文 ---------- */}
      <div className="ld-raw">
        <button className="ld-raw-toggle" onClick={() => setRawOpen((v) => !v)}>
          {rawOpen ? '收起原始 Markdown' : '查看 / 编辑原始 Markdown'}
        </button>
        {rawOpen && (
          <>
            <textarea
              className="ld-raw-box"
              value={raw}
              spellCheck={false}
              onChange={(e) => setRaw(e.target.value)}
            />
            <div className="ld-raw-actions">
              <button
                onClick={() => {
                  setRaw(note.body)
                  setRawOpen(false)
                }}
              >
                取消
              </button>
              <button
                className="primary"
                onClick={() => {
                  onChange(raw.endsWith('\n') ? raw : `${raw}\n`)
                  setRawOpen(false)
                }}
              >
                保存
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
