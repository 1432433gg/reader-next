import { describe, expect, it } from 'vitest'
import { MAX_COVER_BYTES, validateCoverFile } from './bookCover'

describe('cover upload validation', () => {
  it('accepts supported MIME types and file-picker results without MIME', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      expect(() => validateCoverFile(new File(['x'], 'photo', { type }))).not.toThrow()
    }
    expect(() => validateCoverFile(new File(['x'], 'photo.JPG'))).not.toThrow()
  })
  it('rejects unsupported, empty and oversized images with useful feedback', () => {
    expect(() => validateCoverFile(new File(['x'], 'photo.heic', { type: 'image/heic' }))).toThrow('HEIC')
    expect(() => validateCoverFile(new File([], 'photo.jpg'))).toThrow('5MB')
    expect(() => validateCoverFile(new File([new Uint8Array(MAX_COVER_BYTES + 1)], 'photo.jpg'))).toThrow('5MB')
    expect(() => validateCoverFile(new File(['<svg/>'], 'fake.jpg', { type: 'image/svg+xml' }))).toThrow('支持')
  })
})
