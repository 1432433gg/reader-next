<template>
  <div class="import-backdrop" @click.self="cancel" @keydown.esc.stop="cancel">
    <section ref="dialog" class="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title" tabindex="-1" @keydown.tab="trapFocus">
      <header class="import-heading">
        <h3 id="import-title">选择导入书源</h3>
        <p>勾选要导入的书源后，点击“确认导入”。</p>
      </header>
      <div class="import-stats" aria-live="polite">共 {{ rows.length }} 条 · 显示 {{ filtered.length }} 条 · 已选 {{ selected.size }} 条</div>
      <div class="import-filters">
        <input v-model="query" aria-label="搜索书源" placeholder="搜索名称、地址或分组" />
        <button type="button" :disabled="busy || !selectable.length" @click="toggleVisible">{{ allVisible ? '取消当前结果' : '全选当前结果' }}</button>
      </div>
      <div class="import-columns" aria-hidden="true"><span>选择</span><span>名称 / 地址 / 分组</span><span>状态</span></div>
      <div class="import-rows" tabindex="0" aria-label="待导入书源列表">
        <div v-for="row in filtered" :key="row.id" class="import-row">
          <input type="checkbox" :aria-label="`选择第 ${row.id + 1} 条`" :disabled="busy || !!row.error" :checked="selected.has(row.id)" @change="toggle(row.id)" />
          <div class="import-info">
            <strong>{{ typeof row.source?.bookSourceName === 'string' ? row.source.bookSourceName : `第 ${row.id + 1} 条` }}</strong>
            <span>{{ typeof row.source?.bookSourceUrl === 'string' ? row.source.bookSourceUrl : '' }}</span>
            <span v-if="typeof row.source?.bookSourceGroup === 'string'">{{ row.source.bookSourceGroup }}</span>
          </div>
          <span class="import-status">{{ row.error || (existingUrls.has(row.source!.bookSourceUrl) ? '已存在' : '新增') }}</span>
        </div>
        <p v-if="!filtered.length" class="import-empty">没有匹配的书源</p>
      </div>
      <p v-if="error" class="import-error" role="alert">{{ error }}</p>
      <footer class="import-actions">
        <button type="button" :disabled="busy" @click="cancel">取消</button>
        <button type="button" :disabled="busy || !selected.size" @click="submit">{{ busy ? '保存中…' : '确认导入' }}</button>
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import type { BookSource } from '../../types'
import { createImportRows } from '../../utils/sourceImport'

const props = defineProps<{ values: unknown[]; existing: BookSource[]; busy: boolean; error: string }>()
const emit = defineEmits<{ cancel: []; confirm: [sources: BookSource[]] }>()
const rows = createImportRows(props.values)
const selected = ref(new Set<number>())
const query = ref('')
const dialog = ref<HTMLElement>()
const existingUrls = computed(() => new Set(props.existing.map((source) => source.bookSourceUrl)))
const filtered = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  return rows.filter((row) => !needle || [row.source?.bookSourceName, row.source?.bookSourceUrl, row.source?.bookSourceGroup]
    .some((field) => typeof field === 'string' && field.toLocaleLowerCase().includes(needle)))
})
const selectable = computed(() => filtered.value.filter((row) => !row.error))
const allVisible = computed(() => selectable.value.length > 0 && selectable.value.every((row) => selected.value.has(row.id)))
function toggle(id: number) {
  if (props.busy || rows[id]?.error) return
  if (selected.value.has(id)) selected.value.delete(id)
  else selected.value.add(id)
}
function toggleVisible() {
  if (props.busy) return
  const remove = allVisible.value
  selectable.value.forEach((row) => remove ? selected.value.delete(row.id) : selected.value.add(row.id))
}
function submit() {
  if (!props.busy && selected.value.size) emit('confirm', rows.filter((row) => selected.value.has(row.id) && !row.error).map((row) => row.source!))
}
function cancel() { if (!props.busy) emit('cancel') }
function trapFocus(event: KeyboardEvent) {
  const items = Array.from(dialog.value?.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled),[tabindex="0"]') || [])
  const first = items[0], last = items.at(-1)
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) {
    event.preventDefault(); last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault(); first?.focus()
  }
}
// Preserve prior locks and inline styles, including a lock owned by another modal.
const previousFocus = document.activeElement as HTMLElement | null
const scrollPosition = { x: window.scrollX, y: window.scrollY }
const ownsFixedBody = getComputedStyle(document.body).position !== 'fixed'
const bodyStyles = ['position', 'top', 'left', 'width'].map((property) => ({
  property, value: document.body.style.getPropertyValue(property), priority: document.body.style.getPropertyPriority(property),
}))
const ownedBodyStyles: Record<string, string> = { position: 'fixed', top: `${-scrollPosition.y}px`, left: `${-scrollPosition.x}px`, width: '100%' }
const locks = [document.documentElement, document.body].map((element) => ({
  element, value: element.style.getPropertyValue('overflow'), priority: element.style.getPropertyPriority('overflow'),
}))
onMounted(() => {
  locks.forEach(({ element }) => element.style.setProperty('overflow', 'hidden', 'important'))
  if (ownsFixedBody) Object.entries(ownedBodyStyles).forEach(([key, value]) => document.body.style.setProperty(key, value, 'important'))
  dialog.value?.focus()
})
onBeforeUnmount(() => {
  bodyStyles.forEach(({ property, value, priority }) => {
    if (ownsFixedBody && document.body.style.getPropertyValue(property) === ownedBodyStyles[property] && document.body.style.getPropertyPriority(property) === 'important') {
      if (value) document.body.style.setProperty(property, value, priority)
      else document.body.style.removeProperty(property)
    }
  })
  locks.forEach(({ element, value, priority }) => {
    if (element.style.getPropertyValue('overflow') === 'hidden' && element.style.getPropertyPriority('overflow') === 'important') {
      if (value) element.style.setProperty('overflow', value, priority)
      else element.style.removeProperty('overflow')
    }
  })
  if (ownsFixedBody) window.scrollTo?.({ left: scrollPosition.x, top: scrollPosition.y, behavior: 'auto' })
  previousFocus?.focus({ preventScroll: true })
})
</script>

<style scoped>
.import-backdrop { position: fixed; top: var(--viewport-offset-top, 0px); bottom: var(--viewport-offset-bottom, 0px); left: 0; right: 0; z-index: calc(var(--z-modal, 1000) + 3); background: #0008; display: flex; align-items: center; justify-content: center; padding: 12px; overscroll-behavior: none; }
.import-dialog { box-sizing: border-box; width: min(900px, 100%); height: min(740px, calc(var(--app-visual-height, var(--app-height, 100vh)) - 24px)); max-height: calc(var(--app-visual-height, var(--app-height, 100vh)) - 24px); min-height: 0; display: flex; flex-direction: column; overflow: hidden; border-radius: 12px; background: var(--color-bg-elevated, white); color: var(--color-text-primary, #222); padding: 16px; gap: 10px; }
.import-heading, .import-stats, .import-filters, .import-columns, .import-actions, .import-error { flex: 0 0 auto; min-width: 0; }
.import-heading h3 { margin: 0 0 6px; font-size: 18px; }
.import-heading p { margin: 0; font-size: 13px; }
.import-stats { font-size: 13px; }
.import-filters { display: flex; gap: 8px; }
.import-filters input { flex: 1; min-width: 0; width: 0; }
.import-dialog button, .import-filters input { font: inherit; font-size: 13px; border: 1px solid var(--color-border, #aaa); border-radius: 6px; padding: 8px; background: var(--color-bg, #f7f7f7); color: inherit; }
.import-dialog button:disabled { opacity: .5; }
.import-columns, .import-row { display: grid; grid-template-columns: 36px minmax(0, 1fr) 84px; gap: 8px; }
.import-columns { font-size: 12px; border-bottom: 1px solid #aaa6; padding: 4px 8px; }
.import-rows { flex: 1 1 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y; scrollbar-gutter: stable; }
.import-row { padding: 10px 8px; border-bottom: 1px solid #aaa4; align-items: start; font-size: 13px; }
.import-row input { margin-top: 3px; }
.import-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; overflow-wrap: anywhere; }
.import-info span { font-size: 12px; }
.import-status { overflow-wrap: anywhere; font-size: 12px; }
.import-actions { display: flex; justify-content: flex-end; gap: 10px; }
.import-error { color: var(--color-danger, #b22); font-size: 12px; margin: 0; max-height: 3em; overflow: auto; }
.import-empty { text-align: center; }
@media (max-width: 420px) { .import-dialog { padding: 10px; gap: 8px; } .import-columns, .import-row { grid-template-columns: 28px minmax(0, 1fr) 60px; gap: 4px; } }
</style>
