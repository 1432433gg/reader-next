import http from '../api/http'
import { uploadBookCover } from '../api/bookshelf'
import type { Book } from '../types'

export type CustomCoverBackup = Record<string, string>
const coverPattern = /^\/reader3\/bookCover\/[0-9a-f-]{36}$/
const maxBytes = 5 * 1024 * 1024

function coverFile(data: string): File {
  if (!data.startsWith('data:image/jpeg;base64,') || data.length > Math.ceil(maxBytes / 3) * 4 + 23) {
    throw new Error('备份中的自定义封面格式无效或过大')
  }
  let bytes: Uint8Array<ArrayBuffer>
  try {
    bytes = Uint8Array.from(atob(data.slice('data:image/jpeg;base64,'.length)), (c) => c.charCodeAt(0))
  } catch {
    throw new Error('备份中的自定义封面无法读取')
  }
  if (!bytes.length || bytes.length > maxBytes) throw new Error('备份中的自定义封面大小无效')
  return new File([bytes], 'cover.jpg', { type: 'image/jpeg' })
}

export function validateCustomCoverBackup(covers: CustomCoverBackup = {}) {
  if (!covers || typeof covers !== 'object' || Array.isArray(covers)) throw new Error('封面备份格式无效')
  for (const [url, data] of Object.entries(covers)) {
    if (!coverPattern.test(url) || typeof data !== 'string') throw new Error('封面备份格式无效')
    coverFile(data)
  }
}

export async function captureCustomCovers(books: Book[]): Promise<CustomCoverBackup> {
  const covers: CustomCoverBackup = {}
  for (const url of new Set(books.map((b) => b.customCoverUrl).filter((url): url is string => !!url && coverPattern.test(url)))) {
    const { data: blob } = await http.get<Blob>(url.slice('/reader3'.length), { responseType: 'blob' })
    covers[url] = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(new Error('读取封面失败，备份未完成'))
      reader.readAsDataURL(blob)
    })
  }
  return covers
}

export async function restoreCustomCovers(books: Book[], covers: CustomCoverBackup = {}) {
  for (const book of books) {
    const data = book.customCoverUrl && covers[book.customCoverUrl]
    if (data) await uploadBookCover(book.bookUrl, coverFile(data))
  }
}
