import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getBookSources } from '../api/source'
import type { BookSource } from '../types'

export const useSourceStore = defineStore('source', () => {
  const sources = ref<BookSource[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  let loadingTask: Promise<void> | null = null
  let generation = 0

  function reset() {
    generation++; sources.value = []; loaded.value = false; loading.value = false; loadingTask = null
  }

  async function fetchSources(options: { force?: boolean } = {}) {
    if (loaded.value && !options.force) return
    if (loadingTask) return loadingTask
    loading.value = true
    const epoch = generation
    loadingTask = getBookSources()
      .then((list) => {
        if (epoch !== generation) return
        sources.value = list
        loaded.value = true
      })
      .finally(() => {
        if (epoch !== generation) return
        loading.value = false
        loadingTask = null
      })
    return loadingTask
  }

  return {
    sources,
    loading,
    loaded,
    fetchSources,
    reset,
  }
})
