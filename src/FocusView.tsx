import { useEffect, useMemo, useRef, useState } from 'react'
import type { Note } from './types'
import { DatePicker } from './DatePicker'
import {
  DEFAULT_STEPS,
  type FocusItem,
  type FocusLevel,
  LEVELS,
  MAX_STEPS,
  MIN_STEPS,
  dayHint,
  daysAway,
  focusStat,
  groupByMonth,
  hasDate,
  levelIcon,
  levelLabel,
  monthOf,
  parseFocus,
  progressLabel,
  serializeFocus,
  subDoneCount,
  todayISO,
} from './focus'

type Filter = 'all' | 'open' | 'done' | 'failed'

function clampSteps(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_STEPS
  return Math.max(MIN_STEPS, Math.min(MAX_STEPS, Math.round(n)))
}

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
  const [level, setLevel] = useState<FocusLevel>('important')
  const [memo, setMemo] = useState('')
  const [flash, setFlash] = useState('')
  /** 进度类事项开关 + 共几步 */
  const [byStep, setByStep] = useState(false)
  const [stepsText, setStepsText] = useState(String(DEFAULT_STEPS))
  /** 只看：all | open | done | failed */
  const [filter, setFilter] = useState<Filter>('all')
  /** 收起来的月份（YYYY-MM）；默认全部展开 */
  const [closed, setClosed] = useState<string[]>([])
  const [rawOpen, setRawOpen] = useState(false)
  const [raw, setRaw] = useState(note.body)
  /** 正在给哪一条加子事项 */
  const [subFor, setSubFor] = useState<number | null>(null)
  const [subText, setSubText] = useState('')
  /** 正在给哪一条填失败原因 */
  const [failFor, setFailFor] = useState<number | null>(null)
  const [failText, setFailText] = useState('')
  const titleRef = useRef<HTMLInputElement | null>(null)
  const subRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!rawOpen) setRaw(note.body)
  }, [note.body, rawOpen])

  useEffect(() => {
    if (subFor !== null) subRef.current?.focus()
  }, [subFor])

  const stat = useMemo(() => focusStat(sheet.items), [sheet.items])
  const thisMonth = useMemo(
    () => sheet.items.filter((it) => monthOf(it.date) === monthOf(todayISO())).length,
    [sheet.items],
  )

  const months = useMemo(() => {
    const pick = (f: Filter) =>
      f === 'all'
        ? sheet.items
        : sheet.items.filter((it) => (f === 'done' ? it.status === 'done' : f === 'failed' ? it.status === 'failed' : it.status === 'open'))
    return groupByMonth(pick(filter))
  }, [sheet.items, filter])

  const allClosed = months.length > 0 && months.every((m) => closed.includes(m.ym))

  const segs: [Filter, string][] = [
    ['all', '全部'],
    ['open', `待办 ${stat.open}`],
    ['done', `已完成 ${stat.done}`],
  ]
  if (stat.failed > 0) segs.push(['failed', `失败 ${stat.failed}`])

  const save = (items: FocusItem[]) => {
    onChange(serializeFocus({ items, extra: sheet.extra }))
  }

  const patch = (i: number, next: Partial<FocusItem>) => {
    save(sheet.items.map((it, k) => (k === i ? { ...it, ...next } : it)))
  }

  const add = () => {
    const name = title.trim()
    if (!name) {
      titleRef.current?.focus()
      setFlash('先写个事项')
      window.setTimeout(() => setFlash(''), 1200)
      return
    }
    const steps = byStep ? stepNum : 0
    const item: FocusItem = {
      // 默认不设日期，记下之后想定哪天再点「＋ 日期」
      date: '',
      title: name,
      level,
      status: 'open',
      steps,
      progress: 0,
      subs: [],
      note: memo.trim(),
      reason: '',
    }
    save([...sheet.items, item])
    // 新记的一定在「未设日期」那组，别让它被收起来看不见
    setClosed((prev) => prev.filter((m) => m !== ''))
    setTitle('')
    setMemo('')
    setFlash(steps > 0 ? `已记下 · 进度类 ${steps} 步` : '已记下')
    window.setTimeout(() => setFlash(''), 1400)
    titleRef.current?.focus()
  }

  /** 勾完成 / 取消完成 */
  const toggleDone = (i: number) => {
    const it = sheet.items[i]
    if (it.status === 'done') {
      patch(i, {
        status: 'open',
        progress: it.steps > 0 ? Math.min(it.progress, it.steps - 1) : 0,
      })
    } else {
      patch(i, {
        status: 'done',
        progress: it.steps > 0 ? it.steps : it.progress,
        reason: '',
      })
    }
  }

  /** 点第 n 格：进度走到 n；点当前这一格就等于退回一格 */
  const setStep = (i: number, n: number) => {
    const it = sheet.items[i]
    if (it.steps <= 0) return
    const raw = n === it.progress ? n - 1 : n
    const progress = Math.max(0, Math.min(it.steps, raw))
    const status =
      it.status === 'failed' ? 'failed' : progress >= it.steps ? 'done' : 'open'
    patch(i, { progress, status })
    if (progress >= it.steps && it.status !== 'done') {
      setFlash('全部走完，自动标成已完成')
      window.setTimeout(() => setFlash(''), 1600)
    }
  }

  const addSub = (i: number) => {
    const name = subText.trim()
    if (!name) {
      setSubFor(null)
      return
    }
    patch(i, { subs: [...sheet.items[i].subs, { title: name, done: false }] })
    setSubText('')
  }

  const toggleSub = (i: number, si: number) => {
    patch(i, {
      subs: sheet.items[i].subs.map((s, k) => (k === si ? { ...s, done: !s.done } : s)),
    })
  }

  const removeSub = (i: number, si: number) => {
    patch(i, { subs: sheet.items[i].subs.filter((_, k) => k !== si) })
  }

  const markFailed = (i: number) => {
    patch(i, { status: 'failed', reason: failText.trim() })
    setFailFor(null)
    setFailText('')
  }

  const remove = (i: number) => {
    save(sheet.items.filter((_, k) => k !== i))
    if (subFor === i) setSubFor(null)
    if (failFor === i) setFailFor(null)
  }

  const toggleMonth = (ym: string) => {
    setClosed((prev) => (prev.includes(ym) ? prev.filter((m) => m !== ym) : [...prev, ym]))
  }

  const stepNum = clampSteps(Number(stepsText) || DEFAULT_STEPS)

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
          {stat.failed > 0 && (
            <div className="ld-sum-cell">
              <span className="ld-sum-k">失败</span>
              <b className="fc-failed-num">{stat.failed}</b>
            </div>
          )}
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
          <span className="fc-form-hint">记下后点「＋ 日期」随时定日子</span>
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

        {/* 进度类：默认不是，打开后默认 10 步，可改 */}
        <div className="fc-opts">
          <button
            className={`fc-opt${byStep ? ' on' : ''}`}
            onClick={() => setByStep((v) => !v)}
            title="进度类事项可以一格一格点进度，也能加子事项"
          >
            <span className="fc-opt-box">{byStep ? '✓' : ''}</span>
            进度类事项
          </button>
          {byStep && (
            <span className="fc-steps-pick">
              共
              <button
                className="fc-step-btn"
                title="少一步"
                onClick={() => setStepsText(String(clampSteps(stepNum - 1)))}
              >
                −
              </button>
              <input
                className="fc-steps-num"
                value={stepsText}
                inputMode="numeric"
                aria-label="总步数"
                onChange={(e) => setStepsText(e.target.value.replace(/[^\d]/g, ''))}
                onBlur={() => setStepsText(String(clampSteps(Number(stepsText))))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') add()
                }}
              />
              <button
                className="fc-step-btn"
                title="多一步"
                onClick={() => setStepsText(String(clampSteps(stepNum + 1)))}
              >
                ＋
              </button>
              步
              <span className="fc-steps-hint">填 2–100</span>
            </span>
          )}
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
          {segs.map(([k, label]) => (
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
                      const dated = hasDate(it)
                      const away = dated ? daysAway(it.date) : 0
                      const failed = it.status === 'failed'
                      const done = it.status === 'done'
                      const overdue = it.status === 'open' && dated && away < 0
                      const isStep = it.steps > 0
                      const subDone = subDoneCount(it)
                      return (
                        <div
                          key={`${it.date}-${i}`}
                          className={`fc-item${done ? ' done' : ''}${overdue ? ' overdue' : ''}${
                            failed ? ' failed' : ''
                          }${isStep ? ' has-steps' : ''}`}
                        >
                          <div className="fc-row">
                            <button
                              className="fc-check"
                              title={done ? '标成待办' : '标成已完成'}
                              onClick={() => toggleDone(i)}
                            >
                              {done ? '✓' : ''}
                            </button>
                            <span className="fc-item-main">
                              <span className="fc-item-title">{it.title}</span>
                              {it.note && <span className="ld-item-note">{it.note}</span>}
                            </span>
                            {isStep && (
                              <span
                                className={`fc-prog-num${it.progress >= it.steps ? ' full' : ''}`}
                                title="进度"
                              >
                                {progressLabel(it)}
                              </span>
                            )}
                            {it.subs.length > 0 && (
                              <span className="fc-sub-num" title="子事项">
                                子 {subDone}/{it.subs.length}
                              </span>
                            )}
                            <span className={`fc-level ${it.level}`}>
                              {levelIcon(it.level)} {levelLabel(it.level)}
                            </span>
                            {/* 日期：默认没定，点「＋ 日期」定；定了还能改、能清掉 */}
                            <DatePicker
                              variant="inline"
                              allowClear
                              value={it.date}
                              title={dated ? '改日期' : '给这件事定个日期'}
                              onChange={(iso) => {
                                patch(i, { date: iso })
                                if (iso) setClosed((prev) => prev.filter((m) => m !== monthOf(iso)))
                              }}
                            />
                            {dated && (
                              <span className={`fc-away${overdue ? ' late' : ''}`}>
                                {done ? '已完成' : failed ? '已失败' : dayHint(it.date)}
                              </span>
                            )}
                            <span className="fc-acts">
                              {failed ? (
                                <button
                                  className="fc-undo"
                                  title="撤销失败，回到待办"
                                  onClick={() => patch(i, { status: 'open', reason: '' })}
                                >
                                  撤销
                                </button>
                              ) : (
                                !done && (
                                  <button
                                    className="fc-fail"
                                    title="标成失败并写原因"
                                    onClick={() => {
                                      setFailFor(i)
                                      setFailText('')
                                    }}
                                  >
                                    失败
                                  </button>
                                )
                              )}
                              <button
                                className="ld-item-del"
                                title="删掉这件"
                                onClick={() => remove(i)}
                              >
                                ×
                              </button>
                            </span>
                          </div>

                          {/* 进度格：一格一格点过去 */}
                          {isStep && (
                            <div className="fc-steps" role="group" aria-label="进度">
                              {Array.from({ length: it.steps }, (_, k) => (
                                <button
                                  key={k}
                                  className={`fc-step${k < it.progress ? ' on' : ''}${
                                    k === it.progress - 1 ? ' last' : ''
                                  }`}
                                  data-step={k + 1}
                                  title={`第 ${k + 1} 步（点一下走到这里）`}
                                  onClick={() => setStep(i, k + 1)}
                                />
                              ))}
                              <span className="fc-steps-hint">
                                {it.progress === 0
                                  ? '点第 1 格开始'
                                  : it.progress >= it.steps
                                    ? '已走完'
                                    : `还差 ${it.steps - it.progress} 步`}
                              </span>
                            </div>
                          )}

                          {/* 子事项 */}
                          {(isStep || it.subs.length > 0) && (
                            <div className="fc-subs">
                              {it.subs.map((s, si) => (
                                <div key={`${s.title}-${si}`} className={`fc-sub${s.done ? ' done' : ''}`}>
                                  <button
                                    className="fc-sub-check"
                                    title={s.done ? '标成待完成' : '标成已完成'}
                                    onClick={() => toggleSub(i, si)}
                                  >
                                    {s.done ? '✓' : ''}
                                  </button>
                                  <span className="fc-sub-title">{s.title}</span>
                                  <button
                                    className="fc-sub-del"
                                    title="删掉这个子事项"
                                    onClick={() => removeSub(i, si)}
                                  >
                                    ×
                                  </button>
                                </div>
                              ))}

                              {subFor === i ? (
                                <input
                                  ref={subRef}
                                  className="fc-sub-input"
                                  value={subText}
                                  placeholder="子事项，回车添加（Esc 结束）"
                                  onChange={(e) => setSubText(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault()
                                      addSub(i)
                                    } else if (e.key === 'Escape') {
                                      setSubText('')
                                      setSubFor(null)
                                    }
                                  }}
                                  onBlur={() => {
                                    // 有内容就当加进去，别白输
                                    if (subText.trim()) addSub(i)
                                    else setSubFor(null)
                                  }}
                                />
                              ) : (
                                <button
                                  className="fc-sub-add"
                                  title="加一个子事项"
                                  onClick={() => {
                                    setSubText('')
                                    setSubFor(i)
                                  }}
                                >
                                  ＋ 子事项
                                </button>
                              )}
                            </div>
                          )}

                          {/* 失败原因 */}
                          {failed && (
                            <div className="fc-reason">
                              失败原因：{it.reason || '（没写）'}
                            </div>
                          )}
                          {failFor === i && (
                            <div className="fc-fail-box">
                              <input
                                className="fc-fail-input"
                                autoFocus
                                value={failText}
                                placeholder="为什么失败？回车确认，Esc 取消"
                                onChange={(e) => setFailText(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault()
                                    markFailed(i)
                                  } else if (e.key === 'Escape') {
                                    setFailFor(null)
                                    setFailText('')
                                  }
                                }}
                              />
                              <button className="fc-fail-ok" onClick={() => markFailed(i)}>
                                标成失败
                              </button>
                              <button
                                className="fc-fail-cancel"
                                onClick={() => {
                                  setFailFor(null)
                                  setFailText('')
                                }}
                              >
                                取消
                              </button>
                            </div>
                          )}
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
