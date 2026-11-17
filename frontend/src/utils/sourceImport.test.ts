import { describe, expect, it } from 'vitest'
import { createImportRows, parseRemoteImport, sourceFingerprint } from './sourceImport'

describe('source import format boundary', () => {
  it('exposes malformed remote records without silently discarding their position', () => {
    const values = parseRemoteImport(['[{"bookSourceName":"A","bookSourceUrl":"a"}]', 'broken', '{"bookSourceName":"B"}'])
    const rows = createImportRows(values)
    expect(rows).toHaveLength(3)
    expect(rows[1]?.error).toContain('格式错误')
    expect(rows[2]?.error).toContain('地址')
  })
  it('compares all fields independently of key order', () => {
    expect(sourceFingerprint({ a: 1, b: { c: 2 } })).toBe(sourceFingerprint({ b: { c: 2 }, a: 1 }))
    expect(sourceFingerprint({ a: 1 })).not.toBe(sourceFingerprint({ a: 2 }))
  })
})
