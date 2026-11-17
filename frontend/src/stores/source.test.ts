import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSourceStore } from './source'
import { getBookSources } from '../api/source'

vi.mock('../api/source', () => ({
  getBookSources: vi.fn(),
}))

describe('source store cache', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(getBookSources).mockReset()
  })

  it('does not refetch sources after they have loaded unless forced', async () => {
    vi.mocked(getBookSources)
      .mockResolvedValueOnce([
        { bookSourceName: 'A', bookSourceUrl: 'https://a.example', enabled: true },
      ] as never)
      .mockResolvedValueOnce([
        { bookSourceName: 'B', bookSourceUrl: 'https://b.example', enabled: true },
      ] as never)
    const store = useSourceStore()

    await store.fetchSources()
    await store.fetchSources()

    expect(getBookSources).toHaveBeenCalledTimes(1)
    expect(store.sources[0]?.bookSourceName).toBe('A')

    await store.fetchSources({ force: true })

    expect(getBookSources).toHaveBeenCalledTimes(2)
    expect(store.sources[0]?.bookSourceName).toBe('B')
  })
  it('does not let an old account request replace the new account list', async () => {
    let finish!: (value: { bookSourceName: string; bookSourceUrl: string }[]) => void
    vi.mocked(getBookSources).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const store = useSourceStore()
    const old = store.fetchSources()
    store.reset()
    vi.mocked(getBookSources).mockResolvedValue([{ bookSourceName: 'new account', bookSourceUrl: 'new' }])
    await store.fetchSources()
    finish([{ bookSourceName: 'old account', bookSourceUrl: 'old' }]); await old
    expect(store.sources.map((source) => source.bookSourceUrl)).toEqual(['new'])
  })
})
