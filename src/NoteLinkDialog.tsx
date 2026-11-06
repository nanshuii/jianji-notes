import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { noteLines } from './notelink'

export interface NoteOption {
  file: string
  title: string
  body: string
  ledger?: boolean
  focus?: boolean
}

interface Props {
  notes: NoteOption[]
  currentFile?: string
  /** 编辑器里选中的文字，用作链接上显示的文字 */
  selectedText: string
  /** 光标/选区已经落在一条链接上时可以移除 */
  hasLink: boolean
  onConfirm: (file: string, text: string, label: string) => void
  onRemove: () => void
  onClose: () => void
}

/** 选中一段文字后，挑「哪篇笔记的哪一行」生成笔记内链接 */
export function NoteLinkDialog({
  notes, currentFile, selectedText, hasLink, onConfirm, onRemove, onClose,
}: Props) {
  // 记账 / 重要事项走的是专用界面，正文是表格，没法按行定位
  const candidates = useMemo(
    () => notes.filter((n) => !n.ledger && !n.focus && n.file !== currentFile),
    [notes, currentFile],
  )
  const [query, setQuery] = useState('')
  const [file, setFile] = useState(candidates[0]?.file ?? '')
  const [text, setText] = useState('')
  const [label, setLabel] = useState(selectedText || candidates[0]?.title || '')

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? candidates.filter((n) => `${n.title} ${n.file}`.toLowerCase().includes(q)) : candidates
  }, [candidates, query])

  const active = candidates.find((n) => n.file === file)
  const lines = useMemo(() => noteLines(active?.body ?? ''), [active?.body])

  // 换笔记时把选中行清掉，免得把上一篇的指纹带过去
  useEffect(() => { setText('') }, [file])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const pickLine = (t: string, short: string) => {
    setText(t)
    if (!selectedText && !label) setLabel(short)
  }

  return createPortal(
    <div className="notelink-mask" onMouseDown={onClose}>
      <div
        className="notelink-dialog"
        role="dialog"
        aria-label="链接到另一篇笔记"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="notelink-head">
          <div>
            <h3>链接到笔记里的某一行</h3>
            <p>选目标笔记 → 再选要跳过去的那一行</p>
          </div>
          <button type="button" className="notelink-x" title="关闭（Esc）" onClick={onClose}>×</button>
        </div>

        <div className="notelink-cols">
          <div className="notelink-col">
            <div className="notelink-col-title">笔记</div>
            <input
              className="notelink-search"
              placeholder="搜笔记名…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="notelink-list">
              {shown.length === 0 && <div className="notelink-empty">没有匹配的笔记</div>}
              {shown.map((n) => (
                <button
                  type="button"
                  key={n.file}
                  className={`notelink-item${n.file === file ? ' on' : ''}`}
                  onClick={() => setFile(n.file)}
                  title={n.file}
                >
                  <b>{n.title}</b><small>{n.file}</small>
                </button>
              ))}
            </div>
          </div>

          <div className="notelink-col">
            <div className="notelink-col-title">跳到这一行</div>
            <div className="notelink-list notelink-lines">
              {!active && <div className="notelink-empty">先选一篇笔记</div>}
              {active && lines.length === 0 && <div className="notelink-empty">这篇笔记还是空的</div>}
              {active && lines.map((l, i) => (
                <button
                  type="button"
                  key={`${i}-${l.text}`}
                  className={`notelink-item notelink-line${text === l.text ? ' on' : ''}${l.kind === 'heading' ? ' heading' : ''}`}
                  onClick={() => pickLine(l.text, l.label)}
                  title={l.text}
                >
                  {l.kind === 'heading' && <span className="notelink-tag">标题</span>}
                  {l.kind === 'list' && <span className="notelink-tag">列表</span>}
                  {l.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="notelink-foot">
          <label className="notelink-label">
            链接文字
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="链接上显示什么字" />
          </label>
          <div className="notelink-acts">
            {hasLink && (
              <button type="button" className="notelink-remove" onClick={onRemove}>移除链接</button>
            )}
            <button type="button" onClick={onClose}>取消</button>
            <button
              type="button"
              className="primary"
              disabled={!file || !text || !label.trim()}
              onClick={() => onConfirm(file, text, label.trim())}
            >
              插入链接
            </button>
          </div>
        </div>
        <p className="notelink-tip">
          链接记住的是这一行的文字，不是行号 —— 以后在它上面加内容也不会串位；用别的编辑器打开，它仍是一条普通 Markdown 链接。
        </p>
      </div>
    </div>,
    document.body,
  )
}
