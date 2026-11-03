import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { nextTick } from 'vue'
import HomeView from './HomeView.vue'
import GroupSelectModal from '../components/bookshelf/GroupSelectModal.vue'
import { useBookshelfStore } from '../stores/bookshelf'
import { useAppStore } from '../stores/app'

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
const wrappers: ReturnType<typeof shallowMount>[] = []
beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  const shelf = useBookshelfStore()
  vi.spyOn(shelf, 'fetchBooks').mockResolvedValue()
  vi.spyOn(shelf, 'fetchGroups').mockResolvedValue()
  vi.spyOn(shelf, 'fetchChapterUpdateStatus').mockResolvedValue(null)
  vi.spyOn(useAppStore(), 'fetchUserInfo').mockResolvedValue()
  useAppStore().setOnlineStatus(true)
  shelf.books = [{ bookUrl: 'a', origin: 'source', name: '第一本', author: '甲' },
    { bookUrl: 'b', origin: 'source', name: '末本书', author: '乙' }]
})
afterEach(() => {
  wrappers.splice(0).forEach(w => w.unmount())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function openSelection() {
  const shelf = useBookshelfStore()
  const wrapper = shallowMount(HomeView)
  wrappers.push(wrapper)
  await flushPromises()
  await wrapper.get('button[aria-label="编辑"]').trigger('click')
  shelf.toggleSelection('b')
  await nextTick()
  await nextTick()
  return { wrapper, shelf }
}

describe('bookshelf batch toolbar integration', () => {
  it('reserves measured height and releases it when selection ends', async () => {
    let height = 70
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { height: this.classList.contains('batch-toolbar') ? height : 0 } as DOMRect
    })
    const { wrapper } = await openSelection()
    expect(wrapper.find('.batch-toolbar').exists()).toBe(true)
    expect(wrapper.get('.shelf-content').classes()).toContain('has-batch-toolbar')
    expect(wrapper.get('.shelf-content').attributes('style')).toContain('--batch-toolbar-height: 70px')
    height = 118 // wrapping or enlarged text, supplied by the rendering engine in production
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(wrapper.get('.shelf-content').attributes('style')).toContain('--batch-toolbar-height: 118px')
    await wrapper.get('button[aria-label="完成"]').trigger('click')
    await nextTick()
    expect(wrapper.find('.batch-toolbar').exists()).toBe(false)
    expect(wrapper.get('.shelf-content').classes()).not.toContain('has-batch-toolbar')
    expect(wrapper.get('.shelf-content').attributes('style')).toContain('--batch-toolbar-height: 0px')
  })

  it('opens group selection and forwards the chosen group', async () => {
    const { wrapper, shelf } = await openSelection()
    const move = vi.spyOn(shelf, 'bulkSetGroup').mockResolvedValue()
    await wrapper.get('.batch-btn').trigger('click')
    const modal = wrapper.findComponent(GroupSelectModal)
    expect(modal.props('modelValue')).toBe(true)
    modal.vm.$emit('select', 8)
    await flushPromises()
    expect(move).toHaveBeenCalledWith(8)
    expect([...shelf.selectedBookUrls]).toEqual(['b'])
  })

  it('keeps deletion behind confirmation and only acts after acceptance', async () => {
    const { wrapper, shelf } = await openSelection()
    const remove = vi.spyOn(shelf, 'bulkDelete').mockResolvedValue()
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    vi.stubGlobal('confirm', confirm)
    await wrapper.get('.batch-btn.danger').trigger('click')
    expect(remove).not.toHaveBeenCalled()
    await wrapper.get('.batch-btn.danger').trigger('click')
    await flushPromises()
    expect(remove).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledWith('确定删除选中的 1 本书？')
  })
})
