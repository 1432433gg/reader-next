import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

/** Follow actual rendered height, including text zoom and responsive wrapping. */
export function useElementHeight(element: Ref<HTMLElement | null>) {
  const height = ref(0)
  let observer: ResizeObserver | undefined
  const measure = () => { height.value = element.value?.getBoundingClientRect().height || 0 }
  const stop = watch(element, (el) => {
    observer?.disconnect()
    window.removeEventListener('resize', measure)
    measure()
    if (el) {
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(measure)
        observer.observe(el)
      }
      window.addEventListener('resize', measure)
    }
  }, { flush: 'post' })
  onBeforeUnmount(() => {
    stop()
    observer?.disconnect()
    window.removeEventListener('resize', measure)
  })
  return height
}
