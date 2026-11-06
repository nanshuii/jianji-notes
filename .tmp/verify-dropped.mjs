/**
 * 纯逻辑单测：原生拖放路径的分类、MIME、data URI 还原、路径 → File 组装。
 * 运行：node .tmp/verify-dropped.mjs
 */
import { build } from 'esbuild'
import { resolve } from 'node:path'

const built = await build({
  entryPoints: [resolve('src/dropped.ts')],
  bundle: true, format: 'esm', platform: 'node', write: false,
})
const mod = await import(
  'data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64')
)
const {
  isImagePath, isHtmlPath, isImageFile, isDroppableFile, imageMimeOf,
  classifyPaths, dataUrlToFile, pathsToFiles,
} = mod

let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
}

/* ---------- 路径识别 ---------- */
for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'heic', 'heif', 'tif', 'tiff', 'ico']) {
  check(`认得 .${ext} 图片`, isImagePath(`/Users/me/Desktop/截图.${ext}`))
}
check('大写扩展名也认', isImagePath('/tmp/截图.PNG') && isImagePath('A.JPEG'))
check('Windows 路径也认', isImagePath('C:\\Users\\me\\图.webp'))
check('带空格和中文的文件名', isImagePath('/tmp/光伏 产业链 2026.png'))
check('网页不是图片', !isImagePath('/tmp/报表.html') && !isImagePath('/tmp/a.htm'))
check('普通文件不是图片', !isImagePath('/tmp/说明.txt') && !isImagePath('/tmp/笔记.md'))
check('目录名长得像图片也不算', !isImagePath('/tmp/图片.png/'))
check('空值不炸', !isImagePath('') && !isImagePath(null) && !isImagePath(undefined))
check('认得网页路径', isHtmlPath('/tmp/a.html') && isHtmlPath('/tmp/a.HTM') && isHtmlPath('/tmp/a.xhtml'))
check('网页路径判断不误伤图片', !isHtmlPath('/tmp/a.png'))

/* ---------- File 识别（MIME 可能为空） ---------- */
check('有 MIME 就按 MIME 认', isImageFile({ type: 'image/png', name: '没有扩展名' }))
check('MIME 为空按扩展名兜底', isImageFile({ type: '', name: '拖进来.png' }))
check('普通文本不认', !isImageFile({ type: 'text/plain', name: '说明.txt' }))
check('网页文件可拖', isDroppableFile({ type: 'text/html', name: '报表.html' }))
check('图片文件可拖', isDroppableFile({ type: '', name: '照片.heic' }))
check('其它文件不可拖', !isDroppableFile({ type: '', name: '账单.pdf' }))
check('空 File 不炸', !isDroppableFile(null) && !isImageFile(undefined))

/* ---------- MIME 映射 ---------- */
check('png MIME', imageMimeOf('a.png') === 'image/png')
check('jpg MIME', imageMimeOf('a.JPG') === 'image/jpeg')
check('svg MIME', imageMimeOf('a.svg') === 'image/svg+xml')
check('heic MIME', imageMimeOf('a.heic') === 'image/heic')
check('未知扩展名退回通用类型', imageMimeOf('a.bin') === 'application/octet-stream')

/* ---------- 分类 ---------- */
const mixed = classifyPaths([
  '/tmp/1.png', '/tmp/page.html', '/tmp/note.txt', '/tmp/2.JPEG', '/tmp/chart.svg',
  null, '', '/tmp/page2.htm',
])
check('图片分类数量与顺序', JSON.stringify(mixed.images.map(p => p.split('/').pop())) === '["1.png","2.JPEG","chart.svg"]', JSON.stringify(mixed.images))
check('网页分类数量与顺序', JSON.stringify(mixed.pages.map(p => p.split('/').pop())) === '["page.html","page2.htm"]', JSON.stringify(mixed.pages))
check('不认识的单独放一类', JSON.stringify(mixed.others) === '["/tmp/note.txt"]')
check('空/null 输入不炸', JSON.stringify(classifyPaths(null)) === '{"pages":[],"images":[],"others":[]}')

/* ---------- data URI → File ---------- */
const bytes = [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]
const uri = 'data:image/png;base64,' + Buffer.from(bytes).toString('base64')
const f = dataUrlToFile(uri, '截图.png')
check('还原出来的文件名', f.name === '截图.png')
check('还原出来的 MIME', f.type === 'image/png', f.type)
check('还原出来的字节', Buffer.from(await f.arrayBuffer()).equals(Buffer.from(bytes)))
check('data URI 带换行也不炸', Buffer.from(await dataUrlToFile(uri.slice(0, 30) + '\n' + uri.slice(30), 'a.png').arrayBuffer()).equals(Buffer.from(bytes)))
const svgFile = dataUrlToFile('data:text/plain,' + encodeURIComponent('<svg/>'), '图.svg', 'image/svg+xml')
check('非 base64 的 data URI 也能还原', (await svgFile.text()) === '<svg/>')
check('data URI 自带的 MIME 优先', svgFile.type === 'text/plain', svgFile.type)
const noMime = dataUrlToFile('data:,' + encodeURIComponent('<svg/>'), '图.svg', 'image/svg+xml')
check('data URI 没写 MIME 时用调用方给的兜底', noMime.type === 'image/svg+xml' && (await noMime.text()) === '<svg/>')
let threw = false
try { dataUrlToFile('不是 data URI', 'a.png') } catch { threw = true }
check('坏数据会抛错而不是塞进笔记', threw)

/* ---------- 路径 → File（桌面原生拖放核心逻辑） ---------- */
const calls = []
const reader = {
  async readDroppedFile(p) { calls.push(['html', p]); return `<h1>${p}</h1>` },
  async readDroppedImage(p) {
    calls.push(['img', p])
    if (p.includes('坏')) throw new Error('文件损坏')
    return uri
  },
}
const errs = []
const paths = ['/tmp/a.html', '/tmp/照片.png', '/tmp/说明.txt', '/tmp/坏图.jpg', '/tmp/b.HTML']
const files = await pathsToFiles(paths, reader, (name, e) => errs.push([name, String(e)]))
check('只把网页/图片变成 File', files.length === 3, String(files.length))
check('保持拖入顺序', JSON.stringify(files.map(x => x.name)) === '["a.html","照片.png","b.HTML"]', JSON.stringify(files.map(x => x.name)))
check('网页 File 带正文与 MIME', (await files[0].text()).includes('/tmp/a.html') && files[0].type === 'text/html')
check('图片 File 字节与 MIME 正确', Buffer.from(await files[1].arrayBuffer()).equals(Buffer.from(bytes)) && files[1].type === 'image/png')
check('reader 只被调用于认识的文件', JSON.stringify(calls.map(c => c[0])) === '["html","img","img","html"]', JSON.stringify(calls))
check('读失败的单文件会报错', errs.length === 1 && errs[0][0] === '坏图.jpg' && /文件损坏/.test(errs[0][1]), JSON.stringify(errs))
check('读失败不影响后面的文件', files[2].name === 'b.HTML')
check('空路径串不炸', (await pathsToFiles(null, reader)).length === 0)
const win = await pathsToFiles(['C:\\Users\\me\\图.png'], reader)
check('Windows 路径取到正确文件名', win[0]?.name === '图.png', win[0]?.name)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
