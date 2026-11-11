import type { BookSource } from '../types'

const WRAPPER_KEYS = ['bookSourceList', 'bookSources', 'data', 'sources'] as const
const RULE_FIELDS = [
  'ruleExplore',
  'ruleSearch',
  'ruleBookInfo',
  'ruleToc',
  'ruleContent',
  'ruleReview',
] as const

const LEGACY_RULE_FIELDS: Record<string, Record<string, string>> = {
  ruleSearch: {
    ruleSearchList: 'bookList',
    ruleSearchName: 'name',
    ruleSearchAuthor: 'author',
    ruleSearchIntro: 'intro',
    ruleSearchKind: 'kind',
    ruleSearchLastChapter: 'lastChapter',
    ruleSearchUpdateTime: 'updateTime',
    ruleSearchNoteUrl: 'bookUrl',
    ruleSearchBookUrl: 'bookUrl',
    ruleSearchCoverUrl: 'coverUrl',
    ruleSearchWordCount: 'wordCount',
  },
  ruleExplore: {
    ruleFindList: 'bookList',
    ruleFindName: 'name',
    ruleFindAuthor: 'author',
    ruleFindIntro: 'intro',
    ruleFindKind: 'kind',
    ruleFindLastChapter: 'lastChapter',
    ruleFindUpdateTime: 'updateTime',
    ruleFindNoteUrl: 'bookUrl',
    ruleFindBookUrl: 'bookUrl',
    ruleFindCoverUrl: 'coverUrl',
    ruleFindWordCount: 'wordCount',
  },
  ruleBookInfo: {
    ruleBookInfoInit: 'init',
    ruleBookName: 'name',
    ruleBookAuthor: 'author',
    ruleIntroduce: 'intro',
    ruleBookIntro: 'intro',
    ruleBookKind: 'kind',
    ruleBookLastChapter: 'lastChapter',
    ruleBookUpdateTime: 'updateTime',
    ruleCoverUrl: 'coverUrl',
    ruleBookCoverUrl: 'coverUrl',
    ruleBookWordCount: 'wordCount',
    ruleChapterUrl: 'tocUrl',
    ruleBookTocUrl: 'tocUrl',
  },
  ruleToc: {
    ruleChapterList: 'chapterList',
    ruleChapterName: 'chapterName',
    ruleContentUrl: 'chapterUrl',
    ruleChapterUrl: 'chapterUrl',
    ruleChapterUpdateTime: 'updateTime',
    ruleChapterUrlNext: 'nextTocUrl',
    ruleTocUrlNext: 'nextTocUrl',
  },
  ruleContent: {
    ruleBookContent: 'content',
    ruleBookContentReplace: 'replaceRegex',
    ruleContentUrlNext: 'nextContentUrl',
    ruleContentTitle: 'title',
  },
}

const SOURCE_STRING_FIELDS = [
  'bookSourceGroup', 'bookUrlPattern', 'jsLib', 'concurrentRate', 'header',
  'loginUrl', 'loginUi', 'loginCheckJs', 'coverDecodeJs', 'exploreUrl',
  'exploreScreen', 'searchUrl', 'bookSourceComment', 'variableComment',
] as const
const SOURCE_BOOLEAN_FIELDS = [
  'enabled', 'enabledExplore', 'enabledCookieJar', 'loadWithBaseUrl', 'singleUrl',
] as const
const SOURCE_INTEGER_FIELDS = ['customOrder', 'weight'] as const
const SOURCE_INT64_FIELDS = ['lastUpdateTime', 'respondTime'] as const
const RULE_STRING_FIELDS: Record<string, readonly string[]> = {
  ruleExplore: ['checkKeyWord', 'bookList', 'name', 'author', 'intro', 'kind', 'lastChapter', 'updateTime', 'bookUrl', 'coverUrl', 'wordCount'],
  ruleSearch: ['checkKeyWord', 'bookList', 'name', 'author', 'intro', 'kind', 'lastChapter', 'updateTime', 'bookUrl', 'coverUrl', 'wordCount'],
  ruleBookInfo: ['init', 'name', 'author', 'intro', 'kind', 'lastChapter', 'updateTime', 'coverUrl', 'wordCount', 'tocUrl', 'canReName', 'downloadUrls'],
  ruleToc: ['preUpdateJs', 'init', 'chapterList', 'chapterName', 'chapterUrl', 'formatJs', 'isVolume', 'isVip', 'isPay', 'updateTime', 'nextTocUrl'],
  ruleContent: ['content', 'title', 'nextContentUrl', 'webJs', 'sourceRegex', 'replaceRegex', 'imageStyle', 'imageDecode', 'payAction'],
  ruleReview: ['reviewUrl', 'avatarRule', 'contentRule', 'postTimeRule', 'reviewQuoteUrl', 'voteUpUrl', 'voteDownUrl', 'postReviewUrl', 'postQuoteUrl', 'deleteUrl'],
}
const SOURCE_SCHEMA_MARKERS = [
  ...SOURCE_STRING_FIELDS,
  ...SOURCE_BOOLEAN_FIELDS,
  ...SOURCE_INTEGER_FIELDS,
  ...SOURCE_INT64_FIELDS,
  'bookSourceType', 'ruleExplore', 'ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent', 'ruleReview',
] as const

export type SourceImportEntry = {
  id: string
  location: string
  source: BookSource | null
  error?: string
  duplicateOf?: string
  domain?: string
  formats: string[]
  dependencies: string[]
}

export function parseBookSourceImport(text: string, sourceLabel: string): SourceImportEntry[] {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (error) {
    return [errorEntry(sourceLabel, error instanceof Error ? error.message : 'JSON 格式错误')]
  }

  let values: unknown[]
  if (Array.isArray(root)) {
    values = root
  } else if (isRecord(root)) {
    const wrapped = WRAPPER_KEYS.find((key) => Array.isArray(root[key]))
    values = wrapped ? (root[wrapped] as unknown[]) : [root]
  } else {
    return [errorEntry(sourceLabel, '文件内容必须是书源对象、数组或支持的书源包装格式')]
  }

  if (values.length === 0) {
    return [errorEntry(sourceLabel, '文件中没有书源条目')]
  }

  const seen = new Map<string, string>()
  return values.map((value, index) => {
    const location = `${sourceLabel}第 ${index + 1} 项`
    const id = `source-${index}`
    try {
      const decoded = typeof value === 'string' ? JSON.parse(value) : value
      if (!isRecord(decoded)) {
        return errorEntry(location, '书源条目必须是 JSON 对象', id)
      }

      const migrated = migrateLegacySource(decoded)
      const name = typeof migrated.bookSourceName === 'string' ? migrated.bookSourceName.trim() : ''
      const url = typeof migrated.bookSourceUrl === 'string' ? migrated.bookSourceUrl.trim() : ''
      if (!name) throw new Error('缺少书源名称 bookSourceName')
      if (!url) throw new Error('缺少书源地址 bookSourceUrl')
      validateBookSourceShape(migrated)
      let parsedUrl: URL
      try {
        parsedUrl = new URL(url)
      } catch {
        throw new Error('书源地址格式无效')
      }
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('书源地址必须使用 HTTP 或 HTTPS')
      if (!parsedUrl.hostname) throw new Error('书源地址缺少主机名')

      const sourceType = migrated.bookSourceType
      if (sourceType !== undefined && sourceType !== null && sourceType !== 0) {
        throw new Error('当前仅支持文字书源，音频或未知类型不能导入')
      }
      migrated.bookSourceName = name
      migrated.bookSourceUrl = url
      migrated.bookSourceType = 0

      const identity = normalizeSourceAddress(url)
      const previous = seen.get(identity)
      if (!previous) seen.set(identity, location)

      return {
        id,
        location,
        source: migrated as unknown as BookSource,
        ...(previous ? { duplicateOf: previous } : {}),
        domain: getDomain(url),
        formats: detectRuleFormats(migrated),
        dependencies: detectDependencies(migrated),
      }
    } catch (error) {
      return errorEntry(location, error instanceof Error ? error.message : '无法读取书源条目', id)
    }
  })
}

export function normalizeSourceAddress(value: string) {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
}

function migrateLegacySource(input: Record<string, unknown>) {
  const source = { ...input }
  moveIfAbsent(source, 'ruleBookUrlPattern', 'bookUrlPattern')
  moveIfAbsent(source, 'serialNumber', 'customOrder')
  moveIfAbsent(source, 'ruleFindUrl', 'exploreUrl')
  moveIfAbsent(source, 'ruleSearchUrl', 'searchUrl')
  moveIfAbsent(source, 'enable', 'enabled')

  if (typeof source.bookSourceType === 'string') {
    const kind = source.bookSourceType.trim().toUpperCase()
    if (kind === 'AUDIO') source.bookSourceType = 1
    else if (kind === 'TEXT' || kind === 'BOOK' || kind === '0') source.bookSourceType = 0
    else throw new Error(`不支持的书源类型 ${source.bookSourceType}`)
  }
  if (source.bookSourceType !== undefined && source.bookSourceType !== null) {
    if (typeof source.bookSourceType !== 'number' || !Number.isInteger(source.bookSourceType)) {
      throw new Error('bookSourceType 必须是有效的整数类型')
    }
  }

  if (!hasOwn(source, 'header') && typeof source.httpUserAgent === 'string' && source.httpUserAgent.trim()) {
    source.header = JSON.stringify({ 'User-Agent': source.httpUserAgent })
  }

  for (const field of RULE_FIELDS) {
    const value = source[field]
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (!trimmed || trimmed.toLowerCase() === 'null') {
        delete source[field]
      } else {
        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          throw new Error(`规则字段 ${field} 不是有效 JSON 对象`)
        }
        if (!isRecord(parsed)) throw new Error(`规则字段 ${field} 必须是对象`)
        source[field] = parsed
      }
    } else if (value !== undefined && value !== null && !isRecord(value)) {
      throw new Error(`规则字段 ${field} 必须是对象`)
    }
  }

  for (const field of ['ruleSearch', 'ruleExplore', 'ruleBookInfo', 'ruleToc', 'ruleContent']) {
    const mappings = LEGACY_RULE_FIELDS[field]
    const nested = isRecord(source[field]) ? { ...source[field] as Record<string, unknown> } : {}
    for (const [legacy, current] of Object.entries(mappings)) {
      if (hasOwn(nested, current) || !hasOwn(source, legacy)) continue
      const value = source[legacy]
      if (typeof value === 'string' && !value.trim()) continue
      nested[current] = value
      delete source[legacy]
    }
    if (Object.keys(nested).length) source[field] = nested
  }

  return source
}

function isOptionalInt64Text(value: string) {
  const trimmed = value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
  if (!trimmed || trimmed.toLowerCase() === 'null') return true
  if (!/^[+-]?\d+$/.test(trimmed)) return false
  const digits = trimmed.replace(/^[+-]?0*/, '')
  const limit = trimmed.startsWith('-') ? '9223372036854775808' : '9223372036854775807'
  return digits.length < limit.length || (digits.length === limit.length && digits <= limit)
}

function validateBookSourceShape(source: Record<string, unknown>) {
  if (!SOURCE_SCHEMA_MARKERS.some((field) => hasOwn(source, field))) {
    throw new Error('未识别的书源格式：没有阅读规则或书源配置字段')
  }

  for (const field of SOURCE_STRING_FIELDS) {
    const value = source[field]
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw new Error(`字段 ${field} 必须是字符串`)
    }
  }
  for (const field of SOURCE_BOOLEAN_FIELDS) {
    const value = source[field]
    if (value !== undefined && value !== null && typeof value !== 'boolean') {
      throw new Error(`字段 ${field} 必须是布尔值`)
    }
  }
  for (const field of SOURCE_INTEGER_FIELDS) {
    const value = source[field]
    if (value !== undefined && value !== null &&
        (typeof value !== 'number' || !Number.isInteger(value) || value < -2147483648 || value > 2147483647)) {
      throw new Error(`字段 ${field} 必须是 32 位有符号整数`)
    }
  }
  for (const field of SOURCE_INT64_FIELDS) {
    const value = source[field]
    const validNumber = typeof value === 'number' && Number.isSafeInteger(value)
    const validString = typeof value === 'string' && isOptionalInt64Text(value)
    if (value !== undefined && value !== null && !validNumber && !validString) {
      throw new Error(`字段 ${field} 必须是安全整数或范围内的 64 位整数文本`)
    }
  }

  for (const [ruleField, ruleStringFields] of Object.entries(RULE_STRING_FIELDS)) {
    const value = source[ruleField]
    if (value === undefined || value === null) continue
    if (!isRecord(value)) throw new Error(`规则字段 ${ruleField} 必须是对象`)
    for (const field of ruleStringFields) {
      const ruleValue = value[field]
      if (ruleValue !== undefined && ruleValue !== null && typeof ruleValue !== 'string') {
        throw new Error(`规则字段 ${ruleField}.${field} 必须是字符串`)
      }
    }
  }
}

function detectRuleFormats(source: Record<string, unknown>) {
  const text = collectRuleText(source).join('\n')
  const formats: string[] = []
  if (/@css\s*:/i.test(text)) formats.push('CSS')
  if (/@xpath\s*:/i.test(text) || /(?:^|\s)\/\//m.test(text)) formats.push('XPath')
  if (/@jsonpath\s*:/i.test(text) || /\$\.[\w\[]/m.test(text)) formats.push('JSONPath')
  if (/@(?:regex|reg)\s*:/i.test(text) || /\bregex\b/i.test(text)) formats.push('Regex')
  if (/@js\s*:/i.test(text) || /javascript/i.test(text)) formats.push('JavaScript')
  return formats.length ? formats : ['未识别']
}

function detectDependencies(source: Record<string, unknown>) {
  const dependencies = new Set<string>()
  if (['loginUrl', 'loginUi', 'loginCheckJs'].some((key) => hasNonEmptyValue(source[key]))) {
    dependencies.add('登录配置')
  }
  if (hasNonEmptyValue(source.jsLib)) dependencies.add('JS 库')

  const text = JSON.stringify(source)
  if (/webView|webJs|@js\s*:|javascript/i.test(text)) {
    dependencies.add('JavaScript / WebView')
  }
  return [...dependencies]
}

function collectRuleText(source: Record<string, unknown>): string[] {
  const result: string[] = []
  for (const key of [...RULE_FIELDS, 'searchUrl', 'exploreUrl', 'loginUrl', 'jsLib']) {
    collectStrings(source[key], result)
  }
  return result
}

function collectStrings(value: unknown, output: string[]) {
  if (typeof value === 'string') {
    output.push(value)
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, output))
  } else if (isRecord(value)) {
    Object.values(value).forEach((item) => collectStrings(item, output))
  }
}

function hasNonEmptyValue(value: unknown) {
  return typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null
}

function moveIfAbsent(source: Record<string, unknown>, oldKey: string, newKey: string) {
  if (hasOwn(source, newKey) || !hasOwn(source, oldKey)) return
  source[newKey] = source[oldKey]
  delete source[oldKey]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function getDomain(url: string) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function errorEntry(location: string, error: string, id = `error-${location}`): SourceImportEntry {
  return {
    id,
    location,
    source: null,
    error,
    formats: [],
    dependencies: [],
  }
}
