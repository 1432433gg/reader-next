<template>
  <div class="cover-editor" :aria-busy="busy">
    <div class="cover-picture">
      <img v-if="displayUrl && !failed" :src="displayUrl" :alt="book.name" @error="failed = true" />
      <div v-else class="cover-placeholder">{{ book.name }}</div>
    </div>
    <input ref="input" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
      class="cover-file-input" aria-label="选择封面图片" :disabled="busy" @change="chooseFile" />
    <template v-if="preview">
      <span class="cover-hint">预览 · 尚未保存</span>
      <button type="button" :disabled="busy" class="cover-button primary" @click="save">{{ saving ? '保存中…' : '保存封面' }}</button>
      <button type="button" :disabled="busy" class="cover-button" @click="cancelPreview">取消</button>
    </template>
    <template v-else>
      <button type="button" :disabled="busy" class="cover-button" @click="input?.click()">{{ preparing ? '处理图片…' : '更换封面' }}</button>
      <button v-if="book.customCoverUrl" type="button" :disabled="busy" class="cover-button" @click="reset">{{ saving ? '恢复中…' : '恢复默认' }}</button>
      <span class="cover-hint">JPG / PNG / WebP<br />最大 5MB</span>
    </template>
    <p v-if="error" class="cover-error" role="alert">{{ error }}</p>
    <p v-if="message" class="cover-hint" role="status">{{ message }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { getCoverUrl, resetBookCover, uploadBookCover } from '../api/bookshelf'
import { prepareCoverFile } from '../utils/bookCover'
import type { Book } from '../types'

const props = defineProps<{ book: Book }>()
const emit = defineEmits<{ saved: [book: Book] }>()
const input = ref<HTMLInputElement | null>(null)
const preview = ref('')
const file = ref<File | null>(null)
const preparing = ref(false)
const saving = ref(false)
const error = ref('')
const message = ref('')
const failed = ref(false)
const busy = computed(() => preparing.value || saving.value)
const displayUrl = computed(() => preview.value || getCoverUrl(props.book.customCoverUrl || props.book.coverUrl))
let generation = 0

watch(displayUrl, () => { failed.value = false })
watch(() => props.book.bookUrl, () => {
  generation++
  cancelPreview()
  preparing.value = false
  error.value = ''
  message.value = ''
})
onBeforeUnmount(() => { generation++; clearPreview() })

function clearPreview() {
  if (preview.value) URL.revokeObjectURL(preview.value)
  preview.value = ''
  file.value = null
}
function cancelPreview() {
  clearPreview()
  error.value = ''
}
async function chooseFile(event: Event) {
  const target = event.target as HTMLInputElement
  const selected = target.files?.[0]
  target.value = '' // Choosing the same image again must trigger change after a failure/cancel.
  if (!selected || busy.value) return
  const request = ++generation
  preparing.value = true
  error.value = ''
  message.value = ''
  try {
    const prepared = await prepareCoverFile(selected)
    if (request !== generation) return
    clearPreview()
    file.value = prepared
    preview.value = URL.createObjectURL(prepared)
  } catch (err) {
    if (request === generation) error.value = err instanceof Error ? err.message : '图片处理失败'
  } finally {
    if (request === generation) preparing.value = false
  }
}
async function save() {
  if (!file.value || busy.value) return
  const request = generation
  saving.value = true
  error.value = ''
  try {
    const updated = await uploadBookCover(props.book.bookUrl, file.value)
    emit('saved', updated)
    if (request === generation) { clearPreview(); message.value = '封面已保存' }
  } catch (err) {
    if (request === generation) error.value = err instanceof Error ? err.message : '保存失败，请重试'
  } finally {
    saving.value = false
  }
}
async function reset() {
  if (busy.value) return
  const request = generation
  saving.value = true
  error.value = ''
  message.value = ''
  try {
    const updated = await resetBookCover(props.book.bookUrl)
    emit('saved', updated)
    if (request === generation) message.value = '已恢复默认封面'
  } catch (err) {
    if (request === generation) error.value = err instanceof Error ? err.message : '恢复失败，请重试'
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.cover-editor { width: 120px; flex-shrink: 0; display: flex; flex-direction: column; gap: 6px; }
.cover-picture { width: 100%; aspect-ratio: 3 / 4; overflow: hidden; border-radius: var(--radius-md); background: var(--color-bg-sunken); box-shadow: var(--shadow-md); }
.cover-picture img { width: 100%; height: 100%; object-fit: contain; }
.cover-placeholder { height: 100%; display: flex; align-items: center; justify-content: center; padding: 12px; text-align: center; color: var(--color-primary); background: var(--color-primary-bg); overflow-wrap: anywhere; }
.cover-file-input { display: none; }
.cover-button { min-height: 44px; padding: 8px; border: 1px solid var(--color-border); border-radius: var(--radius-md); color: var(--color-primary); background: var(--color-bg); font-size: var(--text-sm); }
.cover-button.primary { background: var(--color-primary); color: white; }
.cover-button:disabled { opacity: .55; cursor: wait; }
.cover-hint, .cover-error { font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; text-align: center; }
.cover-hint { color: var(--color-text-secondary); }
.cover-error { color: var(--color-danger, #c0392b); }
@media (max-width: 380px) { .cover-editor { width: 96px; } }
</style>
