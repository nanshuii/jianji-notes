/**
 * 图片压缩：粘贴/拖入/选择文件后，先缩到长边 1600px 再编码成 WebP，
 * 然后以 data URI 直接内嵌进 .md。笔记不依赖外部文件，换电脑也不掉图。
 */
export async function fileToDataUrl(file: File, maxSide = 1600): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

  // 动图走 canvas 会丢帧，原样内嵌
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return raw

  try {
    const bitmap = await createImageBitmap(file)
    const { width, height } = bitmap
    const scale = Math.min(1, maxSide / Math.max(width, height))
    if (scale === 1 && raw.length < 900_000) {
      bitmap.close()
      return raw
    }
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      return raw
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const webp = canvas.toDataURL('image/webp', 0.9)
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.88)
  } catch {
    return raw
  }
}
