import { afterEach, expect, it, vi } from 'vitest'
import http from './http'
import { changeSourceSubscriptions } from './sourceSubscriptions'
const originalAdapter = http.defaults.adapter
afterEach(() => { http.defaults.adapter = originalAdapter; localStorage.clear() })
it('cancels queued mutations before dispatch when credentials change in the interceptor microtask', async () => {
  const adapter = vi.fn()
  http.defaults.adapter = adapter
  localStorage.setItem('accessToken', 'alice:controlled-token')
  const controller = new AbortController()
  const pending = changeSourceSubscriptions({ operation: 'add', url: 'https://controlled.example' }, controller.signal)
  localStorage.setItem('accessToken', 'bob:controlled-token')
  controller.abort()
  await expect(pending).rejects.toThrow()
  expect(adapter).not.toHaveBeenCalled()
})
