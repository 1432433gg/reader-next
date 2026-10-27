import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useBookshelfStore } from './bookshelf'
import { checkChapterUpdates, getBookshelfWithCacheInfo, getChapterUpdateStatus } from '../api/bookshelf'
import { listBrowserCacheSummary } from '../utils/browserCache'

vi.mock('../api/bookshelf', () => ({
  getBookshelfWithCacheInfo: vi.fn(),
  getBookGroups: vi.fn(),
  deleteBook: vi.fn(),
  deleteBooks: vi.fn(),
  saveBookGroupId: vi.fn(),
  saveBookGroup: vi.fn(),
  deleteBookGroup: vi.fn(),
  saveBooks: vi.fn(),
  getChapterUpdateStatus: vi.fn(),
  checkChapterUpdates: vi.fn(),
}))

vi.mock('../utils/browserCache', () => ({
  deleteBrowserBookCache: vi.fn(),
  listBrowserCacheSummary: vi.fn(),
}))

vi.mock('../utils/recentBooks', () => ({
  clearRecentReadBooks: vi.fn(),
  getRecentReadBookKey: vi.fn((book) => `${book.origin || ''}::${book.bookUrl}`),
  loadRecentReadBooks: vi.fn(() => []),
  removeRecentReadBook: vi.fn(),
}))

describe('bookshelf search state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
      clear: vi.fn(() => storage.clear()),
    })
    localStorage.clear()
    vi.mocked(getBookshelfWithCacheInfo).mockResolvedValue([])
    vi.mocked(listBrowserCacheSummary).mockResolvedValue([])
  })

  it('starts searches in single-source scope by default', () => {
    const store = useBookshelfStore()

    store.startSearch('星门')

    expect(store.searchKey).toBe('星门')
    expect(store.searchScope).toBe('source')
    expect(store.searchSourceUrl).toBe('')
    expect(store.searchGroup).toBe('')
  })


  it('does not display browser cache counts for uploaded local txt books', async () => {
    vi.mocked(getBookshelfWithCacheInfo).mockResolvedValue([
      {
        name: '本地书',
        author: '本地导入',
        origin: 'local-txt',
        bookUrl: 'local-txt:abc',
        cachedChapterCount: 12,
      },
      {
        name: '远程书',
        author: '作者',
        origin: 'https://source.example',
        bookUrl: 'https://book.example/1',
      },
    ] as never)
    vi.mocked(listBrowserCacheSummary).mockResolvedValue([
      { bookUrl: 'local-txt:abc', cachedChapterCount: 12, bytes: 100, updatedAt: 1 },
      { bookUrl: 'https://book.example/1', cachedChapterCount: 3, bytes: 200, updatedAt: 2 },
    ])
    const store = useBookshelfStore()

    await store.fetchBooks()

    expect(store.books.find((book) => book.bookUrl === 'local-txt:abc')?.browserCachedChapterCount).toBe(0)
    expect(store.books.find((book) => book.bookUrl === 'https://book.example/1')?.browserCachedChapterCount).toBe(3)
  })

  it('can start a search with the active explore source selected', () => {
    const store = useBookshelfStore()

    store.startSearch('星门', { sourceUrl: 'https://m.cuoceng.com' })

    expect(store.searchKey).toBe('星门')
    expect(store.searchScope).toBe('source')
    expect(store.searchSourceUrl).toBe('https://m.cuoceng.com')
  })

  it('remembers the last search scope for later searches', () => {
    const store = useBookshelfStore()

    store.searchScope = 'all'
    store.persistSearchPreferences()
    store.clearSearch()
    store.startSearch('星门')

    expect(store.searchScope).toBe('all')
    expect(store.searchSourceUrl).toBe('')
    expect(store.searchGroup).toBe('')
  })

  it('reuses cached search results for the same key and scope', () => {
    const store = useBookshelfStore()
    const book = {
      name: '星门',
      author: '老鹰吃小鸡',
      bookUrl: 'https://book.example/xm',
      origin: 'https://source.example',
    }

    store.cacheSearchResults({
      key: '星门',
      scope: 'source',
      group: '',
      sourceUrl: 'https://source.example',
      results: [book],
    })

    expect(store.getCachedSearchResults({
      key: '星门',
      scope: 'source',
      group: '',
      sourceUrl: 'https://source.example',
    })).toEqual([book])
    expect(store.getCachedSearchResults({
      key: '星门',
      scope: 'all',
      group: '',
      sourceUrl: '',
    })).toBeNull()
  })
})

describe('bookshelf new chapter markers', () => {
  const DETECTED_AT = 1_700_000_100_000

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(getBookshelfWithCacheInfo).mockResolvedValue([])
    vi.mocked(listBrowserCacheSummary).mockResolvedValue([])
  })

  function statusWithPending(newChapters: number) {
    return {
      enabled: true,
      intervalHours: 24,
      running: false,
      lastRunAt: DETECTED_AT,
      nextRunAt: DETECTED_AT + 24 * 3600 * 1000,
      report: {
        startedAt: DETECTED_AT - 1000,
        finishedAt: DETECTED_AT,
        checked: 1,
        updated: 1,
        failed: 0,
        skipped: 0,
        newChapters,
        updatedBooks: [],
        failedBooks: [],
        pendingBooks: [{ name: '测试书', bookUrl: 'book-1', newChapters, detectedAt: DETECTED_AT }],
      },
    }
  }

  it('shows new chapters until the book is opened again', async () => {
    vi.mocked(getChapterUpdateStatus).mockResolvedValue(statusWithPending(3))
    const store = useBookshelfStore()
    await store.fetchChapterUpdateStatus()

    const book = { name: '测试书', author: '', origin: 'src', bookUrl: 'book-1' }
    // 发现更新前读过（服务端存的是秒）
    expect(store.newChapterCountFor({ ...book, durChapterTime: DETECTED_AT / 1000 - 60 })).toBe(3)
    // 发现更新后打开过（前端存的是毫秒）
    expect(store.newChapterCountFor({ ...book, durChapterTime: DETECTED_AT + 1 })).toBe(0)
    // 其他书没有标记
    expect(store.newChapterCountFor({ ...book, bookUrl: 'book-2' })).toBe(0)
  })

  it('waits for a running check to finish, then refreshes the shelf', async () => {
    vi.mocked(checkChapterUpdates).mockResolvedValue({ started: true })
    vi.mocked(getChapterUpdateStatus)
      .mockResolvedValueOnce({ ...statusWithPending(2), running: true })
      .mockResolvedValueOnce(statusWithPending(2))
    vi.useFakeTimers()
    const store = useBookshelfStore()
    const pending = store.checkChapterUpdates()
    await vi.advanceTimersByTimeAsync(2500)
    const report = await pending
    vi.useRealTimers()

    expect(report?.newChapters).toBe(2)
    expect(getBookshelfWithCacheInfo).toHaveBeenCalled()
    expect(store.checkingUpdates).toBe(false)
  })
})
