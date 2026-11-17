import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import SourceManager from './SourceManager.vue'
import SourceImportPreview from './source-manager/SourceImportPreview.vue'
import SourceSubscriptionPanel from './source-manager/SourceSubscriptionPanel.vue'
import * as api from '../api/source'

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
  wrapper = mount(SourceManager, { props: { modelValue: true }, global: { plugins: [createPinia()] }, attachTo: document.body })
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
      expect(localStorage.getItem('reader-source-subscriptions') || '').not.toContain('lastSyncedAt')
    })
    it(`${entry}: saves only selected objects and updates time only after success`, async () => {
      const preview = await open(entry)
      await preview.get('input[type=checkbox]').setValue(true)
      await preview.get('.import-actions button:last-child').trigger('click')
      await flushPromises()
      expect(api.saveBookSources).toHaveBeenCalledExactlyOnceWith([pack[0]])
      if (entry !== 'local') {
        expect(api.readRemoteSourceFile).toHaveBeenCalledExactlyOnceWith('https://package.example/only.json')
        expect(localStorage.getItem('reader-source-subscriptions')).toContain('lastSyncedAt')
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
    expect(localStorage.getItem('reader-source-subscriptions')).not.toContain('lastSyncedAt')
  })
  it('does not clear selection when an unselected source changes; download failure writes nothing', async () => {
    const preview = await open('remote')
    await preview.get('input[type=checkbox]').setValue(true)
    vi.mocked(api.getBookSources).mockResolvedValue([{ ...pack[1]!, bookSourceName: 'unselected change' }])
    await preview.get('.import-actions button:last-child').trigger('click'); await flushPromises()
    expect(api.saveBookSources).toHaveBeenCalledExactlyOnceWith([pack[0]])
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
    expect(localStorage.getItem('reader-source-subscriptions')).not.toContain('lastSyncedAt')
  })
})
