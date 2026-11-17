import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import SourceManager from './SourceManager.vue'
import SourceEditorPanel from './source-manager/SourceEditorPanel.vue'
vi.mock('../api/source', async (original) => ({ ...await original<typeof import('../api/source')>(), getBookSources: vi.fn(async () => []) }))
let wrapper: ReturnType<typeof mount>
const originalWidth = window.innerWidth, originalHeight = window.innerHeight
function resize(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
  window.dispatchEvent(new Event('resize'))
}
beforeEach(() => { localStorage.clear() })
afterEach(() => { wrapper?.unmount(); resize(originalWidth, originalHeight) })
describe('workspace size defaults and manual intent', () => {
  for (const [width, height, expanded] of [[1366, 768, true], [901, 640, true], [900, 640, false], [1366, 639, false], [390, 844, false], [440, 956, false], [412, 915, false], [320, 568, false], [844, 390, false]] as const) {
    it(`${width}x${height} defaults to ${expanded ? 'expanded' : 'collapsed'}`, async () => {
      resize(width, height)
      wrapper = mount(SourceManager, { props: { modelValue: true }, global: { plugins: [createPinia()] } })
      await flushPromises()
      expect(wrapper.findComponent(SourceEditorPanel).props('expanded')).toBe(expanded)
    })
  }
  it('preserves manual intent and draft on toggle/resize, resets default only on reopening', async () => {
    resize(390, 844)
    wrapper = mount(SourceManager, { props: { modelValue: true }, global: { plugins: [createPinia()] } })
    const editor = wrapper.findComponent(SourceEditorPanel)
    editor.vm.$emit('update:editorText', '{"draft":"preserve me"}')
    editor.vm.$emit('toggle'); await flushPromises()
    expect(editor.props('expanded')).toBe(true)
    resize(320, 568); await flushPromises()
    expect(editor.props('expanded')).toBe(true)
    editor.vm.$emit('toggle'); await flushPromises()
    expect(editor.props('editorText')).toBe('{"draft":"preserve me"}')
    resize(1366, 768); await flushPromises()
    expect(editor.props('expanded')).toBe(false)
    await wrapper.setProps({ modelValue: false }); await wrapper.setProps({ modelValue: true })
    expect(wrapper.findComponent(SourceEditorPanel).props('expanded')).toBe(true)
  })
})
