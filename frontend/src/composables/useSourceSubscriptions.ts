import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { changeSourceSubscriptions, getSourceSubscriptions, type SourceSubscription, type SubscriptionOperation } from '../api/sourceSubscriptions'

const LEGACY_KEY = 'reader-source-subscriptions'
export function useSourceSubscriptions(account: Ref<string | null>, visible: Ref<boolean>) {
  const items = ref<SourceSubscription[]>([])
  const loaded = ref(false), loading = ref(false), busy = ref(false), error = ref('')
  const pendingTimestamps = ref<string[]>([])
  const pendingTimestamp = computed(() => pendingTimestamps.value[0] ?? null)
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
        url: item.url.trim(), ...(Number.isSafeInteger(item.lastSyncedAt) && item.lastSyncedAt > 0 ? { lastSyncedAt: item.lastSyncedAt } : {}),
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
      return true
    } catch {
      if (epoch === generation) error.value = '订阅同步失败，请重试。'
      return false
    } finally { controllers.delete(controller); if (epoch === generation) busy.value = false }
  }
  async function migrate() {
    const epoch = generation
    if (!migrationAvailable.value || !confirm(`将本机记录同步到当前账号“${account.value}”？原本机记录将保留。`)) return
    if (await mutate({ operation: 'migrate', items: legacy() }) && epoch === generation) {
      try {
        localStorage.setItem(migrationKey(), 'true'); migrated.value = true
      } catch {
        error.value = '订阅已合并，但本机迁移标识保存失败。原记录仍保留，恢复本机存储后可重试。'
      }
    }
  }
  async function markSynced(url: string) {
    const epoch = generation
    const ok = await mutate({ operation: 'synced', url })
    if (epoch === generation) {
      if (ok) pendingTimestamps.value = pendingTimestamps.value.filter((pending) => pending !== url)
      else if (!pendingTimestamps.value.includes(url)) pendingTimestamps.value.push(url)
    }
    return ok
  }
  watch(account, () => {
    abortRequests()
    generation++; request++; items.value = []; loaded.value = false; loading.value = false; busy.value = false
    error.value = ''; pendingTimestamps.value = []
    migrated.value = !!account.value && localStorage.getItem(migrationKey()) === 'true'
    if (visible.value && account.value) void refresh()
  }, { immediate: true, flush: 'sync' })
  watch(visible, (open) => { if (open) void refresh() })
  function foreground() { if (visible.value && document.visibilityState === 'visible') void refresh() }
  document.addEventListener('visibilitychange', foreground)
  window.addEventListener('focus', foreground)
  onBeforeUnmount(() => { generation++; request++; abortRequests(); document.removeEventListener('visibilitychange', foreground); window.removeEventListener('focus', foreground) })
  return { items, loaded, loading, busy, error, migrationAvailable, pendingTimestamp, pendingTimestamps, refresh, mutate, migrate, markSynced }
}
