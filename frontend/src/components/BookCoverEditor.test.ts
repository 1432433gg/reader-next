import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import BookCoverEditor from './BookCoverEditor.vue'
import BookCard from './BookCard.vue'
import { prepareCoverFile } from '../utils/bookCover'
import { getCoverUrl, resetBookCover, uploadBookCover } from '../api/bookshelf'
import type { Book } from '../types'

vi.mock('../utils/bookCover', () => ({ prepareCoverFile: vi.fn() }))
vi.mock('../api/bookshelf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/bookshelf')>()
  return { ...actual, uploadBookCover: vi.fn(), resetBookCover: vi.fn() }
})
vi.mock('../stores/bookshelf', () => ({ useBookshelfStore: () => ({ newChapterCountFor: () => 0 }) }))

const coverUrl = '/reader3/bookCover/12345678-1234-4234-8234-123456789abc'
const book: Book = { name: '本地书', author: '', bookUrl: 'local://a', origin: 'local' }
const file = new File(['image'], 'cover.jpg', { type: 'image/jpeg' })

async function choose(wrapper: ReturnType<typeof mount>) {
  const input = wrapper.get('input').element as HTMLInputElement
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await wrapper.get('input').trigger('change')
  await flushPromises()
}
function button(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button').find((b) => b.text() === text)!
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.mocked(prepareCoverFile).mockResolvedValue(file)
  vi.mocked(uploadBookCover).mockResolvedValue({ ...book, customCoverUrl: coverUrl })
  vi.mocked(resetBookCover).mockResolvedValue({ ...book, customCoverUrl: undefined })
})

describe('custom book covers', () => {
  it('uses a direct URL for uploaded images and keeps the remote proxy for source images', () => {
    expect(getCoverUrl(coverUrl)).toBe(coverUrl)
    expect(getCoverUrl('https://example.com/a.jpg')).toContain('/reader3/cover?path=')
  })

  it('previews without uploading, cancels and releases preview URLs', async () => {
    const wrapper = mount(BookCoverEditor, { props: { book } })
    await choose(wrapper)
    expect(wrapper.text()).toContain('尚未保存')
    expect(wrapper.get('img').attributes('src')).toBe('blob:preview')
    expect(uploadBookCover).not.toHaveBeenCalled()
    await button(wrapper, '取消').trigger('click')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview')
    wrapper.unmount()
  })

  it('saves to the correct book and updates the displayed cover', async () => {
    const current = reactive({ ...book })
    const wrapper = mount(BookCoverEditor, { props: { book: current, onSaved: (saved: Book) => Object.assign(current, saved) } })
    await choose(wrapper)
    await button(wrapper, '保存封面').trigger('click')
    await flushPromises()
    expect(uploadBookCover).toHaveBeenCalledWith(book.bookUrl, file)
    expect(wrapper.get('img').attributes('src')).toBe(coverUrl)
    expect(wrapper.text()).toContain('封面已保存')
    wrapper.unmount()
  })

  it('keeps the preview and original cover when upload fails, allowing retry', async () => {
    vi.mocked(uploadBookCover).mockRejectedValueOnce(new Error('网络断开'))
    const wrapper = mount(BookCoverEditor, { props: { book: { ...book, customCoverUrl: coverUrl } } })
    await choose(wrapper)
    await button(wrapper, '保存封面').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('网络断开')
    expect(wrapper.emitted('saved')).toBeUndefined()
    expect(wrapper.get('img').attributes('src')).toBe('blob:preview')
    await button(wrapper, '取消').trigger('click')
    expect(wrapper.get('img').attributes('src')).toBe(coverUrl)
    wrapper.unmount()
  })

  it('restores the source cover without changing other book fields', async () => {
    const current = reactive({ ...book, coverUrl: 'https://example.com/source.jpg', customCoverUrl: coverUrl })
    const wrapper = mount(BookCoverEditor, { props: { book: current, onSaved: (saved: Book) => { current.customCoverUrl = saved.customCoverUrl! } } })
    await button(wrapper, '恢复默认').trigger('click')
    await flushPromises()
    expect(resetBookCover).toHaveBeenCalledWith(book.bookUrl)
    expect(wrapper.get('img').attributes('src')).toBe(getCoverUrl(current.coverUrl))
    wrapper.unmount()
  })

  it('discards a slow image selection when the selected book changes', async () => {
    let resolve!: (file: File) => void
    vi.mocked(prepareCoverFile).mockImplementation(() => new Promise((r) => { resolve = r }))
    const wrapper = mount(BookCoverEditor, { props: { book } })
    await choose(wrapper)
    await wrapper.setProps({ book: { ...book, bookUrl: 'local://b' } })
    resolve(file)
    await flushPromises()
    expect(wrapper.text()).not.toContain('尚未保存')
    expect(uploadBookCover).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('recovers a failed card image when a new cover is saved', async () => {
    const wrapper = mount(BookCard, { props: { book: { ...book, coverUrl: 'https://example.com/broken.jpg' } } })
    await wrapper.get('img').trigger('error')
    expect(wrapper.find('img').exists()).toBe(false)
    await wrapper.setProps({ book: { ...book, customCoverUrl: coverUrl } })
    expect(wrapper.get('img').attributes('src')).toBe(coverUrl)
    wrapper.unmount()
  })
})
