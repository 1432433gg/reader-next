<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="visible" class="import-backdrop" @click.self="$emit('close')">
        <section class="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
          <header class="import-header">
            <div>
              <h3 id="import-title">{{ title || '书源导入预览' }}</h3>
              <p>静态解析文件内容；不会请求书源站点、执行规则脚本或保存书源。</p>
            </div>
            <button class="icon-btn" type="button" title="关闭" @click="$emit('close')">×</button>
          </header>

          <div class="import-summary">
            <span>共 {{ entries.length }} 项</span>
            <span>可导入 {{ importableCount }}</span>
            <span>重复 {{ duplicateCount }}</span>
            <span>错误 {{ invalidCount }}</span>
            <span>选中 {{ selectedCount }}</span>
            <span v-if="selectedSaveCount !== selectedCount">待保存 {{ selectedSaveCount }}</span>
            <span v-if="selectedOverwriteCount">覆盖 {{ selectedOverwriteCount }}</span>
          </div>

          <p v-if="notice" class="import-notice" role="status">{{ notice }}</p>

          <div class="import-filters">
            <input v-model.trim="searchText" type="search" placeholder="搜索名称、地址或分组" aria-label="搜索书源预览" />
            <select v-model="groupFilter" aria-label="按分组筛选">
              <option value="">全部分组</option>
              <option v-for="group in groups" :key="group" :value="group">{{ group }}</option>
            </select>
            <button class="mini-btn" type="button" :disabled="!visibleEntries.length" @click="toggleVisibleSelection">
              {{ allVisibleSelected ? '取消当前筛选' : '全选当前筛选' }}
            </button>
          </div>

          <div class="import-table-wrap">
            <table class="import-table">
              <thead>
                <tr>
                  <th>选择</th>
                  <th>书源与规则</th>
                  <th>状态</th>
                  <th>覆盖现有</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="entry in visibleEntries" :key="entry.id" :class="{ invalid: entry.error || entry.duplicateOf }">
                  <td class="select-cell">
                    <input
                      type="checkbox"
                      :checked="selectedIds.has(entry.id)"
                      :disabled="!canSelect(entry) || isStale(entry)"
                      :aria-label="`选择 ${entry.source?.bookSourceName || entry.location}`"
                      @change="toggleSelection(entry)"
                    />
                  </td>
                  <td>
                    <strong>{{ entry.source?.bookSourceName || entry.location }}</strong>
                    <div v-if="entry.source" class="source-url">{{ entry.source.bookSourceUrl }}</div>
                    <div class="source-meta">
                      <span v-if="entry.domain">{{ entry.domain }}</span>
                      <span v-if="entry.source?.bookSourceGroup">分组：{{ entry.source.bookSourceGroup }}</span>
                      <span>规则：{{ entry.formats.join('、') || '未识别' }}</span>
                      <span v-for="dependency in entry.dependencies" :key="dependency" class="tag">{{ dependency }}</span>
                    </div>
                    <div v-if="entry.error" class="row-error">{{ entry.error }}</div>
                    <div v-else-if="entry.duplicateOf" class="row-error">包内地址重复；与 {{ entry.duplicateOf }} 相同，本项不会导入。</div>
                    <div v-else-if="isStale(entry)" class="row-error">预览后此书源发生变化，请重新检查后选择。</div>
                  </td>
                  <td>
                    <span v-if="entry.error" class="status invalid-status">不可导入</span>
                    <span v-else-if="entry.duplicateOf" class="status invalid-status">包内重复</span>
                    <span v-else-if="currentExisting(entry)" class="status existing-status">现有书源，默认跳过</span>
                    <span v-else class="status new-status">新增</span>
                  </td>
                  <td>
                    <label v-if="canOverwrite(entry)" class="overwrite-choice">
                      <input
                        type="checkbox"
                        :checked="overwriteIds.has(entry.id)"
                        :disabled="!selectedIds.has(entry.id) || isStale(entry)"
                        @change="toggleOverwrite(entry)"
                      />
                      <span>确认覆盖</span>
                    </label>
                    <span v-else class="muted">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <footer class="import-footer">
            <span class="footer-note">现有书源不会被覆盖，除非逐项勾选“确认覆盖”并在下一步确认。</span>
            <div class="footer-actions">
              <button class="mini-btn" type="button" @click="$emit('close')">取消</button>
              <button class="mini-btn primary" type="button" :disabled="!selectedSaveCount || hasSelectedStale || loading" @click="applySelection">
                {{ loading ? '保存中…' : '确认导入' }}
              </button>
            </div>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { BookSource } from '../../types'
import { normalizeSourceAddress, type SourceImportEntry } from '../../utils/sourceImport'

export type SourceImportChoice = {
  source: BookSource
  action: 'add' | 'overwrite'
  expectedExisting?: BookSource
}

const props = defineProps<{
  visible: boolean
  title: string
  entries: SourceImportEntry[]
  snapshotSources: BookSource[]
  currentSources: BookSource[]
  snapshotVersion: number
  notice: string
  loading: boolean
}>()

const emit = defineEmits<{
  close: []
  apply: [choices: SourceImportChoice[]]
}>()

const selectedIds = ref(new Set<string>())
const overwriteIds = ref(new Set<string>())
const searchText = ref('')
const groupFilter = ref('')

const snapshotByUrl = computed(() => byAddress(props.snapshotSources))
const currentByUrl = computed(() => byAddress(props.currentSources))
const groups = computed(() => [...new Set(props.entries
  .map((entry) => entry.source?.bookSourceGroup)
  .filter((group): group is string => typeof group === 'string' && Boolean(group.trim()))
  .map((group) => group.trim())
  .flatMap((group) => group.split(/[,;；、]/).map((part) => part.trim()).filter(Boolean)))].sort())

const visibleEntries = computed(() => {
  const needle = searchText.value.toLocaleLowerCase()
  return props.entries.filter((entry) => {
    const source = entry.source
    const sourceGroup = typeof source?.bookSourceGroup === 'string' ? source.bookSourceGroup : ''
    const groupMatches = !groupFilter.value || sourceGroup
      .split(/[,;；、]/)
      .map((group) => group.trim())
      .includes(groupFilter.value)
    const searchable = [entry.location, source?.bookSourceName, source?.bookSourceUrl, source?.bookSourceGroup]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase()
    return groupMatches && (!needle || searchable.includes(needle))
  })
})

const importableCount = computed(() => props.entries.filter((entry) => canSelect(entry)).length)
const invalidCount = computed(() => props.entries.filter((entry) => entry.error).length)
const duplicateCount = computed(() => props.entries.filter((entry) => entry.duplicateOf).length)
const selectedCount = computed(() => props.entries.filter((entry) => selectedIds.value.has(entry.id) && canSelect(entry)).length)
const selectedSaveCount = computed(() => props.entries.filter((entry) =>
  selectedIds.value.has(entry.id) && canSelect(entry) && (!snapshotExisting(entry) || overwriteIds.value.has(entry.id))
).length)
const selectedOverwriteCount = computed(() => props.entries.filter((entry) =>
  selectedIds.value.has(entry.id) && overwriteIds.value.has(entry.id) && canOverwrite(entry)
).length)
const allVisibleSelected = computed(() => {
  const selectable = visibleEntries.value.filter(canSelect)
  return selectable.length > 0 && selectable.every((entry) => selectedIds.value.has(entry.id))
})
const hasSelectedStale = computed(() => props.entries.some((entry) =>
  selectedIds.value.has(entry.id) && isStale(entry)
))

watch(() => props.visible, (visible) => {
  if (!visible) return
  searchText.value = ''
  groupFilter.value = ''
  resetSelection()
}, { immediate: true })

watch(() => props.snapshotVersion, (version, previous) => {
  if (props.visible && version !== previous) resetSelection()
})

function resetSelection() {
  const next = new Set<string>()
  for (const entry of props.entries) {
    if (canSelect(entry) && !snapshotExisting(entry)) next.add(entry.id)
  }
  selectedIds.value = next
  overwriteIds.value = new Set()
}

function canSelect(entry: SourceImportEntry) {
  return Boolean(entry.source && !entry.error && !entry.duplicateOf)
}

function currentExisting(entry: SourceImportEntry) {
  if (!entry.source) return undefined
  return currentByUrl.value.get(normalizeSourceAddress(entry.source.bookSourceUrl))
}

function snapshotExisting(entry: SourceImportEntry) {
  if (!entry.source) return undefined
  return snapshotByUrl.value.get(normalizeSourceAddress(entry.source.bookSourceUrl))
}

function canOverwrite(entry: SourceImportEntry) {
  return canSelect(entry) && Boolean(currentExisting(entry) || snapshotExisting(entry))
}

function isStale(entry: SourceImportEntry) {
  if (!entry.source) return false
  const before = snapshotExisting(entry)
  const now = currentExisting(entry)
  if (!before && !now) return false
  if (!before || !now) return true
  return signature(before) !== signature(now)
}

function toggleSelection(entry: SourceImportEntry) {
  if (!canSelect(entry) || isStale(entry)) return
  const next = new Set(selectedIds.value)
  if (next.has(entry.id)) {
    next.delete(entry.id)
    const overwrites = new Set(overwriteIds.value)
    overwrites.delete(entry.id)
    overwriteIds.value = overwrites
  } else {
    next.add(entry.id)
  }
  selectedIds.value = next
}

function toggleOverwrite(entry: SourceImportEntry) {
  if (!selectedIds.value.has(entry.id) || isStale(entry)) return
  const next = new Set(overwriteIds.value)
  if (next.has(entry.id)) next.delete(entry.id)
  else next.add(entry.id)
  overwriteIds.value = next
}

function toggleVisibleSelection() {
  const next = new Set(selectedIds.value)
  const selectable = visibleEntries.value.filter(canSelect)
  const shouldSelect = !allVisibleSelected.value
  for (const entry of selectable) {
    if (shouldSelect && !isStale(entry)) next.add(entry.id)
    else next.delete(entry.id)
  }
  selectedIds.value = next
  if (!shouldSelect) {
    const overwrites = new Set(overwriteIds.value)
    selectable.forEach((entry) => overwrites.delete(entry.id))
    overwriteIds.value = overwrites
  }
}

function applySelection() {
  const choices: SourceImportChoice[] = []
  for (const entry of props.entries) {
    if (!entry.source || !selectedIds.value.has(entry.id)) continue
    if (isStale(entry)) return

    const existing = snapshotExisting(entry)
    if (existing) {
      if (overwriteIds.value.has(entry.id)) {
        choices.push({ source: entry.source, action: 'overwrite', expectedExisting: existing })
      }
    } else {
      choices.push({ source: entry.source, action: 'add' })
    }
  }

  if (!choices.length) return

  if (selectedOverwriteCount.value > 0 && !window.confirm(`将覆盖 ${selectedOverwriteCount.value} 个现有书源。保存时会再次核对当前版本，是否继续？`)) return
  emit('apply', choices)
}

function byAddress(sources: BookSource[]) {
  const map = new Map<string, BookSource>()
  for (const source of sources) {
    const key = normalizeSourceAddress(source.bookSourceUrl)
    if (key && !map.has(key)) map.set(key, source)
  }
  return map
}

function signature(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortKeys(item)]))
  }
  return value
}
</script>

<style scoped>
.import-backdrop {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-modal) + 4);
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(12, 18, 28, 0.58);
}

.import-dialog {
  width: min(1100px, 100%);
  max-height: min(88vh, 900px);
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  border: 1px solid var(--color-border-light);
  border-radius: var(--radius-xl);
  background: var(--color-bg-elevated);
  box-shadow: var(--shadow-xl);
}

.import-header,
.import-footer,
.footer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.import-header h3 {
  margin: 0;
  font-size: 18px;
}

.import-header p,
.footer-note,
.muted {
  color: var(--color-text-tertiary);
  font-size: 12px;
}

.import-header p {
  margin: 5px 0 0;
}

.import-summary,
.import-filters,
.source-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.import-summary span,
.tag,
.status {
  padding: 4px 8px;
  border-radius: 999px;
  background: var(--color-bg-subtle);
  color: var(--color-text-secondary);
  font-size: 12px;
}

.import-notice {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: var(--color-warning-bg, #fff5d7);
  color: var(--color-warning, #775400);
  font-size: 13px;
}

.import-filters input[type='search'] {
  flex: 1 1 260px;
  min-width: 180px;
}

.import-filters input,
.import-filters select {
  min-height: 36px;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
}

.import-table-wrap {
  min-height: 120px;
  overflow: auto;
  border: 1px solid var(--color-border-light);
  border-radius: var(--radius-lg);
}

.import-table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
  font-size: 13px;
}

.import-table th,
.import-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border-light);
  vertical-align: top;
}

.import-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--color-bg-subtle);
  color: var(--color-text-secondary);
}

.import-table tr:last-child td {
  border-bottom: 0;
}

.select-cell {
  width: 56px;
  text-align: center;
}

.source-url {
  margin-top: 3px;
  color: var(--color-text-secondary);
  overflow-wrap: anywhere;
}

.source-meta {
  margin-top: 7px;
  color: var(--color-text-tertiary);
  font-size: 11px;
}

.tag {
  padding: 2px 7px;
  background: var(--color-info-bg, #eaf2ff);
  color: var(--color-info, #315e9e);
  font-size: 11px;
}

.row-error {
  margin-top: 6px;
  color: var(--color-danger, #b42318);
  font-size: 12px;
}

.status {
  display: inline-block;
  white-space: nowrap;
}

.new-status {
  background: var(--color-success-bg, #e7f6ec);
  color: var(--color-success, #247442);
}

.existing-status {
  background: var(--color-warning-bg, #fff5d7);
  color: var(--color-warning, #775400);
}

.invalid-status {
  background: var(--color-danger-bg, #fce9e8);
  color: var(--color-danger, #b42318);
}

.overwrite-choice {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  font-size: 12px;
}

.import-footer {
  padding-top: 2px;
}

.footer-actions {
  flex-shrink: 0;
}

.mini-btn {
  min-height: 36px;
  padding: 7px 13px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-primary);
  cursor: pointer;
}

.mini-btn.primary {
  border-color: var(--color-primary);
  background: var(--color-primary);
  color: #fff;
}

.mini-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.icon-btn {
  width: 34px;
  height: 34px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  font-size: 22px;
}

@media (max-width: 700px) {
  .import-backdrop {
    padding: 8px;
  }

  .import-dialog {
    max-height: 94vh;
    padding: 14px;
  }

  .import-table th,
  .import-table td {
    padding: 8px;
  }

  .import-footer {
    align-items: flex-end;
    flex-direction: column;
  }

  .footer-actions {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
