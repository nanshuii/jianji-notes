import { useEffect, useMemo, useRef, useState } from 'react'
import type { Note } from './types'
import {
  type FocusItem,
  type FocusLevel,
  LEVELS,
  dateLabel,
  dayHint,
  daysAway,
  focusStat,
  groupByMonth,
  levelIcon,
  levelLabel,
  monthOf,
  parseFocus,
  serializeFocus,
  todayISO,
} from './focus'

/**
 * 重要事项界面：上面是总览，中间「记一件」，下面按月份分组的清单。
 * 数据由父组件通过 onChange 写回笔记正文（Markdown 表格）。
 */
export function FocusView({
  note,
  onChange,
}: {
  note: Note
  onChange: (body: string) => void
}) {
  const sheet = useMemo(() => parseFocus(note.body), [note.body])

  const [title, setTitle] = useState('')
  const [date, setDate] = useState(todayISO)
  const [level, setLevel] = useState<FocusLevel>('important')
  const [memo, setMemo] = useState('')
  const [flash, setFlash] = useState('')
  /** 只看：all | open | done */
  const [filter, setFilter] = useState<'all' | 'open' | 'done'>('all')
  /** 收起来的月份（YYYY-MM）；默认全部展开 */
  const [closed, setClosed] = useState<string[]>([])
  const [rawOpen, setRawOpen] = useState(false)
  const [raw, setRaw] = useState(note.body)
  const titleRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!rawOpen) setRaw(note.body)
  }, [note.body, rawOpen])

  const stat = useMemo(() => focusStat(sheet.items), [sheet.items])
  const thisMonth = useMemo(
    () => sheet.items.filter((it) => monthOf(it.date) === monthOf(todayISO())).length,
    [sheet.items],
  )

  const months = useMemo(() => {
    const picked =
      filter === 'all'
        ? sheet.items
        : sheet.items.filter((it) => (filter === 'done' ? it.done : !it.done))
    return groupByMonth(picked)
  }, [sheet.items, filter])

  const allClosed = months.length > 0 && months.every((m) => closed.includes(m.ym))

  const save = (items: FocusItem[]) => {
    onChange(serializeFocus({ items, extra: sheet.extra }))
  }

  const add = () => {
    const name = title.trim()
    if (!name) {
      titleRef.current?.focus()
      setFlash('先写个事项')
      window.setTimeout(() => setFlash(''), 1200)
      return
    }
    const item: FocusItem = { date, title: name, level, done: false, note: memo.trim() }
    save([...sheet.items, item])
    setClosed((prev) => prev.filter((m) => m !== monthOf(date)))
    setTitle('')
    setMemo('')
    setFlash('已记下')
    window.setTimeout(() => setFlash(''), 1400)
    titleRef.current?.focus()
  }

  const toggleDone = (index: number) => {
    save(sheet.items.map((it, i) => (i === index ? { ...it, done: !it.done } : it)))
  }

  const remove = (index: number) => {
    save(sheet.items.filter((_, i) => i !== index))
  }

  const toggleMonth = (ym: string) => {
    setClosed((prev) => (prev.includes(ym) ? prev.filter((m) => m !== ym) : [...prev, ym]))
  }

  return (
    <div className="ledger focus">
      {/* ---------- 总览 ---------- */}
      <div className="ld-top">
        <div className="ld-month">
          <span>重要事项</span>
          <span className="ld-muted">本月 {thisMonth} 项</span>
        </div>
        <div className="ld-sum">
          <div className="ld-sum-cell">
            <span className="ld-sum-k">共</span>
            <b>{stat.total} 项</b>
          </div>
          <div className="ld-sum-cell">
            <span className="ld-sum-k">待办</span>
            <b className="fc-open">{stat.open}</b>
          </div>
          <div className="ld-sum-cell">
            <span className="ld-sum-k">逾期</span>
            <b className={stat.overdue > 0 ? 'ld-expense' : ''}>{stat.overdue}</b>
          </div>
          <div className="ld-sum-cell">
            <span className="ld-sum-k">7 天内</span>
            <b>{stat.soon}</b>
          </div>
        </div>
      </div>

      {/* ---------- 记一件 ---------- */}
      <div className="ld-form">
        <div className="ld-amount-row">
          <span className="ld-yen">✎</span>
          <input
            ref={titleRef}
            className="fc-title"
            value={title}
            placeholder="要做什么？比如「交房租」"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add()
            }}
          />
          <input
            type="date"
            className="ld-date"
            value={date}
            onChange={(e) => setDate(e.target.value || todayISO())}
          />
        </div>

        <div className="ld-cats">
          {LEVELS.map((l) => (
            <button
              key={l.key}
              className={`ld-chip${level === l.key ? ' on' : ''}`}
              onClick={() => setLevel(l.key)}
            >
              <span className="ld-chip-ico">{l.icon}</span>
              {l.label}
            </button>
          ))}
        </div>

        <div className="ld-memo-row">
          <input
            className="ld-memo"
            value={memo}
            placeholder="备注（可选，比如「房东账号没变」）"
            onChange={(e) => setMemo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add()
            }}
          />
          <button className="ld-add" onClick={add}>
            记一件
          </button>
        </div>
        {flash && <div className="ld-flash">{flash}</div>}
      </div>

      {/* ---------- 筛选 + 全部展开/收起 ---------- */}
      <div className="fc-bar">
        <div className="ld-seg">
          {(
            [
              ['all', '全部'],
              ['open', `待办 ${stat.open}`],
              ['done', `已完成 ${stat.done}`],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
        {months.length > 0 && (
          <button
            className="fc-collapse"
            onClick={() => setClosed(allClosed ? [] : months.map((m) => m.ym))}
          >
            {allClosed ? '全部展开' : '全部收起'}
          </button>
        )}
      </div>

      {/* ---------- 按月份分组 ---------- */}
      <div className="ld-list">
        {months.length === 0 ? (
          <div className="ld-empty">
            {sheet.items.length === 0 ? '还没有重要事项，上面记一件试试' : '这个筛选下没有事项'}
          </div>
        ) : (
          months.map((m) => {
            const open = !closed.includes(m.ym)
            return (
              <div key={m.ym} className={`fc-month${open ? '' : ' closed'}`}>
                <button className="fc-month-head" onClick={() => toggleMonth(m.ym)}>
                  <span className="fc-fold">{open ? '▾' : '▸'}</span>
                  <span className="fc-month-name">{m.label}</span>
                  <span className="ld-muted">
                    {m.items.length} 项{m.open > 0 ? ` · 待办 ${m.open}` : ''}
                  </span>
                </button>
                {open && (
                  <div className="fc-items">
                    {m.items.map((it) => {
                      const i = sheet.items.indexOf(it)
                      const away = daysAway(it.date)
                      const overdue = !it.done && away < 0
                      return (
                        <div
                          key={`${it.date}-${i}`}
                          className={`fc-item${it.done ? ' done' : ''}${overdue ? ' overdue' : ''}`}
                        >
                          <button
                            className="fc-check"
                            title={it.done ? '标成待办' : '标成已完成'}
                            onClick={() => toggleDone(i)}
                          >
                            {it.done ? '✓' : ''}
                          </button>
                          <span className="fc-item-main">
                            <span className="fc-item-title">{it.title}</span>
                            {it.note && <span className="ld-item-note">{it.note}</span>}
                          </span>
                          <span className={`fc-level ${it.level}`}>
                            {levelIcon(it.level)} {levelLabel(it.level)}
                          </span>
                          <span className="fc-item-date">{dateLabel(it.date)}</span>
                          <span className={`fc-away${overdue ? ' late' : ''}`}>
                            {it.done ? '已完成' : dayHint(it.date)}
                          </span>
                          <button className="ld-item-del" title="删掉这件" onClick={() => remove(i)}>
                            ×
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
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
