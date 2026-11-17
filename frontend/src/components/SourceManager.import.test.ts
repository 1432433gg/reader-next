import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import SourceManager from './SourceManager.vue'
import SourceImportPreview from './source-manager/SourceImportPreview.vue'
import SourceSubscriptionPanel from './source-manager/SourceSubscriptionPanel.vue'
import * as api from '../api/source'
import * as subscriptionApi from '../api/sourceSubscriptions'
import { useAppStore } from '../stores/app'
import type { UserInfo } from '../types'

vi.mock('../api/sourceSubscriptions', () => ({ getSourceSubscriptions: vi.fn(), changeSourceSubscriptions: vi.fn() }))

vi.mock('../api/source', async (original) => ({
  ...await original<typeof import('../api/source')>(),
  getBookSources: vi.fn(), readSourceFile: vi.fn(), readRemoteSourceFile: vi.fn(), saveBookSources: vi.fn(),
}))
const pack = [
  { bookSourceName: '甲', bookSourceUrl: 'a', ruleSearch: { name: '@js: untouched' } },
  { bookSourceName: '乙', bookSourceUrl: 'b' },
]
let wrapper: ReturnType<typeof mount>
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  vi.mocked(api.getBookSources).mockResolvedValue([])
  vi.mocked(api.readSourceFile).mockResolvedValue(pack)
  vi.mocked(api.readRemoteSourceFile).mockResolvedValue([JSON.stringify(pack)])
  vi.mocked(api.saveBookSources).mockResolvedValue({ saved: true, count: 1 })
  vi.stubGlobal('confirm', vi.fn(() => true))
  vi.mocked(subscriptionApi.getSourceSubscriptions).mockResolvedValue({ revision: 0, items: [] })
  vi.mocked(subscriptionApi.changeSourceSubscriptions).mockResolvedValue({ revision: 1, items: [] })
  const pinia = createPinia()
  useAppStore(pinia).updateUserInfo({ username: 'test-account' } as UserInfo)
  wrapper = mount(SourceManager, { props: { modelValue: true }, global: { plugins: [pinia] }, attachTo: document.body })
})
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function open(entry: string) {
  await flushPromises()
  if (entry === 'local') {
    const input = new DOMWrapper(document.querySelector<HTMLInputElement>('input[type=file]')!)
    Object.defineProperty(input.element, 'files', { value: [new File(['[]'], 'sources.json')], configurable: true })
    await input.trigger('change')
  } else {
    const panel = wrapper.findComponent(SourceSubscriptionPanel)
    panel.vm.$emit('update:remoteUrl', 'https://package.example/only.json')
    await flushPromises()
    if (entry === 'subscription') { panel.vm.$emit('save'); await flushPromises(); panel.vm.$emit('sync-subscription', 'https://package.example/only.json') }
    else panel.vm.$emit('sync')
  }
  await flushPromises()
  return wrapper.findComponent(SourceImportPreview)
}
describe('three import entrypoints', () => {
  for (const entry of ['local', 'remote', 'subscription']) {
    it(`${entry}: does not save before confirmation, cancellation leaves sync time intact`, async () => {
      const preview = await open(entry)
      expect(preview.exists()).toBe(true)
      expect(api.saveBookSources).not.toHaveBeenCalled()
      expect(preview.get('.import-actions button:last-child').attributes('disabled')).toBeDefined()
      preview.vm.$emit('cancel')
      await flushPromises()
      expect(api.saveBookSources).not.toHaveBeenCalled()
      expect(vi.mocked(subscriptionApi.changeSourceSubscriptions).mock.calls.some(([operation]) => operation.operation === 'synced')).toBe(false)
    })
    it(`${entry}: saves only selected objects and updates time only after success`, async () => {
      const preview = await open(entry)
      await preview.get('input[type=checkbox]').setValue(true)
      await preview.get('.import-actions button:last-child').trigger('click')
      await flushPromises()
      expect(api.saveBookSources).toHaveBeenCalledExactlyOnceWith([pack[0]], expect.anything())
      if (entry !== 'local') {
        expect(api.readRemoteSourceFile).toHaveBeenCalledExactlyOnceWith('https://package.example/only.json', expect.anything())
        expect(subscriptionApi.changeSourceSubscriptions).toHaveBeenCalledWith({ operation: 'synced', url: 'https://package.example/only.json' }, expect.anything())
      }
    })
  }
  it('requires renewed confirmation on selected changes, preserves selection on rejection and failure, prevents duplicate submits', async () => {
    vi.mocked(api.getBookSources).mockResolvedValue([pack[0]!])
    const preview = await open('subscription')
    await preview.get('input[type=checkbox]').setValue(true)
    vi.mocked(api.getBookSources).mockResolvedValue([{ ...pack[0]!, bookSourceName: 'changed externally' }])
    await preview.get('.import-actions button:last-child').trigger('click'); await flushPromises()
    expect(api.saveBookSources).not.toHaveBeenCalled()
    expect(preview.text()).toContain('已变化')
    vi.mocked(window.confirm).mockReturnValue(false)
    await preview.get('.import-actions button:last-child').trigger('click'); await flushPromises()
    expect(window.confirm).toHaveBeenCalledWith('将更新 1 个现有书源，是否继续？')
    expect(api.saveBookSources).not.toHaveBeenCalled()
    vi.mocked(window.confirm).mockReturnValue(true)
    let reject!: (error: Error) => void
    vi.mocked(api.saveBookSources).mockImplementation(() => new Promise((_, fail) => { reject = fail }))
    await preview.get('.import-actions button:last-child').trigger('click'); await flushPromises()
    preview.vm.$emit('confirm', [pack[0]!]); await flushPromises()
    expect(api.saveBookSources).toHaveBeenCalledTimes(1)
    reject(new Error('controlled failure')); await flushPromises()
    expect(preview.text()).toContain('controlled failure')
    expect(preview.get<HTMLInputElement>('input[type=checkbox]').element.checked).toBe(true)
    expect(vi.mocked(subscriptionApi.changeSourceSubscriptions).mock.calls.some(([operation]) => operation.operation === 'synced')).toBe(false)
  })
  it('does not clear selection when an unselected source changes; download failure writes nothing', async () => {
    const preview = await open('remote')
    await preview.get('input[type=checkbox]').setValue(true)
    vi.mocked(api.getBookSources).mockResolvedValue([{ ...pack[1]!, bookSourceName: 'unselected change' }])
    await preview.get('.import-actions button:last-child').trigger('click'); await flushPromises()
    expect(api.saveBookSources).toHaveBeenCalledExactlyOnceWith([pack[0]], expect.anything())
    vi.mocked(api.saveBookSources).mockClear()
    vi.mocked(api.readRemoteSourceFile).mockRejectedValue(new Error('download failed'))
    await open('remote')
    expect(wrapper.findComponent(SourceImportPreview).exists()).toBe(false)
    expect(api.saveBookSources).not.toHaveBeenCalled()
  })
  it('does not report success or update subscription time for an incomplete save response', async () => {
    const preview = await open('subscription')
    await preview.get('input[type=checkbox]').setValue(true)
    vi.mocked(api.saveBookSources).mockResolvedValue({ saved: true, count: 0 })
    await preview.get('.import-actions button:last-child').trigger('click'); await flushPromises()
    expect(preview.text()).toContain('未确认全部完成')
    expect(preview.get<HTMLInputElement>('input[type=checkbox]').element.checked).toBe(true)
    expect(vi.mocked(subscriptionApi.changeSourceSubscriptions).mock.calls.some(([operation]) => operation.operation === 'synced')).toBe(false)
  })
  it('ignores a file/link read completed after an account change', async () => {
    let finish!: (value: string[]) => void
    vi.mocked(api.readRemoteSourceFile).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await open('remote')
    useAppStore().updateUserInfo({ username: 'other-account' } as UserInfo)
    expect(vi.mocked(api.readRemoteSourceFile).mock.calls[0]?.[1]?.aborted).toBe(true)
    finish([JSON.stringify(pack)]); await flushPromises()
    expect(wrapper.findComponent(SourceImportPreview).exists()).toBe(false)
    expect(api.saveBookSources).not.toHaveBeenCalled()
  })
  it('does not submit an old account selection after delayed save preflight', async () => {
    const preview = await open('local')
    await preview.get('input[type=checkbox]').setValue(true)
    let finish!: (value: typeof pack) => void
    vi.mocked(api.getBookSources).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await preview.get('.import-actions button:last-child').trigger('click')
    useAppStore().updateUserInfo({ username: 'other-account' } as UserInfo)
    finish([]); await flushPromises()
    expect(api.saveBookSources).not.toHaveBeenCalled()
  })
  it('retries failed subscription timestamp updates without saving book sources again', async () => {
    const preview = await open('remote')
    await preview.get('input[type=checkbox]').setValue(true)
    vi.mocked(subscriptionApi.changeSourceSubscriptions).mockRejectedValueOnce(new Error('timestamp update failed'))
    await preview.get('.import-actions button:last-child').trigger('click'); await flushPromises()
    expect(api.saveBookSources).toHaveBeenCalledTimes(1)
    const panel = wrapper.findComponent(SourceSubscriptionPanel)
    expect(panel.props('pendingTimestamps')).toEqual(['https://package.example/only.json'])
    panel.vm.$emit('retry-timestamp'); await flushPromises()
    expect(api.saveBookSources).toHaveBeenCalledTimes(1)
    expect(panel.props('pendingTimestamps')).toEqual([])
  })
})
