import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { computed, effectScope, ref } from 'vue'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAppStore } from './app'
import { useReaderStore } from './reader'
import { getBookContent, getChapterList, getShelfBook, saveBookProgress, setBookSource } from '../api/bookshelf'
import { getBrowserCachedChapter, setBrowserCachedChapter } from '../utils/browserCache'
import { useContinuousReading } from '../composables/useContinuousReading'
import ReaderView from '../views/ReaderView.vue'
import { getBookmarks } from '../api/bookmark'
import { getReplaceRules } from '../api/replaceRule'
import { cacheBookToBrowser } from '../utils/bookCache'
import type { Book } from '../types'

vi.mock('../api/bookshelf', () => ({
  getBookContent: vi.fn(), getChapterList: vi.fn(), getShelfBook: vi.fn(),
  saveBookProgress: vi.fn(), setBookSource: vi.fn(),
}))
vi.mock('../utils/browserCache', () => ({
  getBrowserCachedChapter: vi.fn(), setBrowserCachedChapter: vi.fn(),
  countBrowserBookCache: vi.fn(async () => 0),
}))
vi.mock('../utils/recentBooks', () => ({ saveRecentReadBook: vi.fn() }))
vi.mock('../api/bookmark', () => ({
  getBookmarks: vi.fn(), saveBookmark: vi.fn(), deleteBookmark: vi.fn(), deleteBookmarks: vi.fn(),
}))
vi.mock('../api/replaceRule', () => ({ getReplaceRules: vi.fn(), saveReplaceRule: vi.fn() }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const first: Book = { bookUrl: 'book-a', origin: 'source-a', name: '第一本', author: '作者 A' }
const second: Book = { bookUrl: 'book-b', origin: 'source-b', name: '第二本', author: '作者 B' }
const chaptersFor = (bookUrl: string) => [0, 1, 2].map((index) => ({
  index, title: `${bookUrl} 第 ${index + 1} 章`, url: `${bookUrl}/${index}`,
}))

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  localStorage.clear()
  setActivePinia(createPinia())
  useAppStore().setOnlineStatus(true)
  vi.mocked(getShelfBook).mockImplementation(async (url) => ({ ...(url === first.bookUrl ? first : second) }))
  vi.mocked(getChapterList).mockImplementation(async ({ bookUrl }) => chaptersFor(bookUrl!))
  vi.mocked(getBookContent).mockImplementation(async ({ chapterUrl }) => `${chapterUrl} 正文`)
  vi.mocked(getBrowserCachedChapter).mockResolvedValue(null)
  vi.mocked(setBrowserCachedChapter).mockResolvedValue(undefined)
  vi.mocked(saveBookProgress).mockResolvedValue('ok')
  vi.mocked(getBookmarks).mockResolvedValue([])
  vi.mocked(getReplaceRules).mockResolvedValue([])
})

afterEach(async () => {
  vi.clearAllTimers()
  vi.useRealTimers()
  await vi.dynamicImportSettled()
})

describe('reader book switching', () => {
  it('selects the new book and clears the previous text before waiting for the server', async () => {
    const store = useReaderStore()
    await store.loadBook(first)
    await store.loadChapter(0)
    const pending = deferred<Book>()
    vi.mocked(getShelfBook).mockReturnValueOnce(pending.promise)
    const opening = store.loadBook(second)

    expect(store.book?.bookUrl).toBe(second.bookUrl)
    expect(store.content).toBe('')
    expect(store.chapters).toEqual([])
    expect(store.loading).toBe(true)

    pending.resolve({ ...second })
    await opening
  })

  it('ignores an older book lookup that finishes after the new book', async () => {
    const store = useReaderStore()
    const pending = deferred<Book>()
    vi.mocked(getShelfBook).mockReturnValueOnce(pending.promise)
    const openingFirst = store.loadBook(first)
    await store.loadBook(second)
    await store.loadChapter(0)
    pending.resolve({ ...first })
    await openingFirst

    expect(store.book?.bookUrl).toBe(second.bookUrl)
    expect(store.content).toBe('book-b/0 正文')
    expect(store.chapters).toEqual(chaptersFor(second.bookUrl))
  })

  it('does not replace the new catalog with a late catalog from the previous book', async () => {
    const store = useReaderStore()
    const pending = deferred<ReturnType<typeof chaptersFor>>()
    vi.mocked(getChapterList).mockReturnValueOnce(pending.promise)
    const openingFirst = store.loadBook(first)
    await flushPromises()
    await store.loadBook(second)
    await store.loadChapter(0)
    pending.resolve(chaptersFor(first.bookUrl))
    await openingFirst

    expect(store.chapters).toEqual(chaptersFor(second.bookUrl))
    expect(store.content).toBe('book-b/0 正文')
  })

  it('does not put a late preload into another book at the same chapter index', async () => {
    const store = useReaderStore()
    await store.loadBook(first)
    const pending = deferred<string>()
    vi.mocked(getBookContent).mockReturnValueOnce(pending.promise)
    const preload = store.preloadNextChapter(0)
    await flushPromises()
    await store.loadBook(second)
    pending.resolve('第一本的迟到正文')
    await preload
    await store.loadChapter(0)

    expect(store.content).toBe('book-b/0 正文')
    expect(setBrowserCachedChapter).not.toHaveBeenCalledWith(expect.objectContaining({
      bookUrl: second.bookUrl, content: '第一本的迟到正文',
    }))
  })

  it('does not combine an old chapter URL with the new source after reading browser cache', async () => {
    const store = useReaderStore()
    await store.loadBook(first)
    const pending = deferred<string | null>()
    vi.mocked(getBrowserCachedChapter).mockReturnValueOnce(pending.promise)
    const fetching = store.fetchChapterContent(0)
    await store.loadBook(second)
    pending.resolve(null)
    await fetching

    expect(getBookContent).not.toHaveBeenCalledWith(expect.objectContaining({
      chapterUrl: 'book-a/0', bookSourceUrl: second.origin,
    }))
  })

  it('keeps the new book loading when an old content request completes', async () => {
    const store = useReaderStore()
    await store.loadBook(first)
    const pending = deferred<string>()
    vi.mocked(getBookContent).mockReturnValueOnce(pending.promise)
    const readingFirst = store.loadChapter(0)
    await flushPromises()
    await store.loadBook(second)
    pending.resolve('第一本的迟到正文')
    await readingFirst

    expect(store.content).toBe('')
    expect(store.loading).toBe(true)
    await store.loadChapter(0)
    expect(store.content).toBe('book-b/0 正文')
  })

  it('keeps the latest requested chapter if responses arrive out of order', async () => {
    const store = useReaderStore()
    await store.loadBook(first)
    const pending = deferred<string>()
    vi.mocked(getBookContent).mockReturnValueOnce(pending.promise)
    const earlier = store.loadChapter(0)
    await flushPromises()
    await store.loadChapter(1)
    pending.resolve('旧章节正文')
    await earlier

    expect(store.currentIndex).toBe(1)
    expect(store.content).toBe('book-a/1 正文')
  })

  it('does not restore an old session over an explicitly opened book', async () => {
    localStorage.setItem('reader-last-session', JSON.stringify({
      book: first, chapters: chaptersFor(first.bookUrl), currentIndex: 0,
      chapterScrollProgress: 0, updatedAt: 1,
    }))
    const store = useReaderStore()
    const pending = deferred<Book>()
    vi.mocked(getShelfBook).mockReturnValueOnce(pending.promise)
    const restoring = store.restorePersistedSession()
    await store.loadBook(second)
    await store.loadChapter(0)
    pending.resolve({ ...first })
    await restoring

    expect(store.book?.bookUrl).toBe(second.bookUrl)
    expect(store.content).toBe('book-b/0 正文')
  })

  it('invalidates pending loads and preloads when the reader is cleared', async () => {
    const store = useReaderStore()
    await store.loadBook(first)
    const pending = deferred<string>()
    vi.mocked(getBookContent).mockReturnValueOnce(pending.promise)
    const preload = store.preloadNextChapter(0)
    await flushPromises()
    store.clear()
    pending.resolve('旧书正文')
    await preload
    expect(store.book).toBeNull()
    expect(store.content).toBe('')
    expect(store.loading).toBe(false)
  })

  it('cancels the previous book preload timer and keeps preloading for the active book', async () => {
    const store = useReaderStore()
    await store.loadBook(first)
    await store.loadChapter(0)
    await store.loadBook(second)
    vi.mocked(getBookContent).mockClear()
    await vi.advanceTimersByTimeAsync(1500)
    expect(getBookContent).not.toHaveBeenCalled()

    await store.loadChapter(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(getBookContent).toHaveBeenCalledWith(expect.objectContaining({ chapterUrl: 'book-b/1' }))
    vi.mocked(getBookContent).mockClear()
    await store.loadChapter(1)
    expect(store.content).toBe('book-b/1 正文')
    expect(getBookContent).not.toHaveBeenCalled()
  })

  it.each(['content', 'catalog', 'source'] as const)('ignores a late %s refresh after switching books', async (operation) => {
    const store = useReaderStore()
    await store.loadBook(first)
    await store.loadChapter(0)
    const response = deferred<void>()
    if (operation === 'content') vi.mocked(getBookContent).mockImplementationOnce(async () => {
      await response.promise
      return '第一本刷新正文'
    })
    if (operation === 'catalog') vi.mocked(getChapterList).mockImplementationOnce(async () => {
      await response.promise
      return chaptersFor(first.bookUrl)
    })
    if (operation === 'source') vi.mocked(setBookSource).mockImplementationOnce(async () => {
      await response.promise
      return { ...first, origin: 'replacement-source' }
    })
    const refreshing = operation === 'content' ? store.refreshContent()
      : operation === 'catalog' ? store.refreshChapters()
        : store.switchSource(first.bookUrl, 'replacement-source')
    await flushPromises()
    // 仅旧请求延迟，新书正常加载。
    vi.mocked(getBookContent).mockImplementation(async ({ chapterUrl }) => `${chapterUrl} 正文`)
    vi.mocked(getChapterList).mockImplementation(async ({ bookUrl }) => chaptersFor(bookUrl!))
    await store.loadBook(second)
    await store.loadChapter(0)
    response.resolve()
    await refreshing

    expect(store.book?.bookUrl).toBe(second.bookUrl)
    expect(store.chapters).toEqual(chaptersFor(second.bookUrl))
    expect(store.content).toBe('book-b/0 正文')
  })

  it('can switch from an imported local TXT book to a browser-cached offline book', async () => {
    const localBook = { ...first, bookUrl: 'local-txt:first', origin: 'local-txt' }
    vi.mocked(getShelfBook).mockResolvedValueOnce(localBook)
    const store = useReaderStore()
    await store.loadBook(localBook)
    await store.loadChapter(0)
    expect(store.content).toBe('local-txt:first/0 正文')
    expect(getBrowserCachedChapter).not.toHaveBeenCalled()

    useAppStore().setOnlineStatus(false)
    vi.mocked(getShelfBook).mockRejectedValueOnce(new Error('offline'))
    vi.mocked(getBrowserCachedChapter).mockResolvedValueOnce('第二本的离线正文')
    await store.loadBook(second)
    await store.loadChapter(0)
    expect(store.content).toBe('第二本的离线正文')
    expect(getBrowserCachedChapter).toHaveBeenLastCalledWith(second.bookUrl, 'book-b/0')
  })
})

describe('continuous reading across books', () => {
  it('clears rendered chapters and rejects late chapters when switching or disposing', async () => {
    const store = useReaderStore()
    const scope = effectScope()
    const reader = scope.run(() => useContinuousReading(
      store, (text) => text, computed(() => true), computed(() => false), ref<HTMLElement>(),
    ))!
    try {
      await store.loadBook(first)
      await store.loadChapter(0)
      const pending = deferred<string>()
      vi.mocked(getBookContent).mockImplementation(async ({ chapterUrl }) => (
        chapterUrl === 'book-a/1' ? pending.promise : `${chapterUrl} 正文`
      ))
      await reader.initializeContinuousChapters(0)
      await flushPromises()
      expect(reader.continuousChapters.value[0]?.content).toBe('book-a/0 正文')

      await store.loadBook(second)
      expect(reader.continuousChapters.value).toEqual([])
      await store.loadChapter(0)
      await reader.initializeContinuousChapters(0)
      pending.resolve('第一本下一章')
      await flushPromises()
      expect(reader.continuousChapters.value.map((item) => item.content)).toEqual([
        'book-b/0 正文', 'book-b/1 正文',
      ])

      const afterDispose = deferred<string>()
      vi.mocked(getBookContent).mockReturnValueOnce(afterDispose.promise)
      const initialization = reader.initializeContinuousChapters(2)
      await flushPromises()
      reader.disposeContinuousReading()
      afterDispose.resolve('已卸载页面的正文')
      await initialization
      expect(store.content).toBe('book-b/0 正文')
    } finally {
      reader.disposeContinuousReading()
      scope.stop()
    }
  })
})

describe('reader view book switching', () => {
  it.each(['上下滑动', '左右翻页', '上下滚动', '上下滚动2'] as const)(
    'renders only the selected book in %s mode when mounted during a slow book lookup',
    async (readMethod) => {
      const store = useReaderStore()
      store.config.readMethod = readMethod
      await store.loadBook(first)
      await store.loadChapter(0)
      const pending = deferred<Book>()
      vi.mocked(getShelfBook).mockReturnValueOnce(pending.promise)
      const opening = store.loadBook(second)
      const router = createRouter({
        history: createMemoryHistory(), routes: [{ path: '/reader', component: ReaderView }],
      })
      await router.push('/reader')
      await router.isReady()
      const wrapper = shallowMount(ReaderView, {
        global: {
          plugins: [router],
          stubs: { ReaderTtsPanel: true, ReaderSearchPanel: true, BookDetailModal: true },
        },
      })
      // 页面卸载时保存进度也留在测试环境内。
      const keepalive = vi.spyOn(store, 'flushProgressToServerKeepalive').mockImplementation(() => {})
      try {
        await flushPromises()
        expect(wrapper.text()).not.toContain('book-a/')
        expect(wrapper.find('.content-loading').exists()).toBe(true)
        pending.resolve({ ...second })
        await opening
        await store.loadChapter(0)
        await flushPromises()
        expect(wrapper.text()).toContain('book-b/0 正文')
        expect(wrapper.text()).not.toContain('book-a/')

        // 阅读器内再次切书时复用同一个组件，也必须清掉连续章节。
        await store.loadBook(first)
        await store.loadChapter(0)
        await flushPromises()
        expect(wrapper.text()).toContain('book-a/0 正文')
        expect(wrapper.text()).not.toContain('book-b/')
      } finally {
        wrapper.unmount()
        keepalive.mockRestore()
      }
    },
  )
})

// A book's detail page and its chapter URLs need not share a path or host.
describe('explicit cache ownership', () => {
  it('sends book identity for reading, preloading and forced refresh', async () => {
    const store = useReaderStore()
    const chapter = { index: 0, title: '第一章', url: 'https://cdn.example/text/42' }
    vi.mocked(getChapterList).mockResolvedValue([chapter])
    // Searching and reading before adding to the shelf must still identify the book.
    vi.mocked(getShelfBook).mockRejectedValueOnce(new Error('not on shelf'))
    await store.loadBook(first)
    await store.loadChapter(0)
    await store.preloadNextChapter(0)
    await store.refreshContent()
    for (const [request] of vi.mocked(getBookContent).mock.calls) {
      expect(request).toEqual(expect.objectContaining({ bookUrl: first.bookUrl, chapterUrl: chapter.url }))
    }
  })

  it('sends the same identity when downloading chapters for offline reading', async () => {
    await cacheBookToBrowser({ book: second, chapters: chaptersFor(second.bookUrl), count: 2 })
    expect(getBookContent).toHaveBeenCalledTimes(2)
    for (const [request] of vi.mocked(getBookContent).mock.calls) {
      expect(request).toEqual(expect.objectContaining({ bookUrl: second.bookUrl }))
    }
  })
})
