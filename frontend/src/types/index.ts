// ─── API 统一返回 ───
export interface ApiResponse<T = unknown> {
  isSuccess: boolean
  errorMsg: string
  data: T
}

// ─── 书籍 ───
export interface Book {
  name: string
  author: string
  bookUrl: string
  origin: string
  originName?: string
  coverUrl?: string
  tocUrl?: string
  charset?: string
  customCoverUrl?: string
  canUpdate?: boolean
  durChapterIndex?: number
  durChapterPos?: number
  durChapterTime?: number
  durChapterTitle?: string
  intro?: string
  latestChapterTitle?: string
  lastCheckTime?: number
  totalChapterNum?: number
  type?: number
  group?: number
  wordCount?: string
  infoHtml?: string
  tocHtml?: string
  kind?: string
  updateTime?: string
  cachedChapterCount?: number
  browserCachedChapterCount?: number
  recentKind?: 'book' | 'rss'
  rssSourceUrl?: string
  rssLink?: string
  rssPubDate?: string
}

// ─── 搜索结果 ───
export interface SearchBook {
  name: string
  author: string
  bookUrl: string
  origin: string
  originName?: string
  originGroup?: string
  coverUrl?: string
  intro?: string
  kind?: string
  lastChapter?: string
  updateTime?: string
  wordCount?: string
  bookSourceUrls?: string[]
}

// ─── 章节 ───
export interface BookChapter {
  title: string
  url: string
  index: number
}

// ─── 书源 ───
export interface BookSource {
  bookSourceName: string
  bookSourceGroup?: string
  bookSourceUrl: string
  bookSourceType?: number
  enabled?: boolean
  enabledExplore?: boolean
  enabledCookieJar?: boolean
  customOrder?: number
  weight?: number
  searchUrl?: string
  exploreUrl?: string
  header?: string
  loginUrl?: string
  loginCheckJs?: string
  loadWithBaseUrl?: boolean
  singleUrl?: boolean
  ruleSearch?: Record<string, unknown>
  ruleExplore?: Record<string, unknown>
  ruleBookInfo?: Record<string, unknown>
  ruleToc?: Record<string, unknown>
  ruleContent?: Record<string, unknown>
}

export interface BookSourceTestResult {
  bookSourceName: string
  bookSourceUrl: string
  valid: boolean
  searchOk: boolean
  exploreOk: boolean
  keyword: string
  exploreUrl?: string
  searchError?: string
  exploreError?: string
  markedInvalid: boolean
  group?: string
}

export interface BookSourceTestResponse {
  total: number
  valid: number
  invalid: number
  markedInvalid: number
  results: BookSourceTestResult[]
}

// ─── 分组 ───
export interface BookGroup {
  groupId: number
  groupName: string
  orderNo?: number
}

// ─── 用户 ───
export interface UserInfo {
  username: string
  lastLoginAt?: number
  accessToken: string
  enableWebdav?: boolean
  enableLocalStore?: boolean
  createdAt?: number
  isAdmin?: boolean
}

// ─── 应用更新 ───
export interface VersionUpdateInfo {
  currentVersion: string
  latestVersion: string | null
  latestName: string | null
  releaseUrl: string | null
  publishedAt: string | null
  updateAvailable: boolean
  shouldRemind: boolean
  dismissedVersion: string | null
  checkedAt: number
  error: string | null
}

// ─── 书签 ───
export interface Bookmark {
  time?: number
  bookName: string
  bookAuthor: string
  chapterIndex?: number
  chapterPos?: number
  chapterName?: string
  bookText?: string
  content?: string
}

// ─── 净化规则 ───
export interface ReplaceRule {
  id: number
  name: string
  group?: string
  pattern: string
  replacement: string
  scope?: string
  isEnabled: boolean
  isRegex: boolean
  order: number
}

// ─── RSS ───
export interface RssSource {
  sourceUrl: string
  sourceName: string
  sourceIcon?: string
  sourceGroup?: string
  sourceComment?: string
  enabled?: boolean
  enabledCookieJar?: boolean
  concurrentRate?: string
  header?: string
  loginUrl?: string
  loginCheckJs?: string
  sortUrl?: string
  singleUrl?: boolean
  articleStyle?: number
  ruleArticles?: string
  ruleNextPage?: string
  ruleTitle?: string
  rulePubDate?: string
  ruleDescription?: string
  ruleImage?: string
  ruleLink?: string
  ruleContent?: string
  style?: string
  enableJs?: boolean
  loadWithBaseUrl?: boolean
  customOrder?: number
  lastUpdateTime?: number
}

export interface RssArticle {
  origin: string
  sort: string
  title: string
  order: number
  link: string
  pubDate?: string
  description?: string
  content?: string
  image?: string
  read?: boolean
  variable?: string
}

// ─── 书架新章节自动检查 ───
export interface ChapterUpdatedBook {
  name: string
  author: string
  bookUrl: string
  newChapters: number
  latestChapterTitle?: string | null
}

/** 还没读的新章节，多次检查累计，打开这本书后清除 */
export interface ChapterUpdatePendingBook {
  name: string
  bookUrl: string
  newChapters: number
  detectedAt: number
  latestChapterTitle?: string | null
}

export interface ChapterUpdateFailedBook {
  name: string
  bookUrl: string
  error: string
}

export interface ChapterUpdateReport {
  startedAt: number
  finishedAt: number
  checked: number
  updated: number
  failed: number
  skipped: number
  newChapters: number
  updatedBooks: ChapterUpdatedBook[]
  failedBooks: ChapterUpdateFailedBook[]
  pendingBooks: ChapterUpdatePendingBook[]
}

export interface ChapterUpdateStatus {
  enabled: boolean
  intervalHours: number
  running: boolean
  lastRunAt?: number | null
  nextRunAt?: number | null
  report?: ChapterUpdateReport | null
}
