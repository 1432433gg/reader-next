import { afterEach, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import SourceManager from './SourceManager.vue'
import SourceList from './source-manager/SourceList.vue'
import SourceEditorPanel from './source-manager/SourceEditorPanel.vue'
const sources = [{ bookSourceName: 'A', bookSourceUrl: 'https://a.example' }, { bookSourceName: 'B', bookSourceUrl: 'https://b.example' }]
vi.mock('../api/source', async (original) => ({ ...await original<typeof import('../api/source')>(), getBookSources: vi.fn(async () => sources), saveBookSource: vi.fn() }))
let wrapper: ReturnType<typeof mount>
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks() })
it('scrolls the manager when the workspace top is visible but JSON is clipped below it', async () => {
  wrapper = mount(SourceManager, { props: { modelValue: true }, global: { plugins: [createPinia()] }, attachTo: document.body })
  await flushPromises()
  const original = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const rect = this.classList.contains('source-modal') ? { top: 8, bottom: 542 }
      : this.classList.contains('editor-textarea') ? { top: 545.5, bottom: 719 }
        : this.classList.contains('editor-panel') ? { top: 360, bottom: 720 } : null
    return rect ? { ...rect, left: 0, right: 320, width: 320, height: rect.bottom - rect.top, x: 0, y: rect.top, toJSON: () => rect } : original.call(this)
  })
  const manager = document.querySelector<HTMLElement>('.source-modal')!
  const list = document.querySelector<HTMLElement>('.source-list')!
  list.scrollTop = 42
  wrapper.findComponent(SourceList).vm.$emit('edit-json', sources[0]); await flushPromises()
  expect(manager.scrollTop).toBe(177)
  expect(list.scrollTop).toBe(42)
  expect(document.activeElement).not.toBe(document.querySelector('.editor-textarea'))
})
it('distinguishes pencil intent, preserves invalid same-source draft, resets tab only on reopening', async () => {
  wrapper = mount(SourceManager, { props: { modelValue: true }, global: { plugins: [createPinia()] }, attachTo: document.body })
  await flushPromises()
  const list = wrapper.findComponent(SourceList), editor = wrapper.findComponent(SourceEditorPanel)
  editor.vm.$emit('toggle'); await flushPromises()
  list.vm.$emit('edit', sources[0]); await flushPromises()
  expect(editor.props('activeTab')).toBe('overview')
  list.vm.$emit('edit-json', sources[0]); await flushPromises()
  expect(editor.props('expanded')).toBe(true); expect(editor.props('activeTab')).toBe('json')
  editor.vm.$emit('update:editorText', '{ invalid intermediate draft'); editor.vm.$emit('update:activeTab', 'login'); await flushPromises()
  list.vm.$emit('edit-json', sources[0]); await flushPromises()
  expect(editor.props('activeTab')).toBe('json'); expect(editor.props('editorText')).toBe('{ invalid intermediate draft')
  editor.vm.$emit('toggle'); await flushPromises(); list.vm.$emit('edit-json', sources[0]); await flushPromises()
  expect(editor.props('expanded')).toBe(true); expect(editor.props('editorText')).toBe('{ invalid intermediate draft')
  list.vm.$emit('edit-json', sources[1]); await flushPromises()
  expect(JSON.parse(editor.props('editorText')).bookSourceName).toBe('B')
  await wrapper.setProps({ modelValue: false }); await wrapper.setProps({ modelValue: true })
  expect(wrapper.findComponent(SourceEditorPanel).props('activeTab')).toBe('overview')
})
