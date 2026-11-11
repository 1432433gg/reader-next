import { describe, expect, it } from 'vitest'
import { parseBookSourceImport } from './sourceImport'

describe('parseBookSourceImport', () => {
  it.each([
    ['single object', source()],
    ['array', [source()]],
    ['bookSourceList wrapper', { bookSourceList: [source()] }],
    ['bookSources wrapper', { bookSources: [source()] }],
    ['data wrapper', { data: [source()] }],
    ['sources wrapper', { sources: [source()] }],
  ])('accepts a %s without fetching or executing source rules', (_label, payload) => {
    const entries = parseBookSourceImport(JSON.stringify(payload), '测试文件')

    expect(entries).toHaveLength(1)
    expect(entries[0].source?.bookSourceName).toBe('测试源')
    expect(entries[0].source?.bookSourceUrl).toBe('https://example.com/source')
    expect(entries[0].error).toBeUndefined()
  })

  it('maps legacy flat fields and parses a stringified rule object', () => {
    const legacy = {
      bookSourceName: '旧版源',
      bookSourceUrl: 'https://legacy.example',
      enable: true,
      ruleSearchUrl: 'https://legacy.example/search?key={{key}}',
      ruleSearchList: '.book-list li',
      ruleSearchName: '@css:a@text',
      ruleSearch: JSON.stringify({ bookList: '.book-list li', name: '@css:a@text' }),
    }

    const [entry] = parseBookSourceImport(JSON.stringify([legacy]), '旧版文件')

    expect(entry.source?.enabled).toBe(true)
    expect(entry.source?.searchUrl).toContain('/search')
    expect(entry.source?.ruleSearch).toEqual({
      bookList: '.book-list li',
      name: '@css:a@text',
    })
    expect(entry.formats).toContain('CSS')
  })

  it('keeps malformed rows visible and identifies duplicate addresses', () => {
    const entries = parseBookSourceImport(
      JSON.stringify([
        source(),
        source({ bookSourceName: '重复源' }),
        { bookSourceUrl: 'https://missing-name.example' },
      ]),
      '混合文件'
    )

    expect(entries[0].error).toBeUndefined()
    expect(entries[1].duplicateOf).toBe('混合文件第 1 项')
    expect(entries[2].error).toContain('书源名称')
  })

  it('rejects unknown and non-text source types without coercing them to text', () => {
    const entries = parseBookSourceImport(
      JSON.stringify([
        source({ bookSourceType: 'mystery' }),
        source({ bookSourceType: 1 }),
      ]),
      '类型文件'
    )

    expect(entries[0].error).toContain('不支持的书源类型')
    expect(entries[1].error).toContain('仅支持文字书源')
  })

  it('keeps malformed fields row-local and rejects objects without a recognized source shape', () => {
    const entries = parseBookSourceImport(JSON.stringify([
      source(),
      source({ bookSourceGroup: 42 }),
      source({ ruleSearch: { bookList: '.book', name: 7 } }),
      { bookSourceName: '未知对象', bookSourceUrl: 'https://unknown.example', irrelevant: true },
    ]), '坏条目文件')

    expect(entries).toHaveLength(4)
    expect(entries[0].source?.bookSourceName).toBe('测试源')
    expect(entries[1].source).toBeNull()
    expect(entries[1].error).toContain('bookSourceGroup')
    expect(entries[2].source).toBeNull()
    expect(entries[2].error).toContain('ruleSearch.name')
    expect(entries[3].source).toBeNull()
    expect(entries[3].error).toContain('未识别的书源格式')
  })

  it('accepts integer boundaries and isolates overflow to the affected rows', () => {
    const fields = [
      { customOrder: -2147483648, weight: 2147483647, lastUpdateTime: '+9223372036854775807', respondTime: '-9223372036854775808' },
      { weight: 2147483648 },
      { customOrder: -2147483649 },
      { lastUpdateTime: '9223372036854775808' },
      { respondTime: '-9223372036854775809' },
    ]
    const entries = parseBookSourceImport(JSON.stringify(fields.map(source)), '整数边界')

    expect(entries[0].source).toMatchObject(fields[0])
    for (const [index, field] of ['weight', 'customOrder', 'lastUpdateTime', 'respondTime'].entries()) {
      expect(entries[index + 1].source).toBeNull()
      expect(entries[index + 1].error).toContain(field)
    }
  })

  it('reports script, WebView and login dependencies as static hints', () => {
    const [entry] = parseBookSourceImport(
      JSON.stringify([
        source({
          loginUrl: 'https://example.com/login',
          jsLib: 'function helper() {}',
          ruleContent: { content: '@js:result = java.get(url)' },
        }),
      ]),
      '动态文件'
    )

    expect(entry.dependencies).toEqual(expect.arrayContaining(['登录配置', 'JS 库', 'JavaScript / WebView']))
    expect(entry.formats).toContain('JavaScript')
  })
})

function source(overrides: Record<string, unknown> = {}) {
  return {
    bookSourceName: '测试源',
    bookSourceUrl: 'https://example.com/source',
    bookSourceType: 0,
    ruleSearch: { bookList: '@css:li', name: '@css:a@text' },
    ...overrides,
  }
}
