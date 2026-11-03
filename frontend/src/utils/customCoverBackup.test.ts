import { beforeEach, describe, expect, it, vi } from 'vitest'
import http from '../api/http'
import { uploadBookCover } from '../api/bookshelf'
import { captureCustomCovers, restoreCustomCovers, validateCustomCoverBackup } from './customCoverBackup'

vi.mock('../api/http', () => ({ default: { get: vi.fn() } }))
vi.mock('../api/bookshelf', () => ({ uploadBookCover: vi.fn() }))
const url = '/reader3/bookCover/12345678-1234-4234-8234-123456789abc'
const book = { name: '书', author: '', origin: 'local', bookUrl: 'local://a', customCoverUrl: url }

beforeEach(() => { vi.clearAllMocks() })

describe('portable custom cover backups', () => {
  it('embeds uploaded images once and restores them for each book', async () => {
    vi.mocked(http.get).mockResolvedValue({ data: new Blob(['jpeg'], { type: 'image/jpeg' }) })
    const covers = await captureCustomCovers([book, { ...book, bookUrl: 'local://b' }])
    expect(http.get).toHaveBeenCalledTimes(1)
    expect(covers[url]).toBe('data:image/jpeg;base64,anBlZw==')
    validateCustomCoverBackup(covers)
    await restoreCustomCovers([book], covers)
    expect(uploadBookCover).toHaveBeenCalledWith(book.bookUrl, expect.any(File))
  })
  it('does not fetch source URLs and accepts older backups without embedded covers', async () => {
    expect(await captureCustomCovers([{ ...book, customCoverUrl: 'https://example.com/cover.jpg' }])).toEqual({})
    validateCustomCoverBackup(undefined)
    await restoreCustomCovers([book])
    expect(http.get).not.toHaveBeenCalled()
    expect(uploadBookCover).not.toHaveBeenCalled()
  })
  it('rejects malformed cover backups before restore starts', () => {
    expect(() => validateCustomCoverBackup({ [url]: 'data:text/html;base64,AAA=' })).toThrow()
    expect(() => validateCustomCoverBackup({ [url]: 'data:image/jpeg;base64,%%%%' })).toThrow()
    expect(() => validateCustomCoverBackup({ '../file': 'data:image/jpeg;base64,AAAA' })).toThrow()
  })
})
