import { useEffect, useMemo, useRef, useState } from 'react'
import { dateLabel, monthTitle, todayISO } from './focus'

const WEEK = ['一', '二', '三', '四', '五', '六', '日']

const QUICK: { label: string; n: number }[] = [
  { label: '今天', n: 0 },
  { label: '明天', n: 1 },
  { label: '后天', n: 2 },
  { label: '一周后', n: 7 },
]

const pad = (n: number) => String(n).padStart(2, '0')

function shift(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const t = new Date(y, m - 1, d)
  t.setDate(t.getDate() + days)
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

/** 没定日期时（value 为空）日历就先看当月 */
function monthOfValue(value: string, fallback: string): string {
  return /^\d{4}-\d{2}/.test(value) ? value.slice(0, 7) : fallback.slice(0, 7)
}

/**
 * 自己的日期选择器。
 *
 * 系统自带的 `<input type="date">` 在 WKWebView 里是三个上下搓的滚轮，
 * 点起来又慢又容易点错，所以在它旁边换成了「点开就是一个月历」：
 * 点日期 → 弹日历 → 点哪天就是哪天；下面还有今天/明天/后天/一周后。
 * 想手打的也能直接敲 2026-10-21、10-21、21。
 *
 * 两种样子：
 * - `variant='field'`（默认）：带输入框那一版，记账那边的表单用
 * - `variant='inline'`：事项列表里那一个小小的日期按钮，点开改日期
 */
export function DatePicker({
  value,
  onChange,
  title = '选择日期',
  variant = 'field',
  allowClear = false,
  emptyLabel = '＋ 日期',
}: {
  value: string
  onChange: (iso: string) => void
  title?: string
  variant?: 'field' | 'inline'
  allowClear?: boolean
  emptyLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const today = todayISO()
  /** 日历正在看哪个月 */
  const [ym, setYm] = useState(() => monthOfValue(value, today))
  /** 输入框里的文本（允许手打） */
  const [text, setText] = useState(value)
  const box = useRef<HTMLDivElement | null>(null)

  const openAt = (iso: string) => {
    setYm(monthOfValue(iso, today))
    setOpen((v) => !v)
  }

  // 外面改了日期（比如「回到本月」），同步回来
  useEffect(() => {
    setText(value)
    if (!open) setYm(monthOfValue(value, today))
  }, [value, open, today])

  useEffect(() => {
    if (!open) return

    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const cells = useMemo(() => {
    const [y, m] = ym.split('-').map(Number)
    const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7 // 周一打头
    const days = new Date(y, m, 0).getDate()
    const out: (string | null)[] = new Array(lead).fill(null)
    for (let d = 1; d <= days; d += 1) out.push(`${y}-${pad(m)}-${pad(d)}`)
    return out
  }, [ym])

  const pick = (iso: string) => {
    onChange(iso)
    setText(iso)
    setOpen(false)
  }

  const clear = () => {
    onChange('')
    setText('')
    setOpen(false)
  }

  const commitText = () => {
    const raw = text.trim()
    if (!raw || raw === value) {
      setText(value)
      return
    }
    const [y, m] = (value || today).split('-').map(Number)
    const norm = raw.replace(/[./年月]/g, '-').replace(/日/g, '')
    let iso = ''
    let mt = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(norm)
    if (mt) iso = `${mt[1]}-${pad(Number(mt[2]))}-${pad(Number(mt[3]))}`
    else if ((mt = /^(\d{4})(\d{2})(\d{2})$/.exec(norm))) iso = `${mt[1]}-${mt[2]}-${mt[3]}`
    else if ((mt = /^(\d{1,2})-(\d{1,2})$/.exec(norm))) iso = `${y}-${pad(Number(mt[1]))}-${pad(Number(mt[2]))}`
    else if ((mt = /^(\d{1,2})$/.exec(norm))) iso = `${y}-${pad(m)}-${pad(Number(mt[1]))}`

    // 校验是不是真实存在的日子（防 2026-02-31）
    const [yy, mm, dd] = iso.split('-').map(Number)
    const ok =
      !!iso &&
      mm >= 1 &&
      mm <= 12 &&
      dd >= 1 &&
      dd <= new Date(yy, mm, 0).getDate()

    if (ok) {
      onChange(iso)
      setText(iso)
      setYm(iso.slice(0, 7))
    } else {
      setText(value)
    }
  }

  const isToday = value === today

  const popup = (
    <div
      className="dp-pop"
      role="dialog"
      aria-label="选择日期"
      // 点在日历里不该让输入框失焦（否则会先 commit 再关掉，点不中那天）
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="dp-head">
        <button
          className="dp-nav"
          data-dir="prev"
          title="上个月"
          onClick={() => setYm(shiftMonth(ym, -1))}
        >
          ‹
        </button>
        <span className="dp-month-label">{monthTitle(ym)}</span>
        <button
          className="dp-nav"
          data-dir="next"
          title="下个月"
          onClick={() => setYm(shiftMonth(ym, 1))}
        >
          ›
        </button>
      </div>

      <div className="dp-week">
        {WEEK.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>

      <div className="dp-grid">
        {cells.map((iso, i) =>
          iso ? (
            <button
              key={iso}
              className={`dp-day${iso === value ? ' on' : ''}${iso === today ? ' today' : ''}`}
              data-date={iso}
              onClick={() => pick(iso)}
              title={iso}
            >
              {Number(iso.slice(8))}
            </button>
          ) : (
            <span key={`b${i}`} className="dp-day blank" />
          ),
        )}
      </div>

      <div className="dp-quick">
        {QUICK.map((q) => (
          <button key={q.label} onClick={() => pick(shift(today, q.n))}>
            {q.label}
          </button>
        ))}
        {allowClear && value && (
          <button className="dp-clear" title="不设日期" onClick={clear}>
            不设日期
          </button>
        )}
      </div>
    </div>
  )

  if (variant === 'inline') {
    return (
      <div className="dp inline" ref={box}>
        <button
          className={`dp-trigger${open ? ' on' : ''}${value ? '' : ' none'}`}
          title={title}
          aria-label={title}
          onClick={() => openAt(value || today)}
        >
          {value ? (
            <span className="dp-trigger-text">{dateLabel(value)}</span>
          ) : (
            <span className="dp-trigger-none">{emptyLabel}</span>
          )}
          <span className="dp-caret">▾</span>
        </button>
        {open && popup}
      </div>
    )
  }

  return (
    <div className="dp" ref={box}>
      <div className={`dp-field${open ? ' on' : ''}`}>
        <button
          className="dp-ico"
          title={title}
          aria-label={title}
          onClick={() => openAt(value || today)}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2" y="3" width="12" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M2 6.5h12M5.5 2v2.4M10.5 2v2.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
        <input
          className="dp-text"
          value={text}
          spellCheck={false}
          title="也可以直接输入，比如 2026-10-21 / 10-21 / 21"
          onChange={(e) => setText(e.target.value)}
          onFocus={() => {
            setYm(monthOfValue(value, today))
            setOpen(true)
          }}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitText()
              setOpen(false)
            } else if (e.key === 'Escape') {
              setText(value)
              setOpen(false)
            }
          }}
        />
        {isToday && <span className="dp-now">今天</span>}
        <button
          className="dp-caret"
          title={title}
          aria-label={title}
          onClick={() => openAt(value || today)}
        >
          ▾
        </button>
      </div>

      {open && popup}
    </div>
  )
}
