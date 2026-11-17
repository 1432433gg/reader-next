import type { BookSource } from '../types'

export type ImportRow = { id: number; source?: BookSource; error?: string }

// Keep original objects and fields; validation here only controls selection.
export function createImportRows(values: unknown[]): ImportRow[] {
  const seen = new Set<string>()
  return values.map((value, id) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { id, error: '格式错误：应为书源对象' }
    }
    const source = value as BookSource
    if (typeof source.bookSourceName !== 'string' || !source.bookSourceName.trim()) {
      return { id, source, error: '缺少书源名称' }
    }
    if (typeof source.bookSourceUrl !== 'string' || !source.bookSourceUrl.trim()) {
      return { id, source, error: '缺少书源地址' }
    }
    if (seen.has(source.bookSourceUrl)) return { id, source, error: '包内地址重复，仅可选择第一条' }
    seen.add(source.bookSourceUrl)
    return { id, source }
  })
}

export function parseRemoteImport(raw: string[]): unknown[] {
  return raw.flatMap((text) => {
    try {
      const value: unknown = JSON.parse(text)
      return Array.isArray(value) ? value : [value]
    } catch {
      return [null]
    }
  })
}

// Object key order is not a source change; all field values are significant.
export function sourceFingerprint(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical)
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]))
    }
    return item
  }
  return JSON.stringify(canonical(value)) ?? 'undefined'
}
