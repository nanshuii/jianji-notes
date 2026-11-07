// 准备数据：在 WebKit 里塞一篇临时笔记（网页文件内容 + meta），然后刷新
localStorage.clear()
const HTML = window.__JJ_HTML__ || ''
const fm = '---\ntitle: 光伏板块\ncreated: 2026-11-07T10:00:00.000Z\nupdated: 2026-11-07T10:00:00.000Z\npinned: false\n---\n\n'
const meta = JSON.stringify({ file: 'html-jitter.html', title: '光伏工序级竞争格局全表', height: 900 })
const note = fm + '```jianji-html\n' + meta + '\n```\n'
const a = {}; a['html-jitter.html'] = HTML
localStorage.setItem('jianji.assets.v1', JSON.stringify(a))
const n = {}; n['股市/光伏板块.md'] = note
localStorage.setItem('jianji.notes.v1', JSON.stringify(n))
location.reload()
