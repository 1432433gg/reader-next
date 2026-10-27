import type { ComputedRef, Ref } from 'vue'
import type { useReaderStore } from '../stores/reader'

type ReaderStore = ReturnType<typeof useReaderStore>

interface AutoPlaybackConfig {
  autoPageMode: string
  clickAction: string
  scrollPixel: number
  pageSpeed: number
  fontSize: number
  lineHeight: number
}

export function useReaderAutoPlayback(
  store: ReaderStore,
  config: ComputedRef<AutoPlaybackConfig>,
  isContinuousMode: ComputedRef<boolean>,
  scrollContainerRef: Ref<HTMLElement | undefined>,
  chapterTextRef: Ref<HTMLElement | undefined>,
  nextChapter: () => void | Promise<void>,
  prevChapter: () => void | Promise<void>,
) {
  let autoScrollId: number | null = null
  let autoParagraphTimer: number | null = null
  let autoReadingParagraphIndex = -1
  let autoReadingProcessing = false
  let speechRestartTimer: number | null = null
  let isSpeechTransitioning = false

  function isSafariSpeechDelayBrowser() {
    if (typeof navigator === 'undefined') return false
    const ua = navigator.userAgent || ''
    return /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|EdgiOS|Android/i.test(ua)
  }

  function paragraphPreview(paragraph: HTMLElement | null) {
    return paragraph?.innerText.trim().slice(0, 40) || ''
  }

  function logSpeech(message: string, payload?: unknown) {
    void message
    void payload
  }

  function getFilteredParagraphs() {
    const roots = isContinuousMode.value
      ? Array.from(scrollContainerRef.value?.querySelectorAll('.chapter-text[data-role="continuous"]') || []) as HTMLElement[]
      : (chapterTextRef.value ? [chapterTextRef.value] : [])
    if (!roots.length) return [] as HTMLElement[]
    const allElements = roots.flatMap((root) => Array.from(root.querySelectorAll('p')) as HTMLElement[])
    const list: HTMLElement[] = []
    let lastText = ''
    allElements.forEach((el) => {
      const text = el.innerText.trim()
      if (text && text !== lastText) {
        list.push(el)
        lastText = text
      }
    })
    return list
  }

  function getCurrentParagraph() {
    const reading = chapterTextRef.value?.querySelector('.reading') as HTMLElement | null
    if (reading) return reading

    const container = scrollContainerRef.value
    if (!container) return null

    const list = getFilteredParagraphs()
    for (const paragraph of list) {
      const top = paragraph.offsetTop - container.scrollTop
      const bottom = top + paragraph.offsetHeight
      if (bottom > 40) {
        return paragraph
      }
    }

    return list[0] || null
  }

  function getPrevParagraph() {
    const current = getCurrentParagraph()
    return getPrevParagraphFrom(current)
  }

  function getPrevParagraphFrom(current: HTMLElement | null) {
    const list = getFilteredParagraphs()
    const index = current ? list.indexOf(current) : -1
    if (index > 0) return list[index - 1]
    return null
  }

  function getNextParagraph() {
    const current = getCurrentParagraph()
    return getNextParagraphFrom(current)
  }

  function getNextParagraphFrom(current: HTMLElement | null) {
    const list = getFilteredParagraphs()
    const index = current ? list.indexOf(current) : -1
    if (index >= 0 && index < list.length - 1) return list[index + 1]
    return null
  }

  function resetSpeechChunkState() {
    // 系统语音逐段朗读，没有分块状态需要重置
  }

  function ensureSpeechChunkState(paragraph: HTMLElement) {
    return {
      text: paragraph.innerText.trim(),
      nextParagraph: getNextParagraphFrom(paragraph),
    }
  }

  function clearReadingClass() {
    scrollContainerRef.value?.querySelectorAll('.reading').forEach((el) => el.classList.remove('reading'))
  }

  function showParagraph(paragraph: HTMLElement | null, smooth = true) {
    const container = scrollContainerRef.value
    if (!container || !paragraph) return

    const targetTop = Math.max(0, paragraph.offsetTop - 24)
    container.scrollTo({
      top: targetTop,
      behavior: smooth ? 'smooth' : 'auto',
    })
  }

  function markReadingParagraph(paragraph: HTMLElement | null) {
    clearReadingClass()
    if (paragraph) {
      paragraph.classList.add('reading')
    }
  }

  function runAutoScroll() {
    if (!store.isAutoScrolling || !scrollContainerRef.value) return

    const container = scrollContainerRef.value
    const speed = Math.max(1, config.value.scrollPixel) * (config.value.pageSpeed / 1000) * 0.5

    container.scrollTop += speed

    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) {
      if (config.value.clickAction === 'auto' && store.hasNext) {
        void nextChapter()
      } else {
        stopAutoScroll()
      }
    } else {
      autoScrollId = requestAnimationFrame(runAutoScroll)
    }
  }

  function runAutoParagraph() {
    if (!store.isAutoScrolling) return
    if (autoReadingProcessing) return

    const list = getFilteredParagraphs()
    if (!list.length) return

    autoReadingProcessing = true

    if (autoReadingParagraphIndex < 0) {
      const current = getCurrentParagraph()
      autoReadingParagraphIndex = current ? Math.max(0, list.indexOf(current)) : 0
    }

    if (autoReadingParagraphIndex >= list.length) {
      autoReadingParagraphIndex = -1
      autoReadingProcessing = false
      if (store.hasNext) {
        Promise.resolve(nextChapter()).then(() => {
          window.setTimeout(() => {
            if (store.isAutoScrolling && config.value.autoPageMode === 'paragraph') {
              runAutoParagraph()
            }
          }, 300)
        })
      } else {
        stopAutoScroll()
      }
      return
    }

    const current = list[autoReadingParagraphIndex]
    markReadingParagraph(current)
    showParagraph(current)

    const estimatedLineCount = Math.max(1, Math.ceil(current.offsetHeight / (config.value.fontSize * config.value.lineHeight)))
    const delayTime = Math.max(300, config.value.pageSpeed * estimatedLineCount)

    autoReadingProcessing = false
    autoParagraphTimer = window.setTimeout(() => {
      autoReadingParagraphIndex += 1
      runAutoParagraph()
    }, delayTime)
  }

  function startAutoScroll() {
    if (config.value.autoPageMode === 'paragraph') {
      if (autoParagraphTimer) return
      runAutoParagraph()
      return
    }
    if (autoScrollId) return
    runAutoScroll()
  }

  function stopAutoScroll() {
    store.isAutoScrolling = false
    autoReadingParagraphIndex = -1
    autoReadingProcessing = false
    if (autoScrollId) {
      cancelAnimationFrame(autoScrollId)
      autoScrollId = null
    }
    if (autoParagraphTimer) {
      clearTimeout(autoParagraphTimer)
      autoParagraphTimer = null
    }
    if (!store.isSpeaking) {
      clearReadingClass()
    }
  }

  function restartSpeechTarget(paragraph: HTMLElement | null, interruptCurrent = true) {
    logSpeech('restartSpeechTarget', {
      interruptCurrent,
      paragraph: paragraphPreview(paragraph),
      isSpeechTransitioning,
    })
    if (!paragraph) {
      store.stopTTS()
      resetSpeechChunkState()
      return
    }
    if (isSpeechTransitioning) return
    isSpeechTransitioning = true
    resetSpeechChunkState()
    if (interruptCurrent) {
      store.stopTTS(false)
    }
    if (speechRestartTimer) {
      clearTimeout(speechRestartTimer)
    }
    const restartDelay = !interruptCurrent
      ? ((isSafariSpeechDelayBrowser() && !store.systemTtsNativeEventsReliable) ? 160 : 40)
      : 150
    speechRestartTimer = window.setTimeout(() => {
      if (store.isPaused) {
        isSpeechTransitioning = false
        return
      }
      isSpeechTransitioning = false
      startSpeech(paragraph, interruptCurrent)
    }, restartDelay)
  }

  function continueSpeechTarget(paragraph: HTMLElement | null, resetChunks = true) {
    logSpeech('continueSpeechTarget', {
      resetChunks,
      paragraph: paragraphPreview(paragraph),
      hasNextChapter: store.hasNext,
    })
    if (speechRestartTimer) {
      clearTimeout(speechRestartTimer)
    }

    const continueDelay = (isSafariSpeechDelayBrowser() && !store.systemTtsNativeEventsReliable) ? 160 : 40

    if (paragraph) {
      isSpeechTransitioning = true
      if (resetChunks) {
        resetSpeechChunkState()
      }
      speechRestartTimer = window.setTimeout(() => {
        if (store.isPaused) {
          isSpeechTransitioning = false
          return
        }
        isSpeechTransitioning = false
        startSpeech(paragraph, false)
      }, continueDelay)
      return
    }

    if (!store.hasNext) {
      store.stopTTS()
      clearReadingClass()
      return
    }

    isSpeechTransitioning = true
    if (resetChunks) {
      resetSpeechChunkState()
    }
    Promise.resolve(nextChapter())
      .then(() => {
        speechRestartTimer = window.setTimeout(() => {
          if (store.isPaused) {
            isSpeechTransitioning = false
            return
          }
          isSpeechTransitioning = false
          startSpeech(getFilteredParagraphs()[0] || null, false)
        }, continueDelay)
      })
      .catch(() => {
        isSpeechTransitioning = false
      })
  }

  function startSpeech(paragraph?: HTMLElement | null, interruptCurrent = true) {
    const current = paragraph || getCurrentParagraph()
    logSpeech('startSpeech', {
      interruptCurrent,
      paragraph: paragraphPreview(current),
      currentIndex: store.currentIndex,
    })
    if (!current?.innerText.trim()) {
      if (interruptCurrent) {
        speechNext()
      } else {
        continueSpeechTarget(getNextParagraph())
      }
      return
    }

    markReadingParagraph(current)
    showParagraph(current)
    const chunk = ensureSpeechChunkState(current)
    if (!chunk.text.trim()) {
      if (interruptCurrent) {
        speechNext(chunk.nextParagraph)
      } else {
        continueSpeechTarget(chunk.nextParagraph)
      }
      return
    }
    const nextParagraph = chunk.nextParagraph
    logSpeech('speak chunk', {
      interruptCurrent,
      text: chunk.text.slice(0, 60),
      nextParagraph: paragraphPreview(nextParagraph),
    })
    store.startTTS(chunk.text, {
      onEnd: () => {
        logSpeech('chunk onEnd', {
          currentParagraph: paragraphPreview(current),
          nextParagraph: paragraphPreview(nextParagraph),
        })
        continueSpeechTarget(nextParagraph)
      },
      onError: () => {
        logSpeech('chunk onError', {
          currentParagraph: paragraphPreview(current),
          nextParagraph: paragraphPreview(nextParagraph),
        })
        resetSpeechChunkState()
        clearReadingClass()
      },
    }, interruptCurrent)
  }

  function speechPrev() {
    logSpeech('speechPrev', {
      currentParagraph: paragraphPreview(getCurrentParagraph()),
      hasPrevChapter: store.hasPrev,
    })
    resetSpeechChunkState()
    const prev = getPrevParagraph()
    if (prev) {
      restartSpeechTarget(prev)
      return
    }
    if (!store.hasPrev) {
      store.stopTTS()
      return
    }
    store.stopTTS(false)
    Promise.resolve(prevChapter()).then(() => {
      window.setTimeout(() => {
        const list = getFilteredParagraphs()
        restartSpeechTarget(list[list.length - 1] || null)
      }, 120)
    })
  }

  function speechNext(forcedNext?: HTMLElement | null, interruptCurrent = true) {
    logSpeech('speechNext', {
      interruptCurrent,
      forcedNext: paragraphPreview(forcedNext || null),
      currentParagraph: paragraphPreview(getCurrentParagraph()),
      hasNextChapter: store.hasNext,
    })
    resetSpeechChunkState()
    const next = forcedNext ?? getNextParagraph()
    if (next) {
      restartSpeechTarget(next, interruptCurrent)
      return
    }
    if (!store.hasNext) {
      store.stopTTS()
      clearReadingClass()
      return
    }
    if (interruptCurrent) {
      store.stopTTS(false)
    }
    Promise.resolve(nextChapter()).then(() => {
      window.setTimeout(() => {
        restartSpeechTarget(getFilteredParagraphs()[0] || null)
      }, 120)
    })
  }

  function restartSpeechFromCurrentParagraph() {
    logSpeech('restartSpeechFromCurrentParagraph', {
      currentParagraph: paragraphPreview(getCurrentParagraph()),
      isSpeechTransitioning,
    })
    if (isSpeechTransitioning) return
    isSpeechTransitioning = true
    resetSpeechChunkState()
    store.stopTTS(false)
    if (speechRestartTimer) {
      clearTimeout(speechRestartTimer)
    }
    speechRestartTimer = window.setTimeout(() => {
      if (store.isPaused) {
        isSpeechTransitioning = false
        return
      }
      isSpeechTransitioning = false
      startSpeech()
    }, 150)
  }

  function cancelSpeechTransition() {
    if (speechRestartTimer) {
      clearTimeout(speechRestartTimer)
      speechRestartTimer = null
    }
    isSpeechTransitioning = false
  }

  function resetAutoParagraphIndex() {
    autoReadingParagraphIndex = -1
  }

  function handleContentChanged() {
    autoReadingParagraphIndex = -1
    if (store.isAutoScrolling && config.value.autoPageMode === 'paragraph') {
      if (autoParagraphTimer) {
        clearTimeout(autoParagraphTimer)
        autoParagraphTimer = null
      }
      window.setTimeout(() => {
        if (store.isAutoScrolling && config.value.autoPageMode === 'paragraph') {
          runAutoParagraph()
        }
      }, 100)
    }
  }

  function disposeAutoPlayback() {
    cancelSpeechTransition()
    stopAutoScroll()
  }

  return {
    getCurrentParagraph,
    clearReadingClass,
    startAutoScroll,
    stopAutoScroll,
    startSpeech,
    speechPrev,
    speechNext,
    restartSpeechFromCurrentParagraph,
    cancelSpeechTransition,
    resetAutoParagraphIndex,
    handleContentChanged,
    disposeAutoPlayback,
  }
}
