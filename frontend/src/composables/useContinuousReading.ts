import { nextTick, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { useReaderStore } from '../stores/reader'

type ReaderStore = ReturnType<typeof useReaderStore>

export interface ContinuousChapterItem {
  index: number
  title: string
  content: string
  html: string
}

export function useContinuousReading(
  store: ReaderStore,
  renderChapterHtml: (rawText: string) => string,
  isContinuousMode: ComputedRef<boolean>,
  hideReadChaptersMode: ComputedRef<boolean>,
  scrollContainerRef: Ref<HTMLElement | undefined>,
) {
  const continuousChapters = ref<ContinuousChapterItem[]>([])
  const continuousLoadingNext = ref(false)
  const continuousLoadingPrev = ref(false)
  const suppressContinuousSync = ref(false)
  let continuousStateSyncTimer: number | null = null
  let generation = 0
  let disposed = false
  const stopSessionWatch = watch(() => store.bookSessionId, clearContinuousChapters, { flush: 'sync' })

  function isCurrent(requestGeneration: number) {
    return !disposed && requestGeneration === generation && isContinuousMode.value
  }

  function shouldHideChapter(index: number, keepIndex?: number) {
    if (!hideReadChaptersMode.value) return false
    if (typeof keepIndex === 'number' && index === keepIndex) return false
    return store.isChapterRead(index)
  }

  function findNextVisibleIndex(startIndex: number, keepIndex?: number) {
    for (let index = startIndex; index < store.chapters.length; index += 1) {
      if (!shouldHideChapter(index, keepIndex)) {
        return index
      }
    }
    return -1
  }

  function pruneReadChapters(targetIndex = store.currentIndex) {
    if (!hideReadChaptersMode.value) return
    continuousChapters.value = continuousChapters.value.filter((chapter) => chapter.index >= targetIndex)
  }

  async function buildContinuousChapter(index: number, forceRefresh = false) {
    const requestGeneration = generation
    const chapter = store.chapters[index]
    if (!chapter) return null
    let chapterContent: string | null
    try {
      chapterContent = await store.fetchChapterContent(index, forceRefresh)
    } catch (error) {
      if (!isCurrent(requestGeneration)) return null
      throw error
    }
    if (!isCurrent(requestGeneration) || chapterContent == null) return null
    return {
      index,
      title: chapter.title,
      content: chapterContent,
      html: renderChapterHtml(chapterContent),
    } satisfies ContinuousChapterItem
  }

  function syncContinuousChapterHtml() {
    continuousChapters.value = continuousChapters.value.map((chapter) => ({
      ...chapter,
      html: renderChapterHtml(chapter.content),
    }))
  }

  function getContinuousChapter(index: number) {
    return continuousChapters.value.find((chapter) => chapter.index === index) || null
  }

  function setContinuousActiveChapter(index: number, chapterContent: string, progress: number) {
    suppressContinuousSync.value = true
    store.setActiveChapterState(index, chapterContent, progress)
    store.markChapterAsRead(index)
    void store.persistProgress(index)
    if (continuousStateSyncTimer) {
      clearTimeout(continuousStateSyncTimer)
    }
    continuousStateSyncTimer = window.setTimeout(() => {
      suppressContinuousSync.value = false
    }, 0)
  }

  async function initializeContinuousChapters(targetIndex = store.currentIndex, smooth = false) {
    if (disposed || !isContinuousMode.value || store.loading || store.chaptersLoading || !store.chapters[targetIndex]) return
    clearContinuousChapters()
    const requestGeneration = generation

    const current = await buildContinuousChapter(targetIndex)
    if (!isCurrent(requestGeneration) || !current) return

    continuousChapters.value = [current]
    const initialProgress = targetIndex === store.currentIndex ? store.chapterScrollProgress : 0
    setContinuousActiveChapter(targetIndex, current.content, initialProgress)

    await nextTick()
    if (!isCurrent(requestGeneration)) return
    if (initialProgress <= 0) {
      scrollToContinuousChapter(targetIndex, smooth)
    }

    const nextIndex = hideReadChaptersMode.value
      ? findNextVisibleIndex(targetIndex + 1, targetIndex)
      : targetIndex + 1
    if (nextIndex < 0) return

    void (async () => {
      const next = await buildContinuousChapter(nextIndex)
      if (!isCurrent(requestGeneration) || !next) return
      if (continuousChapters.value.some((chapter) => chapter.index === next.index)) return
      continuousChapters.value = [...continuousChapters.value, next]
    })().catch(() => undefined)
  }

  async function syncContinuousToStoreState() {
    if (!isContinuousMode.value || suppressContinuousSync.value || store.loading || !store.chapters[store.currentIndex]) return

    pruneReadChapters(store.currentIndex)
    const current = getContinuousChapter(store.currentIndex)
    if (current) {
      if (current.content !== store.content) {
        current.content = store.content
        current.html = renderChapterHtml(store.content)
      }
      return
    }

    await initializeContinuousChapters(store.currentIndex, false)
  }

  async function loadContinuousNext() {
    if (disposed || continuousLoadingNext.value || !continuousChapters.value.length) return
    const requestGeneration = generation
    const last = continuousChapters.value[continuousChapters.value.length - 1]
    const nextIndex = hideReadChaptersMode.value ? findNextVisibleIndex(last.index + 1, store.currentIndex) : last.index + 1
    if (nextIndex >= store.chapters.length) return

    continuousLoadingNext.value = true
    try {
      const next = await buildContinuousChapter(nextIndex)
      if (isCurrent(requestGeneration) && next && !getContinuousChapter(next.index)) {
        continuousChapters.value = [...continuousChapters.value, next]
      }
    } finally {
      if (isCurrent(requestGeneration)) continuousLoadingNext.value = false
    }
  }

  async function loadContinuousPrev() {
    if (disposed || hideReadChaptersMode.value) return
    if (continuousLoadingPrev.value || !continuousChapters.value.length) return
    const requestGeneration = generation
    const first = continuousChapters.value[0]
    const prevIndex = first.index - 1
    if (prevIndex < 0) return

    const container = scrollContainerRef.value
    const previousHeight = container?.scrollHeight || 0
    const previousTop = container?.scrollTop || 0

    continuousLoadingPrev.value = true
    try {
      const prev = await buildContinuousChapter(prevIndex)
      if (isCurrent(requestGeneration) && prev && !getContinuousChapter(prev.index)) {
        continuousChapters.value = [prev, ...continuousChapters.value]
        await nextTick()
        if (isCurrent(requestGeneration) && container) {
          const heightDiff = container.scrollHeight - previousHeight
          container.scrollTop = previousTop + heightDiff
        }
      }
    } finally {
      if (isCurrent(requestGeneration)) continuousLoadingPrev.value = false
    }
  }

  async function ensureContinuousChapterLoaded(index: number) {
    if (getContinuousChapter(index)) return
    if (!continuousChapters.value.length) {
      await initializeContinuousChapters(index, false)
      return
    }

    const requestGeneration = generation
    while (isCurrent(requestGeneration) && continuousChapters.value[0] && index < continuousChapters.value[0].index) {
      const firstIndex = continuousChapters.value[0].index
      await loadContinuousPrev()
      if (continuousChapters.value[0]?.index === firstIndex) break
    }

    while (
      isCurrent(requestGeneration) && continuousChapters.value[continuousChapters.value.length - 1]
      && index > continuousChapters.value[continuousChapters.value.length - 1].index
    ) {
      const lastIndex = continuousChapters.value[continuousChapters.value.length - 1].index
      await loadContinuousNext()
      if (continuousChapters.value[continuousChapters.value.length - 1]?.index === lastIndex) break
    }
  }

  function getContinuousSections() {
    const container = scrollContainerRef.value
    if (!container) return [] as HTMLElement[]
    return Array.from(container.querySelectorAll('.continuous-chapter')) as HTMLElement[]
  }

  function scrollToContinuousChapter(index: number, smooth = true) {
    const container = scrollContainerRef.value
    if (!container) return
    const section = container.querySelector(`.continuous-chapter[data-chapter-index="${index}"]`) as HTMLElement | null
    if (!section) return
    container.scrollTo({
      top: Math.max(0, section.offsetTop),
      behavior: smooth ? 'smooth' : 'auto',
    })
  }

  function clearContinuousChapters() {
    generation += 1
    continuousChapters.value = []
    continuousLoadingNext.value = false
    continuousLoadingPrev.value = false
    suppressContinuousSync.value = false
    if (continuousStateSyncTimer) clearTimeout(continuousStateSyncTimer)
    continuousStateSyncTimer = null
  }

  function disposeContinuousReading() {
    disposed = true
    stopSessionWatch()
    clearContinuousChapters()
  }

  return {
    continuousChapters,
    continuousLoadingNext,
    continuousLoadingPrev,
    suppressContinuousSync,
    syncContinuousChapterHtml,
    getContinuousChapter,
    setContinuousActiveChapter,
    initializeContinuousChapters,
    syncContinuousToStoreState,
    loadContinuousNext,
    loadContinuousPrev,
    ensureContinuousChapterLoaded,
    getContinuousSections,
    scrollToContinuousChapter,
    pruneReadChapters,
    clearContinuousChapters,
    disposeContinuousReading,
  }
}
