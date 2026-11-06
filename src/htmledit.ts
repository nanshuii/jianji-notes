/**
 * 在笔记里直接改嵌入网页的内容。
 *
 * 做法：把 iframe 里的 body 临时变成可编辑区（contenteditable），用户点文字就能改；
 * 保存时把整份 DOM 序列化写回 `.assets/` 里的那份 .html，下次打开就是改过的样子。
 *
 * 几个必须处理的细节：
 * - 我们往网页里塞过「自动贴合高度」的脚本和编辑用的样式，保存时要摘掉，不能写进用户文件；
 * - 编辑时给 body 加的 contenteditable 也要摘掉，否则文件存下来就变成「永远可编辑」；
 * - 原来的 doctype 要留着，否则一些老页面会进怪异模式；
 * - 覆盖前先把上一版存成 `.bak.html`，改坏了还能捞回来。
 */

/** 我们注入到网页里的元素都带这个标记，序列化时按它清理 */
export const INJECT_ATTR = 'data-jianji-injected'

/** 取原文的 doctype；没有就用 HTML5 的标准头 */
export function doctypeOf(html: string): string {
  const head = html.replace(/^\uFEFF/, '').trimStart()
  const m = head.match(/^<!doctype[^>]*>/i)
  return m ? m[0] : '<!DOCTYPE html>'
}

/** `xxx.html` → `xxx.bak.html`：保存前留的上一版 */
export function backupName(file: string): string {
  return `${file.replace(/\.html?$/i, '')}.bak.html`
}

/** 把注入的脚本/样式从一棵（克隆出来的）dom 里摘干净 */
export function stripInjected(root: ParentNode): void {
  root.querySelectorAll(`[${INJECT_ATTR}]`).forEach((el) => el.remove())
}

export type SerializeOptions = {
  /** 原文，用来沿用它的 doctype */
  source?: string
  /** 编辑时我们给 body 加过 contenteditable，存之前要摘掉 */
  dropEditable?: boolean
}

/**
 * 把 iframe 当前的 DOM 序列化成一整份 .html 文本。
 *
 * 注意这是「当前页面样子」的快照：脚本运行后长出来的节点也会被写进去。
 * 对图表类页面通常没影响（重新打开时脚本会再画一遍、覆盖同名容器），
 * 但如果是「点一下往 body 里追加一块」的页面，存下来就会多出那块内容 ——
 * 所以还留了「改源码」入口，需要精确控制时可以走那条路。
 */
export function serializeDoc(doc: Document, opts: SerializeOptions = {}): string {
  const clone = doc.documentElement.cloneNode(true) as HTMLElement
  stripInjected(clone)
  if (opts.dropEditable) {
    const targets: (Element | null)[] = [clone, clone.querySelector('body'), clone.querySelector('head')]
    for (const el of targets) {
      if (!el) continue
      el.removeAttribute('contenteditable')
    }
  }
  const doctype = doctypeOf(opts.source ?? '')
  return `${doctype}\n${clone.outerHTML}\n`
}

/** 编辑时临时注入到网页里的样式：让「像按钮/链接的东西」也能选中文字，而不是被点走 */
export function editStyleText(): string {
  return `
/* 笔记里正在改这份网页：把交互元素降级成普通文字，避免误触脚本/跳转 */
html, body { cursor: text !important; }
a, button, [role="button"], [onclick], label, summary { cursor: text !important; }
a, button, input, select, textarea, label, [role="button"], [onclick] {
  pointer-events: auto;
}
::selection { background: rgba(255, 214, 102, .55); }
[contenteditable="true"]:focus { outline: none; }
`.trim()
}

/** 编辑时点到的这些元素一律不触发（不然点一下按钮脚本就跑、点链接页面就跳走） */
const INTERACTIVE = 'a,button,input,select,textarea,label,summary,[role="button"],[onclick]'

export function isInteractive(target: EventTarget | null): boolean {
  const el = target as Element | null
  if (!el?.closest) return false
  return !!el.closest(INTERACTIVE)
}
