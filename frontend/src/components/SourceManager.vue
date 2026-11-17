<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="modelValue" class="modal-overlay" @click="close"></div>
    </Transition>

    <Transition name="scale">
      <div v-if="modelValue" class="modal-container" @click.self="close">
        <div class="source-modal">
          <SourceManagerHeader
            :total="sourceStats.total"
            :enabled="sourceStats.enabled"
            :filtered="sourceStats.filtered"
            :selected="selectedFilteredSources.length"
            :loading="loading"
            :testing="testingSources"
            :invalid-count="invalidSources.length"
            @refresh="loadSources"
            @import-local="triggerFileImport"
            @open-subscriptions="subscriptionPanelVisible = true"
            @export="exportSources"
            @test-sources="testSources"
            @delete-invalid="removeInvalidSources"
            @create="createSource"
            @close="close"
          />

          <input
            ref="fileInputRef"
            type="file"
            accept=".json,.txt"
            class="hidden-input"
            @change="handleFileImport"
          />

          <SourceFilterBar
            :filter-text="filterText"
            :filter-group="filterGroup"
            :groups="groupList"
            :all-selected="allFilteredSelected"
            :partially-selected="partiallyFilteredSelected"
            :selected-count="selectedFilteredSources.length"
            :has-sources="filteredSources.length > 0"
            @update:filter-text="filterText = $event"
            @update:filter-group="filterGroup = $event"
            @toggle-current-selection="toggleFilteredSelection"
            @clear-selection="clearSelection"
            @delete-selection="removeSelectedSources"
          />

          <div class="content-grid">
            <SourceList
              class="source-list-slot"
              :sources="filteredSources"
              :loading="loading"
              :selected-urls="selectedSourceUrls"
              :active-url="editingSource?.bookSourceUrl"
              :empty-title="sources.length ? '没有匹配的书源' : '暂无书源'"
              :empty-description="sources.length ? '调整搜索关键词或分组筛选后再试' : '可以本地导入、远程同步或手动新增'"
              @edit="editSource"
              @toggle-enabled="toggleSource"
              @toggle-selection="toggleSourceSelection"
              @delete="removeSource"
            />

            <SourceEditorPanel
              class="editor-slot"
              :class="{ 'editor-collapsed': !workspaceExpanded }"
              :expanded="workspaceExpanded"
              @toggle="toggleWorkspace"
              :source="editingSource"
              :editor-text="editorText"
              :can-login="canLoginSource"
              :login-loading="sourceLoginLoading"
              @update:editor-text="editorText = $event"
              @format="formatEditor"
              @save="saveEditor"
              @login="handleSourceLogin"
              @create="createSource"
              @import-local="triggerFileImport"
            />
          </div>

          <footer class="modal-footer">
            <span class="count-info">显示 {{ filteredSources.length }} / {{ sources.length }}</span>
          </footer>
        </div>
      </div>
    </Transition>

    <SourceSubscriptionPanel
      v-model:remote-url="remoteUrl"
      :visible="subscriptionPanelVisible"
      :subscriptions="subscriptions"
      :account="account"
      :loaded="subscriptionState.loaded.value"
      :loading="subscriptionState.loading.value"
      :busy="subscriptionState.busy.value"
      :error="subscriptionState.error.value"
      :migration-available="subscriptionState.migrationAvailable.value"
      :pending-timestamps="subscriptionState.pendingTimestamps.value"
      @refresh="subscriptionState.refresh"
      @migrate="subscriptionState.migrate"
      @retry-timestamp="retrySubscriptionTimestamp"
      @sync="importRemoteSource"
      @save="saveSubscription"
      @sync-subscription="syncSubscription"
      @remove-subscription="removeSubscription"
      @close="subscriptionPanelVisible = false"
    />

    <SourceImportPreview
      v-if="importPreview"
      :values="importPreview.values"
      :existing="importPreview.existing"
      :busy="importSaving"
      :error="importError"
      @cancel="cancelImport"
      @confirm="confirmImport"
    />

    <Transition name="scale">
      <div v-if="loginPreviewVisible" class="login-preview-container" @click.self="loginPreviewVisible = false">
        <div class="login-preview-modal">
          <div class="login-preview-header">
            <div>
              <h3>书源登录页</h3>
              <p>{{ loginPreviewUrl }}</p>
            </div>
            <button class="icon-btn" type="button" @click="loginPreviewVisible = false" title="关闭">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <iframe class="login-preview-frame" :src="loginPreviewFrameUrl" :srcdoc="loginPreviewFrameHtml"></iframe>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import {
  getBookSources,
  deleteBookSource,
  deleteBookSources,
  deleteInvalidBookSources,
  loginBookSource,
  saveBookSource,
  saveBookSources,
  testBookSources,
  readRemoteSourceFile,
  readSourceFile,
} from '../api/source'
import { useAppStore } from '../stores/app'
import { useSourceStore } from '../stores/source'
import type { BookSource } from '../types'
import {
  filterBookSources,
  getBookSourceGroups,
  getBookSourceStats,
  getVisibleSelection,
  toBookSourceDeletePayload,
} from '../utils/sourceSelection'
import { appendAuthQueryParams } from '../utils/secureAccess'
import { chunkBookSourceUrls, mergeBookSourceTestResponses } from '../utils/sourceTesting'
import SourceEditorPanel from './source-manager/SourceEditorPanel.vue'
import SourceFilterBar from './source-manager/SourceFilterBar.vue'
import SourceList from './source-manager/SourceList.vue'
import SourceManagerHeader from './source-manager/SourceManagerHeader.vue'
import SourceSubscriptionPanel from './source-manager/SourceSubscriptionPanel.vue'
import { storeToRefs } from 'pinia'
import SourceImportPreview from './source-manager/SourceImportPreview.vue'
import { parseRemoteImport, sourceFingerprint } from '../utils/sourceImport'
import { useSourceSubscriptions } from '../composables/useSourceSubscriptions'

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const appStore = useAppStore()
const sourceStore = useSourceStore()
const { sources, loading } = storeToRefs(sourceStore)

type ImportPreview = { values: unknown[]; existing: BookSource[]; subscriptionUrl?: string }
const importPreview = ref<ImportPreview | null>(null)
const importSaving = ref(false)
const importReading = ref(false)
const importError = ref('')
let importGeneration = 0
let importController: AbortController | null = null
function cancelImport() {
  importGeneration++; importController?.abort(); importController = null
  importPreview.value = null; importReading.value = false
}

const testingSources = ref(false)
const filterText = ref('')
const filterGroup = ref('')
const fileInputRef = ref<HTMLInputElement | null>(null)
const selectedSourceUrls = ref(new Set<string>())

const subscriptionPanelVisible = ref(false)
const remoteUrl = ref('')
const account = computed(() => appStore.isLoggedIn ? appStore.userInfo?.username || null : null)
const subscriptionState = useSourceSubscriptions(account, subscriptionPanelVisible)
const subscriptions = subscriptionState.items
const workspaceExpanded = ref(false)
let workspaceManual = false
function defaultWorkspace() {
  if (!workspaceManual) workspaceExpanded.value = (window.visualViewport?.width ?? window.innerWidth) > 900 && (window.visualViewport?.height ?? window.innerHeight) >= 640
}
function toggleWorkspace() { workspaceManual = true; workspaceExpanded.value = !workspaceExpanded.value }
onMounted(() => {
  defaultWorkspace()
  window.addEventListener('resize', defaultWorkspace)
  window.visualViewport?.addEventListener('resize', defaultWorkspace)
})
onBeforeUnmount(() => {
  cancelImport()
  window.removeEventListener('resize', defaultWorkspace)
  window.visualViewport?.removeEventListener('resize', defaultWorkspace)
})

const editingSource = ref<BookSource | null>(null)
const editorText = ref(JSON.stringify(createEmptySource(), null, 2))
const sourceLoginLoading = ref(false)
const loginPreviewVisible = ref(false)
const loginPreviewUrl = ref('')
const loginPreviewFrameUrl = ref('')
const loginPreviewFrameHtml = ref('')

const groupList = computed(() => getBookSourceGroups(sources.value))

const filteredSources = computed(() =>
  filterBookSources(sources.value, filterText.value, filterGroup.value)
)

const sourceStats = computed(() => getBookSourceStats(sources.value, filteredSources.value))

const selectedFilteredSources = computed(() =>
  getVisibleSelection(filteredSources.value, selectedSourceUrls.value, (source) => source.bookSourceUrl)
)

const invalidSources = computed(() =>
  sources.value.filter((source) => hasSourceGroup(source, '失效'))
)

const allFilteredSelected = computed(() =>
  filteredSources.value.length > 0 && selectedFilteredSources.value.length === filteredSources.value.length
)

const partiallyFilteredSelected = computed(() =>
  selectedFilteredSources.value.length > 0 && !allFilteredSelected.value
)

const canLoginSource = computed(() => {
  try {
    const parsed = JSON.parse(editorText.value) as BookSource
    return Boolean(parsed.bookSourceUrl?.trim() && parsed.loginUrl?.trim())
  } catch {
    return false
  }
})

function createEmptySource(): BookSource {
  return {
    bookSourceName: '新增书源',
    bookSourceUrl: '',
    enabled: true,
  }
}

async function loadSources(force = true) {
  const identity = account.value
  try {
    await sourceStore.fetchSources({ force })
    pruneSelection()
  } catch (e: unknown) {
    if (identity === account.value) appStore.showToast((e as Error).message, 'error')
  }
}

async function toggleSource(source: BookSource) {
  const next = { ...source, enabled: source.enabled === false ? true : false }
  try {
    await saveBookSource(next)
    Object.assign(source, next)
    appStore.showToast('书源状态已更新', 'success')
  } catch (e: unknown) {
    appStore.showToast((e as Error).message, 'error')
  }
}

async function removeSource(source: BookSource) {
  if (!confirm(`确定删除书源 "${source.bookSourceName}"？`)) return
  try {
    await deleteBookSource(source.bookSourceUrl)
    sources.value = sources.value.filter((s) => s.bookSourceUrl !== source.bookSourceUrl)
    selectedSourceUrls.value.delete(source.bookSourceUrl)
    if (editingSource.value?.bookSourceUrl === source.bookSourceUrl) {
      createSource()
    }
    appStore.showToast('已删除', 'success')
  } catch (e: unknown) {
    appStore.showToast((e as Error).message, 'error')
  }
}

async function removeSelectedSources() {
  const targets = selectedFilteredSources.value
  if (!targets.length) {
    appStore.showToast('请先选择要删除的书源', 'warning')
    return
  }
  if (!confirm(`确定删除选中的 ${targets.length} 个书源？`)) return
  try {
    await deleteBookSources(toBookSourceDeletePayload(targets))
    const targetUrls = new Set(targets.map((source) => source.bookSourceUrl))
    sources.value = sources.value.filter((source) => !targetUrls.has(source.bookSourceUrl))
    selectedSourceUrls.value.clear()
    if (editingSource.value && targetUrls.has(editingSource.value.bookSourceUrl)) {
      createSource()
    }
    appStore.showToast(`已删除 ${targets.length} 个书源`, 'success')
  } catch (e: unknown) {
    appStore.showToast((e as Error).message || '批量删除失败', 'error')
  }
}

async function testSources() {
  const targets = selectedFilteredSources.value.length ? selectedFilteredSources.value : sources.value
  if (!targets.length) {
    appStore.showToast('没有可测试的书源', 'warning')
    return
  }
  const scopeText = selectedFilteredSources.value.length ? `选中的 ${targets.length}` : `全部 ${targets.length}`
  if (!confirm(`将测试${scopeText} 个书源。测试会请求外部站点，耗时可能较长，是否继续？`)) return

  testingSources.value = true
  try {
    const batches = chunkBookSourceUrls(targets.map((source) => source.bookSourceUrl))
    const responses = []
    for (const batch of batches) {
      responses.push(
        await testBookSources({
          bookSourceUrls: batch,
          markInvalid: true,
          concurrent: 12,
        })
      )
    }
    const result = mergeBookSourceTestResponses(responses)
    await loadSources()
    if (result.invalid > 0) {
      filterGroup.value = '失效'
    }
    appStore.showToast(
      `测试完成：有效 ${result.valid} 个，失效 ${result.invalid} 个，更新分组 ${result.markedInvalid} 个`,
      result.invalid > 0 ? 'warning' : 'success'
    )
  } catch (e: unknown) {
    appStore.showToast((e as Error).message || '书源测试失败', 'error')
  } finally {
    testingSources.value = false
  }
}

async function removeInvalidSources() {
  if (!invalidSources.value.length) {
    appStore.showToast('没有失效书源', 'warning')
    return
  }
  if (!confirm(`确定删除 ${invalidSources.value.length} 个失效书源？此操作不可撤销。`)) return
  try {
    const result = await deleteInvalidBookSources()
    const invalidUrls = new Set(invalidSources.value.map((source) => source.bookSourceUrl))
    sources.value = sources.value.filter((source) => !invalidUrls.has(source.bookSourceUrl))
    selectedSourceUrls.value.clear()
    if (editingSource.value && invalidUrls.has(editingSource.value.bookSourceUrl)) {
      createSource()
    }
    appStore.showToast(`已删除 ${result.deleted} 个失效书源`, 'success')
  } catch (e: unknown) {
    appStore.showToast((e as Error).message || '删除失效书源失败', 'error')
  }
}

function toggleSourceSelection(source: BookSource) {
  const selected = selectedSourceUrls.value
  if (selected.has(source.bookSourceUrl)) {
    selected.delete(source.bookSourceUrl)
  } else {
    selected.add(source.bookSourceUrl)
  }
}

function toggleFilteredSelection() {
  const selected = selectedSourceUrls.value
  if (allFilteredSelected.value) {
    filteredSources.value.forEach((source) => selected.delete(source.bookSourceUrl))
    return
  }
  filteredSources.value.forEach((source) => selected.add(source.bookSourceUrl))
}

function clearSelection() {
  selectedSourceUrls.value.clear()
}

function pruneSelection() {
  const availableUrls = new Set(sources.value.map((source) => source.bookSourceUrl))
  Array.from(selectedSourceUrls.value).forEach((url) => {
    if (!availableUrls.has(url)) {
      selectedSourceUrls.value.delete(url)
    }
  })
}

function hasSourceGroup(source: BookSource, groupName: string) {
  return (source.bookSourceGroup || '')
    .split(/[,;；、]/)
    .map((group) => group.trim())
    .filter(Boolean)
    .includes(groupName)
}

function createSource() {
  editingSource.value = null
  editorText.value = JSON.stringify(createEmptySource(), null, 2)
}

function editSource(source: BookSource) {
  editingSource.value = source
  editorText.value = JSON.stringify(source, null, 2)
}

function formatEditor() {
  try {
    const parsed = JSON.parse(editorText.value)
    editorText.value = JSON.stringify(parsed, null, 2)
  } catch {
    appStore.showToast('JSON 格式错误，无法格式化', 'error')
  }
}

async function saveEditor() {
  try {
    const parsed = JSON.parse(editorText.value) as BookSource
    if (!parsed.bookSourceName?.trim()) {
      throw new Error('书源名称不能为空')
    }
    if (!parsed.bookSourceUrl?.trim()) {
      throw new Error('书源链接不能为空')
    }
    await saveBookSource(parsed)
    appStore.showToast('保存书源成功', 'success')
    await loadSources()
    const latest = sources.value.find((item) => item.bookSourceUrl === parsed.bookSourceUrl)
    if (latest) {
      editSource(latest)
    }
  } catch (e: unknown) {
    appStore.showToast((e as Error).message || '保存失败', 'error')
  }
}

async function handleSourceLogin() {
  try {
    const parsed = JSON.parse(editorText.value) as BookSource
    if (!parsed.bookSourceUrl?.trim()) {
      throw new Error('书源链接不能为空')
    }
    if (!parsed.loginUrl?.trim()) {
      throw new Error('当前书源未配置 loginUrl')
    }

    sourceLoginLoading.value = true
    if (!editingSource.value || editingSource.value.bookSourceUrl !== parsed.bookSourceUrl) {
      await saveBookSource(parsed)
      await loadSources()
      const latest = sources.value.find((item) => item.bookSourceUrl === parsed.bookSourceUrl)
      if (latest) {
        editSource(latest)
      }
    }

    const result = await loginBookSource(parsed.bookSourceUrl)
    const check = typeof result.checkResult === 'string' && result.checkResult.trim()
      ? `，校验结果：${result.checkResult}`
      : ''
    if (result.bodyHtml?.trim()) {
      loginPreviewUrl.value = result.url?.trim() || '内置书源登录表单'
      loginPreviewFrameHtml.value = result.bodyHtml
      loginPreviewFrameUrl.value = ''
      loginPreviewVisible.value = true
    } else if (result.url?.trim()) {
      loginPreviewUrl.value = result.url
      loginPreviewFrameHtml.value = ''
      loginPreviewFrameUrl.value = buildLoginProxyUrl(parsed.bookSourceUrl, result.url)
      loginPreviewVisible.value = true
    }
    appStore.showToast(`书源登录请求已完成，状态 ${result.status}${check}`, 'success')
  } catch (e: unknown) {
    appStore.showToast((e as Error).message || '书源登录失败', 'error')
  } finally {
    sourceLoginLoading.value = false
  }
}

function buildLoginProxyUrl(bookSourceUrl: string, targetUrl: string) {
  const params = new URLSearchParams()
  appendAuthQueryParams(params)
  params.set('bookSourceUrl', bookSourceUrl)
  params.set('url', targetUrl)
  return `/reader3/bookSourceProxy?${params.toString()}`
}

function triggerFileImport() {
  fileInputRef.value?.click()
}

async function handleFileImport(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    await openImport((signal) => readSourceFile(file, signal))
  } catch (e: unknown) {
    appStore.showToast((e as Error).message || '导入失败', 'error')
  } finally {
    input.value = ''
  }
}

async function importRemoteSource() {
  if (!remoteUrl.value) {
    appStore.showToast('请输入远程书源链接', 'warning')
    return
  }
  const url = remoteUrl.value
  await openImport(async (signal) => parseRemoteImport(await readRemoteSourceFile(url, signal)), url)
}

async function openImport(read: (signal: AbortSignal) => Promise<unknown[]>, subscriptionUrl?: string) {
  if (importReading.value || importPreview.value || importSaving.value) return
  const generation = ++importGeneration
  importController?.abort()
  const controller = new AbortController(); importController = controller
  importReading.value = true
  try {
    const values = await read(controller.signal)
    if (!values.length) throw new Error('没有可导入的书源')
    const existing = await getBookSources(controller.signal)
    if (generation !== importGeneration || !props.modelValue) return
    importError.value = ''
    importPreview.value = { values, existing, subscriptionUrl }
  } catch (e: unknown) {
    if (generation === importGeneration) appStore.showToast((e as Error).message || '读取书源失败', 'error')
  } finally {
    if (generation === importGeneration) importReading.value = false
  }
}

async function confirmImport(selected: BookSource[]) {
  const preview = importPreview.value
  const generation = importGeneration
  const signal = importController?.signal
  if (!preview || !signal || signal.aborted || importSaving.value || !selected.length) return
  importSaving.value = true
  importError.value = ''
  try {
    const latest = await getBookSources(signal)
    if (generation !== importGeneration || preview !== importPreview.value) return
    const before = new Map(preview.existing.map((source) => [source.bookSourceUrl, sourceFingerprint(source)]))
    const current = new Map(latest.map((source) => [source.bookSourceUrl, sourceFingerprint(source)]))
    const changed = selected.some((source) => before.get(source.bookSourceUrl) !== current.get(source.bookSourceUrl))
    preview.existing = latest
    if (changed) {
      importError.value = '所选地址的现有书源已变化，已刷新状态。请核对后重新点击确认导入。'
      return
    }
    const updates = selected.filter((source) => current.has(source.bookSourceUrl)).length
    if (updates && !confirm(`将更新 ${updates} 个现有书源，是否继续？`)) return
    const result = await saveBookSources(selected, signal)
    if (!result.saved || result.count !== selected.length) throw new Error('保存结果未确认全部完成，请刷新核对后重试')
    if (generation !== importGeneration) return
    importPreview.value = null
    appStore.showToast('所选书源已保存', 'success')
    if (preview.subscriptionUrl && account.value) {
      const ok = await subscriptionState.markSynced(preview.subscriptionUrl)
      if (generation !== importGeneration) return
      if (!ok) appStore.showToast('书源已保存，但订阅时间同步失败；可在远程面板重试时间同步。', 'warning')
    }
    await loadSources()
  } catch (e: unknown) {
    if (generation === importGeneration) importError.value = (e as Error).message || '保存失败，请核对后重试'
  } finally {
    if (generation === importGeneration) importSaving.value = false
  }
}

async function saveSubscription() {
  const url = remoteUrl.value.trim()
  if (!url) { appStore.showToast('请输入远程书源链接', 'warning'); return }
  if (await subscriptionState.mutate({ operation: 'add', url })) appStore.showToast('订阅已同步到当前账号', 'success')
}
async function syncSubscription(url: string) {
  remoteUrl.value = url
  await importRemoteSource()
}
async function removeSubscription(url: string) {
  if (await subscriptionState.mutate({ operation: 'remove', url })) appStore.showToast('订阅已删除并同步', 'success')
}
async function retrySubscriptionTimestamp(target?: string) {
  const url = target || subscriptionState.pendingTimestamp.value
  if (!url || !subscriptionState.pendingTimestamps.value.includes(url)) return
  if (url && await subscriptionState.markSynced(url)) appStore.showToast('订阅时间已同步', 'success')
}

function exportSources() {
  const blob = new Blob([JSON.stringify(sources.value, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `reader-book-sources-${formatDateForFile()}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

function formatDateForFile() {
  const date = new Date()
  const pad = (v: number) => `${v}`.padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function close() {
  if (importSaving.value) return
  cancelImport()
  emit('update:modelValue', false)
}

watch(() => props.modelValue, (v) => {
  if (!v) { cancelImport(); importSaving.value = false }
  if (v) {
    workspaceManual = false; defaultWorkspace()
    if (!sourceStore.loaded) {
      loadSources(false)
    }
    if (!editingSource.value && !editorText.value.trim()) {
      createSource()
    }
  }
}, { immediate: true })
watch(account, (next, previous) => {
  if (next === previous) return
  cancelImport(); importSaving.value = false
  remoteUrl.value = ''; selectedSourceUrls.value.clear(); editingSource.value = null
  editorText.value = JSON.stringify(createEmptySource(), null, 2)
  sourceStore.reset()
  if (props.modelValue) void loadSources()
}, { flush: 'sync' })
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: var(--z-overlay);
  backdrop-filter: blur(4px);
}

.modal-container {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding:
    calc(var(--space-6) + var(--safe-area-top))
    calc(var(--space-6) + var(--safe-area-right))
    calc(var(--space-6) + var(--safe-area-bottom))
    calc(var(--space-6) + var(--safe-area-left));
}

.source-modal {
  width: min(1180px, 100%);
  height: min(780px, calc(var(--app-visual-height, var(--app-height, 100vh)) - var(--safe-area-top) - var(--safe-area-bottom) - 32px));
  max-height: min(88vh, calc(var(--app-visual-height, var(--app-height, 100vh)) - var(--safe-area-top) - var(--safe-area-bottom) - 32px));
  background: var(--color-bg-elevated);
  border-radius: var(--radius-xl);
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-xl);
  overflow: hidden;
}

.hidden-input {
  display: none;
}

.content-grid {
  display: grid;
  grid-template-columns: minmax(320px, 42%) minmax(420px, 58%);
  gap: 14px;
  min-height: 0;
  flex: 1;
  padding: 14px 24px 0;
  overflow: hidden;
}

.source-list-slot,
.editor-slot {
  min-height: 0;
}

.modal-footer {
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
  padding: 8px 24px 14px;
  flex-shrink: 0;
}

.count-info {
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.mini-btn,
.icon-btn {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: transparent;
  transition: all var(--duration-fast);
}

.mini-btn {
  min-height: 32px;
  padding: 0 10px;
  font-size: 12px;
  white-space: nowrap;
}

.mini-btn.danger {
  color: var(--color-danger);
  border-color: rgba(245, 34, 45, 0.2);
}

.icon-btn {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
}

.icon-btn svg {
  width: 18px;
  height: 18px;
}

.mini-btn:hover,
.icon-btn:hover {
  background: var(--color-bg-hover);
}

.login-preview-container {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-modal) + 2);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.35);
}

.login-preview-modal {
  width: min(980px, 100%);
  height: min(86vh, 900px);
  background: var(--color-bg-elevated);
  border-radius: var(--radius-xl);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-xl);
}

.login-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border-light);
}

.login-preview-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
}

.login-preview-header p {
  margin-top: 6px;
  font-size: 12px;
  color: var(--color-text-tertiary);
  word-break: break-all;
}

.login-preview-frame {
  flex: 1;
  width: 100%;
  border: none;
  background: #fff;
}

@media (max-width: 900px) {
  .modal-container {
    align-items: stretch;
    padding: 8px;
  }

  .source-modal {
    width: 100%;
    height: calc(var(--app-visual-height, var(--app-height, 100vh)) - 16px);
    max-height: calc(var(--app-visual-height, var(--app-height, 100vh)) - 16px);
    border-radius: 24px;
    overflow-y: auto;
  }

  .content-grid {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    flex: 1;
    min-height: 180px;
    padding-left: 16px;
    padding-right: 16px;
  }

  .editor-slot {
    order: -1;
    min-height: 0;
    flex: 0 1 auto;
    max-height: min(52%, 300px);
  }

  .editor-collapsed { flex: 0 0 auto; max-height: none; }

  .source-list-slot {
    flex: 1;
    min-height: 64px;
    max-height: none;
  }

  .modal-footer {
    padding: 10px 16px 14px;
    background: var(--color-bg-elevated);
    border-top: 1px solid var(--color-border-light);
  }
}

@media (max-width: 420px) {
  .modal-container {
    padding:
      calc(8px + var(--safe-area-top))
      calc(8px + var(--safe-area-right))
      calc(8px + var(--safe-area-bottom))
      calc(8px + var(--safe-area-left));
  }

  .source-modal {
    border-radius: 20px;
  }
}
</style>
