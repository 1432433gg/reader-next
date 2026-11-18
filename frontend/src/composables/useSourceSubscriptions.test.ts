import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { useSourceSubscriptions } from './useSourceSubscriptions'
import * as api from '../api/sourceSubscriptions'
vi.mock('../api/sourceSubscriptions', () => ({ getSourceSubscriptions: vi.fn(), changeSourceSubscriptions: vi.fn() }))
let wrapper: ReturnType<typeof mount>
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); vi.stubGlobal('confirm', vi.fn(() => true))
  vi.mocked(api.getSourceSubscriptions).mockResolvedValue({ revision: 0, items: [] })
  vi.mocked(api.changeSourceSubscriptions).mockResolvedValue({ revision: 1, items: [{ url: 'https://source.example/?private=keep' }] })
})
afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals() })
function setup() {
  const account = ref<string | null>('alice'), visible = ref(false)
  let state!: ReturnType<typeof useSourceSubscriptions>
  wrapper = mount(defineComponent({ setup() { state = useSourceSubscriptions(account, visible); return () => null } }))
  return { account, visible, state }
}
describe('account subscription state', () => {
  it('discards delayed import timestamp context after URL edit, preserving unrelated retries', async () => {
    const { state } = setup()
    const old = state.captureContext('https://a.example', { name: 'A', existingOnly: true })
    state.beginEdit({ url: 'https://a.example', name: 'A' })
    state.editDraft.value!.newUrl = 'https://new.example'
    expect(await state.saveEdit()).toBe(true)
    vi.mocked(api.changeSourceSubscriptions).mockClear()
    expect(await state.markSynced('https://a.example', old)).toBe(false)
    expect(api.changeSourceSubscriptions).not.toHaveBeenCalled()
    expect(state.pendingTimestamps.value).toEqual([])
  })
  it('keeps editing snapshot across refresh/conflict and only invalidates the changed URL retry', async () => {
    const { state } = setup()
    state.beginEdit({ url: 'https://a.example', name: '旧名', lastSyncedAt: 100 })
    state.editDraft.value!.name = '新名😀'
    state.editDraft.value!.newUrl = 'https://new.example/?q=保留'
    await state.refresh()
    expect(state.editDraft.value!.expectedName).toBe('旧名')
    expect(state.editDraft.value!.name).toBe('新名😀')
    vi.mocked(api.changeSourceSubscriptions).mockRejectedValueOnce(new Error('failure'))
    await state.markSynced('https://a.example', { name: '旧名', existingOnly: true })
    vi.mocked(api.changeSourceSubscriptions).mockRejectedValueOnce(new Error('failure'))
    await state.markSynced('https://b.example', { name: '另名', existingOnly: true })
    vi.mocked(api.changeSourceSubscriptions).mockRejectedValueOnce(new Error('conflict'))
    expect(await state.saveEdit()).toBe(false)
    expect(state.editDraft.value!.name).toBe('新名😀')
    expect(await state.saveEdit()).toBe(true)
    expect(state.pendingTimestamps.value).toEqual(['https://b.example'])
    await state.retryTimestamp('https://b.example')
    expect(vi.mocked(api.changeSourceSubscriptions).mock.calls.at(-1)?.[0]).toEqual({ operation: 'synced', url: 'https://b.example', name: '另名', existingOnly: true })
    expect(state.editDraft.value).toBe(null)
  })
  it('retains A after B succeeds, retains both failures, and clears only the URL retried', async () => {
    const { state, account } = setup()
    vi.mocked(api.changeSourceSubscriptions).mockRejectedValueOnce(new Error('A failed'))
    await state.markSynced('https://a.example')
    await state.markSynced('https://b.example')
    expect(state.pendingTimestamps.value).toEqual(['https://a.example'])
    vi.mocked(api.changeSourceSubscriptions).mockRejectedValueOnce(new Error('B failed'))
    await state.markSynced('https://b.example')
    expect(state.pendingTimestamps.value).toEqual(['https://a.example', 'https://b.example'])
    vi.mocked(api.changeSourceSubscriptions).mockRejectedValueOnce(new Error('A failed again'))
    await state.markSynced('https://a.example')
    expect(state.pendingTimestamps.value).toHaveLength(2)
    await state.markSynced('https://b.example')
    expect(state.pendingTimestamps.value).toEqual(['https://a.example'])
    await state.markSynced('https://a.example')
    expect(state.pendingTimestamps.value).toEqual([])
    vi.mocked(api.changeSourceSubscriptions).mockRejectedValueOnce(new Error('A failed'))
    await state.markSynced('https://a.example')
    account.value = 'other'
    expect(state.pendingTimestamps.value).toEqual([])
  })
  it('refreshes an open panel when returning to the foreground', async () => {
    const { state, visible } = setup()
    visible.value = true; await flushPromises()
    vi.mocked(api.getSourceSubscriptions).mockResolvedValue({ revision: 2, items: [{ url: 'https://another-device.example' }] })
    window.dispatchEvent(new Event('focus')); await flushPromises()
    expect(state.items.value).toEqual([{ url: 'https://another-device.example' }])
    expect(api.getSourceSubscriptions).toHaveBeenCalledTimes(2)
  })
  it('ignores delayed reads and mutations after changing accounts', async () => {
    const { account, state } = setup()
    let finish!: (value: api.SubscriptionDocument) => void
    vi.mocked(api.getSourceSubscriptions).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const pending = state.refresh()
    account.value = 'bob'
    expect(vi.mocked(api.getSourceSubscriptions).mock.calls[0]?.[0]?.aborted).toBe(true)
    finish({ revision: 1, items: [{ url: 'https://alice.example' }] }); await pending
    expect(state.items.value).toEqual([])
    let finishWrite!: (value: api.SubscriptionDocument) => void
    vi.mocked(api.changeSourceSubscriptions).mockImplementationOnce(() => new Promise((resolve) => { finishWrite = resolve }))
    const write = state.mutate({ operation: 'add', url: 'https://bob.example' })
    account.value = null
    expect(vi.mocked(api.changeSourceSubscriptions).mock.calls[0]?.[1]?.aborted).toBe(true)
    finishWrite({ revision: 1, items: [{ url: 'https://bob.example' }] }); expect(await write).toBe(false)
    expect(state.items.value).toEqual([]); expect(state.busy.value).toBe(false)
  })
  it('does not let an old read overwrite a mutation, and retains good data on read failure', async () => {
    const { state } = setup()
    let finish!: (value: api.SubscriptionDocument) => void
    vi.mocked(api.getSourceSubscriptions).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const pending = state.refresh()
    expect(await state.mutate({ operation: 'add', url: 'https://source.example/?private=keep' })).toBe(true)
    finish({ revision: 0, items: [] }); await pending
    expect(state.items.value).toHaveLength(1)
    vi.mocked(api.getSourceSubscriptions).mockRejectedValue(new Error('offline'))
    await state.refresh()
    expect(state.error.value).toContain('读取订阅失败'); expect(state.items.value).toHaveLength(1)
  })
  it('migrates only on explicit account confirmation; preserves old records and does not resurrect deleted records', async () => {
    const legacy = [{ url: ' https://source.example/?private=keep ', lastSyncedAt: 12345 }]
    localStorage.setItem('reader-source-subscriptions', JSON.stringify(legacy))
    const { account, state, visible } = setup()
    visible.value = true; await flushPromises()
    expect(api.changeSourceSubscriptions).not.toHaveBeenCalled()
    await state.migrate()
    expect(api.changeSourceSubscriptions).toHaveBeenCalledWith({ operation: 'migrate', items: [{ url: 'https://source.example/?private=keep', lastSyncedAt: 12345 }] }, expect.anything())
    expect(localStorage.getItem('reader-source-subscriptions')).toBe(JSON.stringify(legacy))
    expect(state.migrationAvailable.value).toBe(false)
    vi.mocked(api.changeSourceSubscriptions).mockClear()
    visible.value = false; visible.value = true; await state.refresh()
    expect(state.items.value).toEqual([]); expect(api.changeSourceSubscriptions).not.toHaveBeenCalled()
    account.value = 'bob'; await flushPromises()
    expect(state.migrationAvailable.value).toBe(true)
    expect(api.changeSourceSubscriptions).not.toHaveBeenCalled()
  })
  it('retains retry state on failed migration or timestamp update, without importing sources', async () => {
    localStorage.setItem('reader-source-subscriptions', JSON.stringify([{ url: 'https://old.example' }]))
    const { state } = setup()
    vi.mocked(api.changeSourceSubscriptions).mockRejectedValue(new Error('offline'))
    await state.migrate(); expect(state.migrationAvailable.value).toBe(true)
    expect(await state.markSynced('https://source.example')).toBe(false)
    expect(state.pendingTimestamp.value).toBe('https://source.example')
    vi.mocked(api.changeSourceSubscriptions).mockResolvedValue({ revision: 2, items: [] })
    await state.markSynced(state.pendingTimestamp.value!)
    expect(state.pendingTimestamp.value).toBe(null)
    expect(vi.mocked(api.changeSourceSubscriptions).mock.calls.at(-1)?.[0]).toEqual({ operation: 'synced', url: 'https://source.example' })
  })
  it('keeps authoritative records and reports failure for both add and delete errors', async () => {
    vi.mocked(api.getSourceSubscriptions).mockResolvedValue({ revision: 1, items: [{ url: 'https://existing.example' }] })
    const { state } = setup(); await state.refresh()
    vi.mocked(api.changeSourceSubscriptions).mockRejectedValue(new Error('controlled write failure'))
    for (const operation of ['add', 'remove'] as const) {
      expect(await state.mutate({ operation, url: 'https://existing.example' })).toBe(false)
      expect(state.error.value).toContain('同步失败')
      expect(state.items.value).toEqual([{ url: 'https://existing.example' }])
      expect(state.pendingTimestamp.value).toBe(null)
    }
  })
})
