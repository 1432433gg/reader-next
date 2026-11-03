export const MAX_COVER_BYTES = 5 * 1024 * 1024

export function validateCoverFile(file: File) {
  if (!file.size || file.size > MAX_COVER_BYTES) {
    throw new Error('请选择不超过 5MB 的封面图片')
  }
  const supported = ['image/jpeg', 'image/png', 'image/webp']
  if (file.type ? !supported.includes(file.type.toLowerCase()) : !/\.(jpe?g|png|webp)$/i.test(file.name)) {
    throw new Error('支持 JPG、PNG、WebP，请先将 HEIC 等格式转换后上传')
  }
}

/** Decode before preview/upload; normalize orientation via the browser and preserve aspect ratio. */
export async function prepareCoverFile(file: File): Promise<File> {
  validateCoverFile(file)
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('图片无法读取，请换一张 JPG、PNG 或 WebP 图片'))
      img.src = url
    })
    if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth > 8192 || img.naturalHeight > 8192) {
      throw new Error('图片尺寸过大，请缩小后再上传（最长边不超过 8192 像素）')
    }
    const scale = Math.min(1, 600 / img.naturalWidth, 900 / img.naturalHeight)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('当前浏览器无法处理图片')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error('图片处理失败，请重新选择')), 'image/jpeg', 0.9)
    })
    return new File([blob], 'cover.jpg', { type: 'image/jpeg' })
  } finally {
    URL.revokeObjectURL(url)
  }
}
