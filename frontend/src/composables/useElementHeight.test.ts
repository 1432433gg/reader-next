import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { useElementHeight } from './useElementHeight'

const wrappers: ReturnType<typeof mount>[] = []
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mountToolbar() {
  const wrapper = mount(defineComponent({
    setup() {
      const element = ref<HTMLElement | null>(null)
      const visible = ref(false)
      return { element, visible, height: useElementHeight(element) }
    },
    template: '<div><div v-if="visible" ref="element" class="toolbar" /><output>{{ height }}</output></div>',
  }))
  wrappers.push(wrapper)
  return wrapper
}

describe('floating toolbar height reservation', () => {
  it('tracks appearing, resized and removed toolbars without leaving stale space', async () => {
    let resize: () => void = () => {}
    const disconnect = vi.fn()
    const observe = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback }
      observe = observe
      disconnect = disconnect
    })
    let height = 70
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ height }) as DOMRect)
    const wrapper = mountToolbar()
    expect(wrapper.get('output').text()).toBe('0')
    wrapper.vm.visible = true
    await nextTick()
    await nextTick()
    expect(wrapper.get('output').text()).toBe('70')
    expect(observe).toHaveBeenCalledWith(wrapper.get('.toolbar').element)
    height = 118
    resize()
    await nextTick()
    expect(wrapper.get('output').text()).toBe('118')
    wrapper.vm.visible = false
    await nextTick()
    await nextTick()
    expect(wrapper.get('output').text()).toBe('0')
    expect(disconnect).toHaveBeenCalled()
  })

  it('remeasures on window resize even without ResizeObserver', async () => {
    vi.stubGlobal('ResizeObserver', undefined)
    let height = 70
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ height }) as DOMRect)
    const wrapper = mountToolbar()
    wrapper.vm.visible = true
    await nextTick()
    height = 80
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(wrapper.get('output').text()).toBe('80')
  })

  it('disconnects observation when leaving the page', async () => {
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn()
      disconnect = disconnect
    })
    const wrapper = mountToolbar()
    wrapper.vm.visible = true
    await nextTick()
    wrapper.unmount()
    expect(disconnect).toHaveBeenCalled()
  })
})
