/**
 * 笔记里的网页：把一份 .html 直接嵌进正文里显示。
 *
 * - 拖进来 / 粘贴 / 点工具栏「HTML」选文件都能插入
 * - 默认「融入正文」：无外框、高度跟着内容长、整篇随笔记一起滚，前后照常写字
 * - 随时可以切回「卡片」：固定高度、可拖可调、可缩放；旧笔记默认按卡片打开
 * - 两种模式里都是真的网页（iframe），脚本、按钮、图表、锚点照常能用
 * - 正文里只留一行元信息，网页文件存在 笔记目录/.assets/
 */
import { Node, mergeAttributes } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'
import { NodeSelection } from '@tiptap/pm/state'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { backupName, editStyleText, isInteractive, serializeDoc } from './htmledit'
import { getStorage } from './storage'
import {
  DEFAULT_HEIGHT,
  DEFAULT_MODE,
  DEFAULT_ZOOM,
  INLINE_MAX_HEIGHT,
  INSERT_MODE,
  MAX_HEIGHT,
  MAX_ZOOM,
  MIN_FIT_HEIGHT,
  MIN_HEIGHT,
  MIN_ZOOM,
  ZOOM_STEP,
  clampFit,
  clampZoom,
  embedMode,
  humanSize,
  makeAssetName,
  titleOf,
  type EmbedMode,
} from './embed'

/**
 * 允许脚本、表单、弹窗：生成出来的网页往往靠内联 JS 画图表。
 * 这些文件是用户自己拖进来的本地文件，按可信内容处理（关掉脚本很多页面会白屏）。
 */
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals'

/**
 * 量一份网页真正需要多高（不插进正文，先在看不见的 iframe 里排一遍）。
 *
 * 目的只有一个：插入的那一刻就按最终高度摆好，正文文字只被推一次，
 * 而不是先按占位高度挤进来、再一截一截往上顶（那就是「抖」的来源）。
 */
export function measureHtmlInPage(html: string, width: number): Promise<number> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', SANDBOX)
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    frame.style.cssText = [
      'position:fixed',
      'left:-99999px',
      'top:0',
      `width:${Math.max(320, Math.round(width))}px`,
      'height:1200px',
      'border:0',
      'visibility:hidden',
      'pointer-events:none',
    ].join(';')
    let done = false
    const finish = (h: number) => {
      if (done) return
      done = true
      frame.remove()
      resolve(h)
    }
    const read = () => {
      const doc = frame.contentDocument
      if (!doc?.body) return 0
      const win = doc.defaultView
      let h = 0
      for (const el of Array.from(doc.body.children)) {
        const st = win?.getComputedStyle(el)
        if (!st || st.display === 'none' || st.position === 'fixed') continue
        const r = el.getBoundingClientRect()
        if (r.height > 0 || r.bottom > 0) h = Math.max(h, r.bottom)
      }
      if (!h) h = doc.body.scrollHeight
      const pad = Number.parseFloat(win?.getComputedStyle(doc.body).paddingBottom ?? '0') || 0
      return Math.round(h + pad + 2)
    }
    // 排完再量：字体、表格、脚本画的图都在 load 之后才定稿
    const measureSoon = () => {
      // 量的时候把滚动条藏掉：占位 iframe 只有 1200 高，页面会溢出、右侧多出一条滚动条，
      // 可用宽度就比正式显示时窄十几像素 —— 排出来的高度会偏高，插进去还要再缩一下（就抖了）
      try {
        const doc = frame.contentDocument
        if (doc?.documentElement) doc.documentElement.style.overflowY = 'hidden'
      } catch {
        /* 跨域就按原样量 */
      }
      window.setTimeout(() => {
        const a = read()
        window.setTimeout(() => {
          const b = read()
          // 两次一致才算稳定，不一致就再等一帧
          finish(Math.abs(a - b) > 1 ? b : a)
        }, 120)
      }, 160)
    }
    frame.addEventListener('load', measureSoon)
    frame.srcdoc = html
    document.body.appendChild(frame)
    // 页面里有卡住的资源也不能一直等：1.6 秒后按当时量到的收工
    window.setTimeout(() => finish(read()), 1600)
  })
}

/** 融入正文铺开的网页可以很长，INLINE_MAX_HEIGHT 是防异常页面（比如带 100vh 元素）的上限 */

/**
 * srcDoc iframe 的 base URL 继承自父文档，页面里的 href="#id" 会被解析成「父页面 URL + #id」。
 * 点一下等于让 iframe 导航到父页面：卡片内容整块白掉，甚至套一层应用首页。
 * 这里在 iframe 文档上用捕获阶段拦下锚点点击，改成滚动，用户的 HTML 一个字不改。
 * - 卡片模式：滚 iframe 内部
 * - 融入模式：iframe 已经跟内容一样高、内部滚不动，改成滚笔记正文
 * WeakMap 按文档去重（刷新后是新文档，会自然重新注入），文档销毁时监听随之回收。
 */
const anchorCleanups = new WeakMap<Document, () => void>()
function attachAnchors(frame: HTMLIFrameElement, inline = false) {
  const doc = frame.contentDocument
  if (!doc) return
  // 切换呈现模式时 iframe 不会重载，先把旧监听摘掉再按新模式挂
  anchorCleanups.get(doc)?.()
  const onClick = (ev: MouseEvent) => {
    // 普通左键才接管；⌘/Ctrl/Shift 点击、页面自己已处理过的都放行
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return
    const el = ev.target as Element | null
    const a = el?.closest?.('a[href^="#"]') as HTMLAnchorElement | null
    if (!a || (a.target && a.target !== '_self')) return
    let id = (a.getAttribute('href') ?? '').slice(1)
    try { id = decodeURIComponent(id) } catch { /* 编码不合法就按原值找 */ }
    // 目标找不到也要拦：放过去同样会把 iframe 导航出去
    ev.preventDefault()
    if (!id) {
      if (inline) scrollOuter(frame, frame.getBoundingClientRect().top - 24)
      else doc.defaultView?.scrollTo({ top: 0 })
      return
    }
    const target = doc.getElementById(id) ?? doc.querySelector(`[name="${CSS.escape(id)}"]`)
    if (!target) return
    if (inline) {
      // target 在 iframe 里的位置 + iframe 在页面里的位置 = 要滚多少
      const top = frame.getBoundingClientRect().top + target.getBoundingClientRect().top
      scrollOuter(frame, top - 24)
    } else {
      target.scrollIntoView({ block: 'start' })
    }
  }
  doc.addEventListener('click', onClick, true)
  anchorCleanups.set(doc, () => doc.removeEventListener('click', onClick, true))
}

/** 融入模式下锚点要滚的是笔记的滚动容器（不是 iframe 内部） */
function scrollOuter(frame: HTMLIFrameElement, top: number) {
  const outer = outerScroller(frame.parentElement)
  if (outer) outer.scrollBy({ top, behavior: 'smooth' })
  else window.scrollBy({ top, behavior: 'smooth' })
}

/**
 * 找卡片外面的滚动容器：鼠标在网页里滚到底还想接着往下滚时，把滚动接力给它。
 * 从卡片往上找第一个「真的能滚」的元素，找不到就用整页。
 */
function outerScroller(from: HTMLElement | null): HTMLElement | null {
  let n = from?.parentElement ?? null
  while (n) {
    const style = getComputedStyle(n)
    if (/(auto|scroll)/.test(style.overflowY) && n.scrollHeight > n.clientHeight + 1) return n
    n = n.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) ?? null
}

export const HtmlEmbed = Node.create({
  name: 'htmlEmbed',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      file: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-file') ?? '',
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-file': attrs.file }),
      },
      title: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-title') ?? '',
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-title': attrs.title }),
      },
      height: {
        default: DEFAULT_HEIGHT,
        parseHTML: (el: HTMLElement) => Number(el.getAttribute('data-height')) || DEFAULT_HEIGHT,
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-height': attrs.height }),
      },
      zoom: {
        default: DEFAULT_ZOOM,
        parseHTML: (el: HTMLElement) => clampZoom(el.getAttribute('data-zoom')),
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-zoom': attrs.zoom }),
      },
      mode: {
        default: DEFAULT_MODE,
        parseHTML: (el: HTMLElement) => embedMode(el.getAttribute('data-mode')),
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-mode': attrs.mode }),
      },
      /**
       * 融入模式量到的网页高度。存进笔记里，下次打开一上来就是这个高度，
       * 正文不会被「先按占位高度排一遍、再撑开」推着抖一下。
       */
      fit: {
        default: 0,
        parseHTML: (el: HTMLElement) => clampFit(el.getAttribute('data-fit')),
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-fit': attrs.fit }),
      },
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-html-embed]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-html-embed': '' })]
  },
  addNodeView() {
    return ReactNodeViewRenderer(HtmlCard)
  },
})

/** 正文里现在有几张网页卡片 */
function embedCount(editor: Editor): number {
  let n = 0
  editor.state.doc.descendants((child) => {
    if (child.type.name === 'htmlEmbed') n++
  })
  return n
}

/**
 * 融入正文的网页实际有多宽：正文宽度 + 纸张左右留白 ×2。
 * 融入模式用负边距把两边的留白抵掉，所以宽度比正文框宽一圈；
 * 量高时必须用这个宽度，否则量出来偏高，插进去还要再缩一下（就是那一下「抖」）。
 */
function inlineFrameWidth(editor: Editor): number {
  const el = editor.view.dom as HTMLElement
  // 正文里已经有一张融入卡片，直接量它，最准
  const live = el.querySelector('.html-card.inline') as HTMLElement | null
  if (live) {
    const w = live.getBoundingClientRect().width
    if (w > 200) return w
  }
  const padX = Number.parseFloat(getComputedStyle(el).getPropertyValue('--paper-pad-x'))
  const pad = Number.isFinite(padX) ? padX : 0
  return el.clientWidth + pad * 2
}

/**
 * 把一段 HTML 存成附件并插进正文；at 是落点（拖拽时按鼠标位置插）。
 *
 * 这里不靠 focus 决定落点 —— 桌面端拖文件时窗口本身没聚焦，focus 那条路会
 * 悄悄失败，结果文件写进 .assets 了、正文里却什么都没有。改成直接算位置 +
 * insertContentAt，插完再验一次，没落地就退到「追加到末尾」并报错。
 */

export async function insertHtmlEmbed(
  editor: Editor,
  html: string,
  fileName: string,
  at?: number,
): Promise<{ file: string; title: string; height: number; mode: EmbedMode; fit: number }> {
  // 先在看不见的 iframe 里排一遍，量出这份网页真正多高。
  // 插进去时直接就是这个高度，正文文字只被推一次，不会「先挤进来再一截截撑开」。
  let fit = 0
  try {
    fit = clampFit(await measureHtmlInPage(html, inlineFrameWidth(editor)))
  } catch {
    /* 量不出来就按默认高度进来，后面的自动高度会补上 */
  }
  const file = await getStorage().saveAsset(makeAssetName(), html)
  // 新插入的网页默认「融入正文」：不再是一个带外框的小卡片
  const attrs = {
    file,
    title: titleOf(fileName),
    height: DEFAULT_HEIGHT,
    zoom: DEFAULT_ZOOM,
    mode: INSERT_MODE,
    fit,
  }
  // 后面补一个空段落：不然卡片落在正文末尾时，光标没地方落脚没法接着写
  const nodes = [{ type: 'htmlEmbed', attrs }, { type: 'paragraph' }]
  const before = embedCount(editor)
  const doc = editor.state.doc
  const sel = editor.state.selection
  const end = doc.content.size

  // 落点：拖拽按鼠标位置；选中别的卡片时插到它后面（免得把它替换掉）；否则按光标
  let pos = typeof at === 'number' && Number.isFinite(at) ? at : sel.to
  if (sel instanceof NodeSelection && typeof at !== 'number') pos = sel.to
  pos = Math.max(0, Math.min(Math.round(pos), end))

  const put = (p: number) => editor.chain().insertContentAt(p, nodes).scrollIntoView().run()

  try {
    if (editor.isDestroyed) throw new Error('编辑器已经关了（笔记可能刚被切走），这张卡片没能插进来')
    if (!put(pos) || embedCount(editor) === before) {
      // 位置上插不进去（落点在叶子节点里之类），退一步：追加到正文末尾
      put(end)
    }
    if (embedCount(editor) === before) throw new Error('卡片没插进正文（编辑器拒绝了这次插入）')
  } catch (e) {
    // 插不进去就别把孤儿文件留在 .assets 里
    try {
      await getStorage().removeAsset(file)
    } catch {
      /* 删不掉也无所谓 */
    }
    throw e instanceof Error ? e : new Error(String(e))
  }

  // 光标已经跟着插入内容落到卡片后面，这里只是把焦点给回编辑器，接着就能打字
  try {
    if (!editor.isFocused) editor.commands.focus()
  } catch {
    /* 窗口没聚焦时失败无所谓，不影响卡片已经在正文里 */
  }
  return attrs
}

function HtmlCard({ node, updateAttributes, selected, deleteNode, editor, getPos }: NodeViewProps) {
  const file = String(node.attrs.file ?? '')
  const title = String(node.attrs.title ?? '') || file || '网页'
  const height = Math.min(
    MAX_HEIGHT,
    Math.max(MIN_HEIGHT, Number(node.attrs.height) || DEFAULT_HEIGHT),
  )
  // 内容缩放：正文只有五百多像素时，按比例缩放的页面（流程图、看板）字会小到看不清
  const zoom = clampZoom(node.attrs.zoom)
  /** 融入正文：网页整篇铺在笔记里，没有卡片外框，高度跟着内容长 */
  const inline = embedMode(node.attrs.mode) === 'inline'
  /** 笔记里记着的量高结果（0 = 还没量过） */
  const savedFit = clampFit(node.attrs.fit)

  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  /** iframe 的重载序号：改 key 强制换一个新文档（srcDoc 字符串没变时它不会自己重载） */
  const [frameSeq, setFrameSeq] = useState(0)
  const [liveH, setLiveH] = useState(height)
  /**
   * 融入模式下量出来的内容高度。
   * 初值直接用笔记里记的高度：打开就已经摆好，不会先塌一下再撑开。
   */
  const [autoH, setAutoH] = useState(() => (embedMode(node.attrs.mode) === 'inline' ? clampFit(node.attrs.fit) : 0))
  /** 屏幕上真正的高度 = 基准高度 × 缩放倍数 */
  const shownH = Math.max(MIN_HEIGHT, Math.round(liveH * zoom))
  const [full, setFull] = useState(false)
  const [resizing, setResizing] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  /** 正在网页里改字：iframe 的 body 被临时设成可编辑 */
  const [editing, setEditing] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  /** 编辑条上的一句提示（保存成功 / 失败原因），几秒后自动消失 */
  const [note, setNote] = useState('')
  /** 「改源码」弹窗 */
  const [srcOpen, setSrcOpen] = useState(false)
  const [srcText, setSrcText] = useState('')
  const cardRef = useRef<HTMLDivElement | null>(null)
  const nameRef = useRef<HTMLInputElement | null>(null)
  const wheelOff = useRef<(() => void) | null>(null)

  useEffect(() => setLiveH(height), [height])

  // 进改名状态时把原名整段选上，直接打字就替换
  useEffect(() => {
    if (renaming) nameRef.current?.select()
  }, [renaming])

  useEffect(() => () => wheelOff.current?.(), [])

  useEffect(() => {
    let alive = true
    setHtml(null)
    setError('')
    getStorage()
      .readAsset(file)
      .then((text) => {
        if (alive) setHtml(text)
      })
      .catch((e: unknown) => {
        if (alive) setError(String((e as Error)?.message ?? e))
      })
    return () => {
      alive = false
    }
  }, [file, tick])

  // 全屏时按 Esc 退出
  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFull(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full])

  const openInBrowser = useCallback(async () => {
    try {
      await getStorage().openAsset(file)
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    }
  }, [file])

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const startH = shownH
    let next = startH
    document.body.style.userSelect = 'none'
    // 铺一层全屏透明罩接住鼠标：往下拖时指针会滑到别的网页卡片上，
    // 那些 iframe 会把 mousemove 吃掉，主文档就收不到、高度也拖不动
    setResizing(true)
    const move = (ev: MouseEvent) => {
      next = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startH + ev.clientY - startY)))
      setLiveH(next / zoom)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.userSelect = ''
      setResizing(false)
      updateAttributes({ height: Math.max(MIN_HEIGHT, Math.round(next / zoom)) })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  /** 放大 / 缩小网页内容：卡片内横向滚动，字跟着变大 */
  const zoomBy = (delta: number) => updateAttributes({ zoom: clampZoom(zoom + delta) })

  /** 双击标题改名：回车/点别处保存，Esc 放弃，空名字当没改 */
  const startRename = () => {
    setDraft(title)
    setRenaming(true)
  }
  const commitRename = () => {
    const next = draft.trim()
    setRenaming(false)
    if (next && next !== title) updateAttributes({ title: next })
  }

  /** 网页里滚到头了，剩下的滚动量接着滚笔记正文（不然鼠标停在卡片上就滚不动页面） */
  const attachWheel = (frame: HTMLIFrameElement) => {
    wheelOff.current?.()
    wheelOff.current = null
    const doc = frame.contentDocument
    if (!doc) return
    const onWheel = (ev: WheelEvent) => {
      const root = (doc.scrollingElement ?? doc.documentElement) as HTMLElement | null
      if (!root) return
      const atTop = root.scrollTop <= 0
      const atBottom = Math.ceil(root.scrollTop + root.clientHeight) >= root.scrollHeight - 1
      if (!((ev.deltaY > 0 && atBottom) || (ev.deltaY < 0 && atTop))) return
      const outer = outerScroller(cardRef.current)
      if (!outer) return
      ev.preventDefault()
      outer.scrollTop += ev.deltaY
    }
    doc.addEventListener('wheel', onWheel, { passive: false })
    wheelOff.current = () => doc.removeEventListener('wheel', onWheel)
  }

  /**
   * 首次载入时按内容把高度贴上去（只对还没动过的默认高度生效）。
   *
   * 之前只「收」不放，结果内容比 520 高的页面（流程图、看板）一进来就得在卡片里
   * 上下滚，看着像被裁了一半；现在短了就收、长了就放，超过 900 才打住。
   */
  const FIT_MAX = 900
  const fitRef = useRef('')
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  /** 记住上一次的呈现模式：只有在「融入 → 卡片」这一刻才需要收高度 */
  const wasInline = useRef(inline)
  /** 同页可能有多张网页，用 id 区分是谁报上来的高度 */
  const heightId = useRef(`jjh-${Math.random().toString(36).slice(2, 10)}`)

  /** 量到的真实高度（ref 里留一份，定时器 / 回调读得到最新值） */
  const autoRef = useRef(autoH)
  autoRef.current = autoH
  /** 「只准长、回缩要慢」：网页临时变矮（脚本还没画完）先不动，稳住再收 */
  const shrinkTimer = useRef(0)
  /** 把量到的高度记回笔记的防抖计时器 */
  const saveFitTimer = useRef(0)

  /**
   * 把量到的高度记进笔记。
   * 不进撤回栈：这是自动记账，不该占掉一次「撤回」—— 否则刚插进来的网页，
   * 按一次撤回看着毫无反应（撤掉的是这个属性），得按两次才真的撤掉网页。
   */
  const rememberFit = (h: number) => {
    if (!(h > 0)) return
    const pos = getPos()
    if (typeof pos !== 'number') return
    const at = editor.state.doc.nodeAt(pos)
    if (!at || at.type.name !== 'htmlEmbed') return
    if (Math.abs((Number(at.attrs.fit) || 0) - h) <= 12) return
    const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...at.attrs, fit: h })
    tr.setMeta('addToHistory', false)
    editor.view.dispatch(tr)
  }

  /**
   * 融入正文：让 iframe 自己量内容高度，用 postMessage 报给笔记页面。
   * 量的是「子元素底部」而不是 body.scrollHeight —— 后者在 iframe 里至少等于
   * 视口高度，iframe 一撑高它跟着涨，会陷入越量越高的循环。
   *
   * 收到的数不能照单全收：网页在排版过程中会连着报好几个相近的值，
   * 每个都应用一次，正文文字就被推来推去（看着就是「抖」）。所以：
   * - 变高立刻跟上（慢了会裁住内容）
   * - 只有几像素的差别忽略
   * - 明显变矮要等它稳住 300ms 再收（筛选、折叠、脚本重排都会先矮一下）
   */
  useEffect(() => {
    if (!inline) return
    const apply = (next: number) => {
      if (Math.abs(autoRef.current - next) <= 2) return
      autoRef.current = next
      setAutoH(next)
      // 记回笔记：下次打开直接就是这个高度，不用再撑一次
      window.clearTimeout(saveFitTimer.current)
      saveFitTimer.current = window.setTimeout(() => {
        const h = autoRef.current
        if (h > 0) rememberFit(h)
      }, 700)
    }
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { __jianjiHeightId?: string; height?: number } | null
      if (!d || d.__jianjiHeightId !== heightId.current) return
      if (frameRef.current && e.source !== frameRef.current.contentWindow) return
      const h = Number(d.height)
      if (!Number.isFinite(h) || h <= 0) return
      const next = Math.max(MIN_FIT_HEIGHT, Math.min(INLINE_MAX_HEIGHT, Math.ceil(h)))
      const cur = autoRef.current
      if (!cur || next > cur + 6) {
        window.clearTimeout(shrinkTimer.current)
        apply(next)
        return
      }
      if (cur - next <= 8) return
      window.clearTimeout(shrinkTimer.current)
      shrinkTimer.current = window.setTimeout(() => apply(next), 300)
    }
    window.addEventListener('message', onMsg)
    return () => {
      window.removeEventListener('message', onMsg)
      window.clearTimeout(shrinkTimer.current)
      window.clearTimeout(saveFitTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inline, savedFit])

  const attachAutoHeight = (frame: HTMLIFrameElement) => {
    const doc = frame.contentDocument
    const win = doc?.defaultView
    if (!doc?.body || !win) return
    if ((win as unknown as Record<string, unknown>).__jianjiAutoHeightDoc === doc) {
      // 同一份网页已经装过：切过模式时手动催一次，父页面这边的监听刚重新挂上
      const measure = (win as unknown as Record<string, () => void>).__jianjiMeasure
      measure?.()
      return
    }
    const script = doc.createElement('script')
    // 带标记：在笔记里改完内容保存时，要把这个注入的脚本从文件里摘掉
    script.setAttribute('data-jianji-injected', 'autoheight')
    script.textContent = `(function () {
  var W = window;
  // srcDoc 装载会换掉 document 但 window 可能复用：标记必须挂在「这份文档」上，
  // 否则 ResizeObserver 会一直盯着已经被丢弃的旧 body，网页长高时不再报数
  if (W.__jianjiAutoHeightDoc === document) return;
  W.__jianjiAutoHeightDoc = document;
  var ID = ${JSON.stringify(heightId.current)};
  var last = 0, timer = 0, tries = 0;
  // 融入模式：网页整篇铺开、由笔记负责滚动，自己不需要滚动条。
  // 关掉它很关键 —— 高度只要差一点就会出现滚动条，滚动条一占宽度内容就重新排版、
  // 量出来又变高，高度和滚动条互相推着来回变（看着就是页面在抖）。
  try { document.documentElement.style.overflowY = 'hidden'; } catch (e) {}

  function read() {
    var b = document.body;
    if (!b) return 0;
    var h = 0, kids = b.children;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i], st = W.getComputedStyle(el);
      if (!st || st.display === 'none' || st.position === 'fixed') continue;
      var r = el.getBoundingClientRect();
      if (r.height > 0 || r.bottom > 0) h = Math.max(h, r.bottom + (W.scrollY || 0));
    }
    if (kids.length === 0 || h < 20) h = Math.max(h, b.scrollHeight);
    var pad = parseFloat(W.getComputedStyle(b).paddingBottom) || 0;
    return Math.ceil(h + pad + 2);
  }

  function publish(h) {
    if (!h || Math.abs(h - last) <= 4) return;
    last = h;
    try { W.parent.postMessage({ __jianjiHeightId: ID, height: h }, '*'); } catch (e) {}
  }

  // 排版还在动的时候先别报：隔一帧再量一次，两次一致才算定稿。
  // 这样外面收到的是一个终值，而不是「长一点、再长一点」连推好几次（正文会抖）。
  function measure() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      var a = read();
      W.requestAnimationFrame(function () {
        var b = read();
        if (Math.abs(a - b) > 1 && tries < 8) { tries++; measure(); return; }
        tries = 0;
        publish(b || a);
      });
    }, 50);
  }

  W.__jianjiMeasure = measure;
  if (W.ResizeObserver) {
    var ro = new W.ResizeObserver(measure);
    ro.observe(document.body);
    for (var j = 0; j < document.body.children.length; j++) ro.observe(document.body.children[j]);
  }
  W.addEventListener('resize', measure);
  W.addEventListener('load', measure);
  setTimeout(measure, 60);
  setTimeout(measure, 400);
  setTimeout(measure, 1400);
  measure();
})();`
    try {
      doc.body.appendChild(script)
    } catch {
      /* 页面自己设了 CSP 不让注入脚本，就退回固定高度，不影响显示 */
    }
  }

  /**
   * 从融入模式切回卡片：融入时整篇网页可能上万像素高，卡片要收回上限，
   * 否则一张卡片就顶满整屏。只在切换那一刻动，老卡片首次打开不受影响。
   */
  useEffect(() => {
    const prev = wasInline.current
    wasInline.current = inline
    if (!prev || inline) return
    const h = Math.max(MIN_HEIGHT, Math.min(FIT_MAX, Math.round(autoH || liveH)))
    fitRef.current = file
    setLiveH(h)
    // 顺手把量到的高度记下来：下次再切回「融入」就不用重新撑一遍
    updateAttributes({ height: h, fit: Math.round(autoH || savedFit || 0) })
    // 只在模式切换时跑一次，别把用户之后拖的高度改掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inline, file])

  /**
   * 模式一变就按新模式重挂网页里的监听（锚点 / 滚轮 / 自动高度）。
   * 走按钮切、走编辑器命令改 attrs、从 Markdown 读进来，都一样生效。
   */
  useEffect(() => {
    const f = frameRef.current
    if (!f || html === null) return
    attachAnchors(f, inline)
    if (inline) {
      wheelOff.current?.()
      wheelOff.current = null
      attachAutoHeight(f)
    } else {
      attachWheel(f)
    }
    // html/文件/重新载入都会换掉 iframe 文档，监听要跟着重挂
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inline, html, file, tick])

  /** 卡片 ⇄ 融入正文：可以随时来回切，网页文件本身不动 */
  const switchMode = (next: EmbedMode) => {
    if (next === 'inline') {
      // 先用之前量过 / 卡片当前的高度摆好，别先塌成一条再撑开
      const start = savedFit || Math.max(liveH, MIN_HEIGHT)
      autoRef.current = start
      setAutoH(start)
      updateAttributes({ mode: 'inline', fit: savedFit || 0 })
    } else {
      updateAttributes({
        mode: 'card',
        height: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(autoH || height))),
        fit: Math.round(autoH || savedFit || 0),
      })
    }
  }

  /** 按内容把高度贴上去（只在还没人动过高度时调用） */
  const fitToContent = () => {
    const d = frameRef.current?.contentDocument
    if (!d) return
    // 量 body 的高度：html 的 scrollHeight 至少等于视口，量出来永远「刚好装满」
    const body = d.body
    const h = body
      ? Math.max(body.scrollHeight, Math.ceil(body.getBoundingClientRect().height))
      : (d.documentElement?.scrollHeight ?? 0)
    if (h <= 60) return
    const next = Math.min(FIT_MAX, MAX_HEIGHT, Math.max(MIN_HEIGHT, h + 6))
    if (Math.abs(next - liveH) <= 12) return
    setLiveH(next)
    updateAttributes({ height: next })
  }

  const onFrameLoad = (e: React.SyntheticEvent<HTMLIFrameElement>) => {
    // 融入模式：不接管滚轮（网页本身没有内部滚动，滚轮自然交给笔记），
    // 也不做「贴一次高度」，全程由 iframe 里的 ResizeObserver 持续报高度
    if (inline) {
      attachAnchors(e.currentTarget, true)
      attachAutoHeight(e.currentTarget)
      return
    }
    attachWheel(e.currentTarget)
    attachAnchors(e.currentTarget)
    // 已经贴合过就别反复动——用户之后拖的高度不能被重新载入冲掉
    if (fitRef.current === file) return
    // 放大过就别量——内容高度是按当前缩放算的，收下去会越收越小
    if (zoom !== DEFAULT_ZOOM) return
    // 只动「还没动过」的默认高度，用户自己拖过的高度一律尊重
    if (Math.abs(liveH - DEFAULT_HEIGHT) > 2) return
    fitRef.current = file
    fitToContent()
    // 靠脚本画图的页面（图表之类）在 load 之后才长出高度，稍等一下再量一次
    window.setTimeout(() => fitToContent(), 350)
  }

  /* ---------------- 在笔记里改网页内容 ---------------- */

  /**
   * 进编辑前记下：原文件内容（取消时按它还原）、body 本来是不是就可编辑、
   * 以及怎么把这次编辑挂的监听和样式摘干净。
   */
  const editRef = useRef<{ source: string; hadEditable: boolean; cleanup: () => void } | null>(null)
  const savingRef = useRef(false)

  const flash = (text: string) => {
    setNote(text)
    window.setTimeout(() => setNote((cur) => (cur === text ? '' : cur)), 3200)
  }

  const stopEditDom = () => {
    const ref = editRef.current
    editRef.current = null
    ref?.cleanup()
    setEditing(false)
    setDirty(false)
  }

  /** 取消：网页里改过的 DOM 整块丢掉，重新按文件内容载入 */
  const cancelEdit = () => {
    if (savingRef.current) return
    const source = editRef.current?.source
    stopEditDom()
    if (typeof source !== 'string') return
    setHtml(source)
    // 换 key 强制重载：srcDoc 是同一份字符串时 DOM 不会重建，改过的字会留在那儿
    setFrameSeq((v) => v + 1)
  }

  /** 保存：把网页当前的 DOM 序列化后写回 .assets 里那份 .html */
  const saveEdit = async () => {
    const ref = editRef.current
    const doc = frameRef.current?.contentDocument
    if (!ref || !doc || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      const prev = ref.source
      const next = serializeDoc(doc, { source: prev, dropEditable: !ref.hadEditable })
      if (next === prev) {
        stopEditDom()
        flash('没有改动')
        return
      }
      const store = getStorage()
      // 上一版留个底：万一改坏了，同目录的 .bak.html 还能捞回来
      try {
        await store.saveAsset(backupName(file), prev)
      } catch {
        /* 备份失败不挡保存 */
      }
      await store.saveAsset(file, next)
      stopEditDom()
      setHtml(next)
      setFrameSeq((v) => v + 1)
      flash('已保存到网页文件')
    } catch (e) {
      flash(`没存上：${String((e as Error)?.message ?? e)}`)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const enterEdit = () => {
    const doc = frameRef.current?.contentDocument
    const win = doc?.defaultView
    if (!doc?.body || !win || editing) return
    const source = html ?? ''
    const body = doc.body
    const hadEditable = body.hasAttribute('contenteditable')
    // 编辑时按钮/链接只是普通文字：不然点一下脚本就跑、点链接页面就跳走
    const style = doc.createElement('style')
    style.setAttribute('data-jianji-injected', 'edit')
    style.textContent = editStyleText()
    doc.head?.appendChild(style)
    body.setAttribute('contenteditable', 'true')

    const onClick = (ev: MouseEvent) => {
      if (!isInteractive(ev.target)) return
      ev.preventDefault()
      ev.stopPropagation()
    }
    const onInput = () => setDirty(true)
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        ev.stopPropagation()
        cancelEdit()
      } else if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') {
        ev.preventDefault()
        ev.stopPropagation()
        void saveEdit()
      }
    }
    doc.addEventListener('click', onClick, true)
    doc.addEventListener('input', onInput, true)
    doc.addEventListener('keydown', onKey, true)

    editRef.current = {
      source,
      hadEditable,
      cleanup: () => {
        doc.removeEventListener('click', onClick, true)
        doc.removeEventListener('input', onInput, true)
        doc.removeEventListener('keydown', onKey, true)
        style.remove()
        if (!hadEditable) doc.body?.removeAttribute('contenteditable')
      },
    }

    // 光标先送到正文末尾，接着就能直接改字（没有内容可改也不会报错）
    try {
      win.focus()
      const sel = win.getSelection()
      const range = doc.createRange()
      range.selectNodeContents(body)
      range.collapse(false)
      sel?.removeAllRanges()
      sel?.addRange(range)
    } catch {
      /* 放不进去光标也不影响能不能改 */
    }
    setEditing(true)
    setDirty(false)
    setNote('')
  }

  const openSource = () => {
    setSrcText(html ?? '')
    setSrcOpen(true)
  }

  /** 改源码：完全按文本存，适合需要精确控制文件结构的时候 */
  const saveSource = async () => {
    if (savingRef.current) return
    if (!srcText.trim()) {
      flash('源码是空的，没保存')
      return
    }
    savingRef.current = true
    setSaving(true)
    try {
      const store = getStorage()
      const prev = html ?? ''
      if (srcText === prev) {
        setSrcOpen(false)
        stopEditDom()
        setTick((v) => v + 1)
        setFrameSeq((v) => v + 1)
        flash('没有改动')
        return
      }
      try {
        await store.saveAsset(backupName(file), prev)
      } catch {
        /* 备份失败不挡保存 */
      }
      await store.saveAsset(file, srcText)
      const next = srcText
      setSrcOpen(false)
      stopEditDom()
      setHtml(next)
      setFrameSeq((v) => v + 1)
      flash('已保存到网页文件')
    } catch (e) {
      flash(`没存上：${String((e as Error)?.message ?? e)}`)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const frame = (
    <iframe
      ref={frameRef}
      key={`frame-${frameSeq}`}
      className="html-frame"
      title={title}
      srcDoc={html ?? ''}
      sandbox={SANDBOX}
      // 缩放靠「把 iframe 的 CSS 宽度按倍数放大」实现：页面里的 width:100% 会跟着铺开，
      // 内容整体变大，卡片内横向滚动；直接把内容 scale 会把布局一起缩回去，没用
      style={{
        // 融入模式：用过记下来的高度／量到的高度；都没有才用卡片高度占位
        height: inline ? autoH || savedFit || Math.max(height, MIN_HEIGHT) : shownH,
        width: inline ? '100%' : `${Math.round(zoom * 100)}%`,
        minWidth: inline ? 0 : zoom >= DEFAULT_ZOOM ? 380 : 0,
        // 还不知道多高时先不显示：等量完一次性摆好，省得正文先被「半截网页」推一下
        visibility: inline && !autoH && !savedFit ? 'hidden' : undefined,
      }}
      onLoad={onFrameLoad}
    />
  )

  return (
    <NodeViewWrapper
      className={`html-card${inline ? ' inline' : ''}${selected ? ' selected' : ''}${error ? ' broken' : ''}`}
      contentEditable={false}
      ref={cardRef}
      onClick={(e: React.MouseEvent) => {
        const pos = getPos()
        if (typeof pos !== 'number') return
        if (editor.state.selection.from === pos) return
        // 点卡片就选中它（方便看到边框、按删除键删掉）
        e.preventDefault()
        editor.commands.setNodeSelection(pos)
      }}
    >
      {/* 改字模式：顶上一条「保存 / 取消 / 源码」，网页里点哪改哪 */}
      {editing && (
        <div
          className="html-edit-bar"
          contentEditable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="html-edit-tag">✎ 改字中</span>
          <span className="html-edit-tip">
            {note || (dirty ? '改完点保存（⌘S），改动会写进网页文件' : '点网页里的文字就能直接改')}
          </span>
          <button type="button" className="html-edit-btn" disabled={saving} onClick={openSource}>
            源码
          </button>
          <button type="button" className="html-edit-btn" disabled={saving} onClick={cancelEdit}>
            取消
          </button>
          <button
            type="button"
            className="html-edit-btn primary"
            disabled={saving}
            onClick={() => void saveEdit()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      )}

      {/* 融入正文：平时只有一个很淡的小工具条，鼠标移上去才清晰，不占正文高度 */}
      {inline && !editing && (
        <div
          className="html-inline-tools"
          contentEditable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {renaming ? (
            <input
              ref={nameRef}
              className="html-inline-name"
              value={draft}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                else if (e.key === 'Escape') { e.preventDefault(); setRenaming(false) }
              }}
            />
          ) : (
            <span
              className="html-inline-title"
              title="双击改名字"
              onDoubleClick={(e) => { e.stopPropagation(); startRename() }}
            >
              {title}
            </span>
          )}
          <button
            type="button"
            className="html-inline-mode"
            title="改网页里的文字：点哪改哪，改完存回网页文件（特效照常）"
            onClick={() => enterEdit()}
          >
            ✎ 编辑
          </button>
          <button
            type="button"
            className="html-inline-mode"
            title="切回卡片模式：固定高度、可缩放"
            onClick={() => switchMode('card')}
          >
            ▣ 卡片
          </button>
          <button
            type="button"
            className="html-act"
            title="重新载入（文件被改过时用）"
            onClick={() => {
              setTick((v) => v + 1)
              setFrameSeq((v) => v + 1)
            }}
          >
            ↻
          </button>
          <button type="button" className="html-act" title="全屏看" onClick={() => setFull(true)}>⛶</button>
          <button type="button" className="html-act" title="用浏览器打开原文件" onClick={() => void openInBrowser()}>↗</button>
          <button type="button" className="html-act del" title="从笔记里移除（不会删掉 .assets 里的文件）" onClick={() => deleteNode()}>×</button>
        </div>
      )}

      {!inline && !editing && (
        <div className="html-card-head" data-drag-handle title="按住拖动可挪位置">
        <span className="html-card-icon">{'</>'}</span>
        {renaming ? (
          <input
            ref={nameRef}
            className="html-card-name"
            value={draft}
            spellCheck={false}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                e.preventDefault()
                commitRename()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setRenaming(false)
              }
            }}
          />
        ) : (
          <span
            className="html-card-title"
            title="双击改名字"
            onDoubleClick={(e) => {
              e.stopPropagation()
              startRename()
            }}
          >
            {title}
          </span>
        )}
        {html !== null && <span className="html-card-size">{humanSize(html.length)}</span>}
        <span className="html-zoom" title="放大看细节：内容变大，卡片内可以左右滚动">
          <button
            type="button"
            className="html-zoom-btn"
            title="缩小"
            disabled={zoom <= MIN_ZOOM}
            onClick={(e) => {
              e.stopPropagation()
              zoomBy(-ZOOM_STEP)
            }}
          >
            −
          </button>
          <button
            type="button"
            className="html-zoom-val"
            title="回到 100%"
            onClick={(e) => {
              e.stopPropagation()
              updateAttributes({ zoom: DEFAULT_ZOOM })
            }}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            className="html-zoom-btn"
            title="放大"
            disabled={zoom >= MAX_ZOOM}
            onClick={(e) => {
              e.stopPropagation()
              zoomBy(ZOOM_STEP)
            }}
          >
            ＋
          </button>
        </span>
        <span className="html-card-acts">
          <button
            type="button"
            className="html-inline-mode"
            title="融入正文：去掉卡片外框，网页整篇跟着笔记一起排（特效照常可用）"
            onClick={(e) => {
              e.stopPropagation()
              switchMode('inline')
            }}
          >
            ⤢ 融入
          </button>
          <button
            type="button"
            className="html-act"
            title="改网页里的文字：点哪改哪，改完存回网页文件（特效照常）"
            onClick={(e) => {
              e.stopPropagation()
              enterEdit()
            }}
          >
            ✎
          </button>
          <button
            type="button"
            className="html-act"
            title="重新载入（文件被改过时用）"
            onClick={(e) => {
              e.stopPropagation()
              setTick((v) => v + 1)
              setFrameSeq((v) => v + 1)
            }}
          >
            ↻
          </button>
          <button
            type="button"
            className="html-act"
            title="全屏看"
            onClick={(e) => {
              e.stopPropagation()
              setFull(true)
            }}
          >
            ⛶
          </button>
          <button
            type="button"
            className="html-act"
            title="用浏览器打开原文件"
            onClick={(e) => {
              e.stopPropagation()
              void openInBrowser()
            }}
          >
            ↗
          </button>
          <button
            type="button"
            className="html-act del"
            title="从笔记里移除（不会删掉 .assets 里的文件）"
            onClick={(e) => {
              e.stopPropagation()
              deleteNode()
            }}
          >
            ×
          </button>
        </span>
        </div>
      )}

      <div className="html-card-body">
        {error ? (
          <div className="html-card-err">
            <b>这个网页打不开</b>
            <span>{error}</span>
          </div>
        ) : html === null ? (
          <div className="html-card-loading">正在载入网页…</div>
        ) : html.trim() ? (
          frame
        ) : (
          <div className="html-card-err">
            <b>这个网页是空的</b>
          </div>
        )}
      </div>

      {!inline && (
        <>
          <span
            className="html-resize"
            title="拖动调整高度"
            // 用捕获阶段：先于编辑器的 mousedown 拿到事件，否则 ProseMirror 会把这次拖动
            // 当成「拖动整个卡片」，页面收不到 mousemove，高度就拖不动
            onMouseDownCapture={(e) => startResize(e)}
          />
          <span className="html-drag-hint">网页 · 拖底部可调高度</span>
        </>
      )}

      {resizing && createPortal(<div className="html-resize-mask" />, document.body)}

      {full &&
        createPortal(
          <div
            className="html-full"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setFull(false)
            }}
          >
            <div className="html-full-box">
              <div className="html-full-head">
                <span className="html-full-title">{title}</span>
                <span className="html-full-acts">
                  <button type="button" onClick={() => void openInBrowser()}>
                    在浏览器中打开
                  </button>
                  <button type="button" className="primary" onClick={() => setFull(false)}>
                    关闭（Esc）
                  </button>
                </span>
              </div>
              <div className="html-full-body">
                {html === null ? (
                  <div className="html-card-loading">正在载入网页…</div>
                ) : (
                  <iframe
                    className="html-frame"
                    title={title}
                    srcDoc={html}
                    sandbox={SANDBOX}
                    style={{ height: '100%' }}
                    onLoad={(e) => attachAnchors(e.currentTarget)}
                  />
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}

      {srcOpen &&
        createPortal(
          <div
            className="html-full"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setSrcOpen(false)
            }}
          >
            <div className="html-src-box">
              <div className="html-full-head">
                <span className="html-full-title">改源码 · {title}</span>
                <span className="html-full-acts">
                  <button type="button" onClick={() => void openInBrowser()}>
                    看原文
                  </button>
                  <button type="button" disabled={saving} onClick={() => setSrcOpen(false)}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={saving}
                    onClick={() => void saveSource()}
                  >
                    {saving ? '保存中…' : '保存'}
                  </button>
                </span>
              </div>
              <textarea
                className="html-src-text"
                value={srcText}
                spellCheck={false}
                placeholder="这里是这份网页的 HTML 源码，改完点保存（⌘S）"
                onChange={(e) => setSrcText(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault()
                    void saveSource()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setSrcOpen(false)
                  }
                }}
              />
            </div>
          </div>,
          document.body,
        )}
    </NodeViewWrapper>
  )
}
