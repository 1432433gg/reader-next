import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { changeSourceSubscriptions, getSourceSubscriptions, type SourceSubscription, type SubscriptionOperation } from '../api/sourceSubscriptions'

const LEGACY_KEY = 'reader-source-subscriptions'
export type TimestampContext = { name?: string; existingOnly?: boolean; urlVersion?: number }
export type SubscriptionDraft = { url: string; expectedName: string | null; name: string; newUrl: string }
export function useSourceSubscriptions(account: Ref<string | null>, visible: Ref<boolean>) {
  const items = ref<SourceSubscription[]>([])
  const loaded = ref(false), loading = ref(false), busy = ref(false), error = ref('')
  const pendingContexts = ref(new Map<string, TimestampContext>())
  const pendingTimestamps = computed(() => Array.from(pendingContexts.value.keys()))
  const pendingTimestamp = computed(() => pendingTimestamps.value[0] ?? null)
  const editDraft = ref<SubscriptionDraft | null>(null)
  const urlVersions = new Map<string, number>()
  function invalidateUrl(url: string) { urlVersions.set(url, (urlVersions.get(url) || 0) + 1); pendingContexts.value.delete(url) }
  const migrated = ref(false)
  let generation = 0, request = 0
  const controllers = new Set<AbortController>()
  function abortRequests() { controllers.forEach((controller) => controller.abort()); controllers.clear() }
  const migrationKey = () => 'reader-source-subscriptions-migrated:' + encodeURIComponent(account.value || '')
  function legacy(): SourceSubscription[] {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]')
      if (!Array.isArray(raw)) return []
      return raw.filter((item) => item && typeof item.url === 'string' && item.url.trim()).map((item) => ({
        url: item.url.trim(), ...(typeof item.name === 'string' ? { name: item.name.trim() } : {}), ...(Number.isSafeInteger(item.lastSyncedAt) && item.lastSyncedAt > 0 ? { lastSyncedAt: item.lastSyncedAt } : {}),
      }))
    } catch { return [] }
  }
  const migrationAvailable = computed(() => !!account.value && !migrated.value && legacy().length > 0)
  async function refresh() {
    if (!account.value || busy.value) return
    const epoch = generation, id = ++request
    const controller = new AbortController(); controllers.add(controller)
    loading.value = true
    try {
      const doc = await getSourceSubscriptions(controller.signal)
      if (epoch !== generation || id !== request) return
      items.value = doc.items; loaded.value = true; error.value = ''
    } catch {
      if (epoch === generation && id === request) error.value = '读取订阅失败，请重试；当前列表可能不是最新状态。'
    } finally { controllers.delete(controller); if (epoch === generation && id === request) loading.value = false }
  }
  async function mutate(operation: SubscriptionOperation) {
    if (!account.value || busy.value) return false
    const epoch = generation
    const controller = new AbortController(); controllers.add(controller)
    ++request // Invalidate an earlier read that could overwrite this response.
    busy.value = true; loading.value = false; error.value = ''
    try {
      const doc = await changeSourceSubscriptions(operation, controller.signal)
      if (epoch !== generation) return false
      items.value = doc.items; loaded.value = true
      if (operation.operation === 'remove') invalidateUrl(operation.url)
      return true
    } catch (cause) {
      if (epoch === generation) error.value = operation.operation === 'update'
        ? '修改未确认保存。请保留草稿，重新读取并核对是否冲突或已保存，再重试。'
        : '订阅同步失败，请重试。'
      return false
    } finally { controllers.delete(controller); if (epoch === generation) busy.value = false }
  }
  async function migrate() {
    const epoch = generation
    if (!migrationAvailable.value || !confirm('将本机记录同步到已登录账号？原本机记录将保留。')) return
    if (await mutate({ operation: 'migrate', items: legacy() }) && epoch === generation) {
      try {
        localStorage.setItem(migrationKey(), 'true'); migrated.value = true
      } catch {
        error.value = '订阅已合并，但本机迁移标识保存失败。原记录仍保留，恢复本机存储后可重试。'
      }
    }
  }
  function beginEdit(item: SourceSubscription) {
    if (busy.value || (editDraft.value && editDraft.value.url !== item.url)) return
    if (!editDraft.value) editDraft.value = { url: item.url, expectedName: item.name?.trim() || null, name: item.name || '', newUrl: item.url }
  }
  async function saveEdit() {
    const draft = editDraft.value, epoch = generation
    if (!draft) return false
    if (Array.from(draft.name.trim()).length > 80) { error.value = '订阅名称最多80个字符'; return false }
    const ok = await mutate({ operation: 'update', url: draft.url, expectedName: draft.expectedName, newUrl: draft.newUrl.trim(), name: draft.name.trim() })
    if (ok && epoch === generation && editDraft.value === draft) {
      if (draft.url !== draft.newUrl.trim()) invalidateUrl(draft.url)
      else if (pendingContexts.value.has(draft.url)) pendingContexts.value.set(draft.url, { name: draft.name.trim(), existingOnly: true })
      editDraft.value = null
    }
    return ok
  }
  function captureContext(url: string, context: TimestampContext): TimestampContext { return { ...context, urlVersion: urlVersions.get(url) || 0 } }
  async function retryTimestamp(url: string) {
    const context = pendingContexts.value.get(url)
    if (!context) return false
    return markSynced(url, context)
  }
  async function markSynced(url: string, context: TimestampContext = {}) {
    const epoch = generation
    const version = context.urlVersion ?? (urlVersions.get(url) || 0)
    if (version !== (urlVersions.get(url) || 0)) return false
    const captured = { ...context, urlVersion: version }
    const ok = await mutate({ operation: 'synced', url, ...(captured.name === undefined ? {} : { name: captured.name }), ...(captured.existingOnly === undefined ? {} : { existingOnly: captured.existingOnly }) })
    if (epoch === generation && version === (urlVersions.get(url) || 0)) {
      if (ok) pendingContexts.value.delete(url)
      else pendingContexts.value.set(url, captured)
    }
    return ok
  }
  watch(account, () => {
    abortRequests()
    generation++; request++; items.value = []; loaded.value = false; loading.value = false; busy.value = false
    error.value = ''; pendingContexts.value.clear(); urlVersions.clear(); editDraft.value = null
    migrated.value = !!account.value && localStorage.getItem(migrationKey()) === 'true'
    if (visible.value && account.value) void refresh()
  }, { immediate: true, flush: 'sync' })
  watch(visible, (open) => { if (open) void refresh(); else editDraft.value = null })
  function foreground() { if (visible.value && document.visibilityState === 'visible') void refresh() }
  document.addEventListener('visibilitychange', foreground)
  window.addEventListener('focus', foreground)
  onBeforeUnmount(() => { generation++; request++; abortRequests(); document.removeEventListener('visibilitychange', foreground); window.removeEventListener('focus', foreground) })
  return { items, loaded, loading, busy, error, editDraft, beginEdit, saveEdit, migrationAvailable, pendingTimestamp, pendingTimestamps, pendingContexts, captureContext, retryTimestamp, refresh, mutate, migrate, markSynced }
}
