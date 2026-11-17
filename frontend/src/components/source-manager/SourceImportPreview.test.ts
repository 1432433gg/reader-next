import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SourceImportPreview from './SourceImportPreview.vue'

const values = [
  { bookSourceName: '甲', bookSourceUrl: 'a', ruleSearch: { name: '<js>original</js>' } },
  { bookSourceName: '乙', bookSourceUrl: 'b', bookSourceGroup: '分组' },
  { bookSourceName: '重复', bookSourceUrl: 'a' },
  null,
  { bookSourceName: '缺地址' },
]
const wrappers: ReturnType<typeof mount>[] = []
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()))
function setup() {
  const wrapper = mount(SourceImportPreview, { props: { values, existing: [], busy: false, error: '' }, attachTo: document.body })
  wrappers.push(wrapper)
  return wrapper
}
describe('import selection', () => {
  it('starts empty, rejects duplicate/invalid rows, keeps hidden selection and original fields', async () => {
    const wrapper = setup()
    expect(wrapper.get('.import-actions button:last-child').attributes('disabled')).toBeDefined()
    const checks = wrapper.findAll<HTMLInputElement>('input[type=checkbox]')
    expect(checks.slice(2).every((check) => check.element.disabled)).toBe(true)
    await checks[0]!.setValue(true)
    await wrapper.get('input[aria-label="搜索书源"]').setValue('分组')
    await wrapper.get('.import-filters button').trigger('click')
    await wrapper.get('.import-filters button').trigger('click')
    await wrapper.get('input[aria-label="搜索书源"]').setValue('no-match')
    expect(wrapper.findAll('.import-row')).toHaveLength(0)
    await wrapper.get('.import-actions button:last-child').trigger('click')
    expect(wrapper.emitted('confirm')?.[0]).toEqual([[values[0]]])
  })
  it('blocks submission/cancel/selection while saving and restores a pre-existing scroll lock', async () => {
    document.body.style.setProperty('overflow', 'clip')
    const wrapper = setup()
    expect(document.body.style.overflow).toBe('hidden')
    await wrapper.setProps({ busy: true })
    await wrapper.get('.import-backdrop').trigger('click')
    expect(wrapper.emitted('cancel')).toBeUndefined()
    expect(wrapper.findAll<HTMLInputElement>('input[type=checkbox]').every((check) => check.element.disabled)).toBe(true)
    wrapper.unmount()
    expect(document.body.style.overflow).toBe('clip')
    document.body.style.removeProperty('overflow')
  })
  it('keeps the fixed-body lock owned by another modal', () => {
    document.body.style.position = 'fixed'
    document.body.style.top = '-200px'
    const wrapper = setup()
    expect(document.body.style.top).toBe('-200px')
    wrapper.unmount()
    expect(document.body.style.position).toBe('fixed')
    expect(document.body.style.top).toBe('-200px')
    document.body.style.removeProperty('position')
    document.body.style.removeProperty('top')
  })
})
