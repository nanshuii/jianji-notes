import { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

/**
 * 跳到某一段时给它闪一下高亮。
 *
 * 不能直接在 editor.view.dom 的节点上 classList.add：ProseMirror 后续任何一个
 * 事务都可能重绘那个节点，class 立刻被冲掉。改成用官方 Decoration，由 PM 在
 * 每次 state 更新时重新套用，跨重绘也在。
 */
export const jumpKey = new PluginKey<string | null>('jj-jump-highlight')

export const JumpHighlight = Extension.create({
  name: 'jumpHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin<string | null>({
        key: jumpKey,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(jumpKey) as string | null | undefined
            return meta === undefined ? value : meta
          },
        },
        props: {
          decorations(state) {
            const text = jumpKey.getState(state)
            if (!text) return null
            const decos: Decoration[] = []
            state.doc.descendants((node, pos) => {
              if (node.isTextblock && node.textContent.includes(text)) {
                decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'jj-jump-flash' }))
              }
            })
            return DecorationSet.create(state.doc, decos)
          },
        },
      }),
    ]
  },
})

/** 高亮并滚到含 text 的那一段；1.8 秒后撤掉。返回是否找到 */
export function flashJump(editor: Editor, text: string): boolean {
  if (editor.isDestroyed) return false
  // 只带 meta、不改文档，所以不会触发自动保存，也不会进撤回栈
  editor.view.dispatch(editor.state.tr.setMeta(jumpKey, text))
  const hit = editor.view.dom.querySelector('.jj-jump-flash') as HTMLElement | null
  if (!hit) return false
  hit.scrollIntoView({ block: 'center' })
  window.setTimeout(() => {
    if (editor.isDestroyed) return
    if (jumpKey.getState(editor.state) === text) {
      editor.view.dispatch(editor.state.tr.setMeta(jumpKey, null))
    }
  }, 1800)
  return true
}
