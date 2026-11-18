<template>
  <Transition name="fade">
    <div v-if="visible" class="subscription-backdrop" @click.self="$emit('close')">
      <section class="subscription-panel">
        <header class="subscription-header">
          <div>
            <h3>远程书源同步</h3>
            <p>保存书源合集链接，后续可以一键同步更新。</p>
          </div>
          <button class="icon-btn" type="button" title="关闭" @click="$emit('close')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <p v-if="!account" role="status">请登录后保存和同步账号订阅。</p>
        <p v-if="error" role="alert">{{ error }} <button type="button" :disabled="loading || busy" @click="$emit('refresh')">重新读取</button></p>
        <p v-for="(url, index) in pendingTimestamps" :key="url" role="status" class="timestamp-retry">书源已保存，订阅 {{ index + 1 }} 时间尚未同步：<span>{{ url }}</span><button type="button" :disabled="busy" @click="$emit('retry-timestamp', url)">重试时间同步</button></p>
        <button v-if="migrationAvailable" type="button" class="action-btn" :disabled="busy" @click="$emit('migrate')">将本机记录同步到当前账号</button>

        <div class="remote-form">
          <label>订阅名称<input :value="remoteName" aria-label="订阅名称" placeholder="可选，最多80个字符" @input="$emit('update:remoteName', ($event.target as HTMLInputElement).value)" /></label>
          <label>订阅链接
          <input
            :value="remoteUrl"
            type="text"
            placeholder="输入远程书源合集链接"
            @input="$emit('update:remoteUrl', ($event.target as HTMLInputElement).value)"
          />
          </label>
          <button class="action-btn primary" type="button" @click="$emit('sync')">立即同步</button>
          <button class="action-btn" type="button" :disabled="!account || busy" @click="$emit('save')">保存订阅</button>
        </div>

        <div v-if="displayedSubscriptions.length" class="subscription-list">
          <article v-for="item in displayedSubscriptions" :key="item.url" class="subscription-item">
            <div class="subscription-main">
              <strong>{{ item.name || item.url }}</strong>
              <span class="subscription-url">{{ item.url }}</span>
              <span v-if="item.lastSyncedAt" class="subscription-time">上次同步 {{ formatTime(item.lastSyncedAt) }}</span>
            </div>
            <form v-if="editDraft?.url === item.url" class="subscription-edit" @submit.prevent="$emit('save-edit')">
              <label>名称<input v-model="editDraft.name" aria-label="修改订阅名称" :disabled="busy" /></label>
              <label>链接<input v-model="editDraft.newUrl" aria-label="修改订阅链接" :disabled="busy" inputmode="url" /></label>
              <div><button type="button" class="mini-btn" :disabled="busy" @click="$emit('cancel-edit')">取消</button><button type="submit" class="mini-btn primary" :disabled="busy">保存修改</button></div>
            </form>
            <div class="subscription-actions">
              <button class="mini-btn" type="button" :disabled="busy || !!editDraft" @click="$emit('sync-subscription', item.url)">同步</button>
              <button class="mini-btn" type="button" :disabled="busy || !!editDraft" @click="$emit('edit-subscription', item)">编辑</button>
              <button class="mini-btn danger" type="button" :disabled="busy || !!editDraft" @click="$emit('remove-subscription', item.url)">删除</button>
            </div>
          </article>
        </div>
        <div v-else-if="loading" class="subscription-empty">正在读取账号订阅…</div>
        <div v-else-if="loaded && !error" class="subscription-empty">还没有保存的远程订阅。</div>
      </section>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { SubscriptionDraft } from '../../composables/useSourceSubscriptions'
export type SourceSubscription = {
  url: string
  name?: string
  lastSyncedAt?: number
}

const props = defineProps<{
  visible: boolean
  remoteUrl: string
  remoteName?: string
  editDraft?: SubscriptionDraft | null
  subscriptions: SourceSubscription[]
  account: string | null
  loaded: boolean
  loading: boolean
  busy: boolean
  error: string
  migrationAvailable: boolean
  pendingTimestamps: string[]
}>()

defineEmits<{
  'update:remoteName': [value: string]
  'edit-subscription': [source: SourceSubscription]
  'save-edit': []
  'cancel-edit': []
  refresh: []
  migrate: []
  'retry-timestamp': [url: string]
  'update:remoteUrl': [value: string]
  sync: []
  save: []
  'sync-subscription': [url: string]
  'remove-subscription': [url: string]
  close: []
}>()
// A refresh/delete conflict must not make the active draft disappear.
const displayedSubscriptions = computed(() => props.editDraft && !props.subscriptions.some((item) => item.url === props.editDraft!.url)
  ? [...props.subscriptions, { url: props.editDraft.url, name: props.editDraft.expectedName || undefined }]
  : props.subscriptions)

function formatTime(ts: number) {
  return new Date(ts).toLocaleString()
}
</script>

<style scoped>
.remote-form, .subscription-edit { display: flex !important; flex-direction: column; gap: 10px; width: 100%; min-width: 0; }
.remote-form label, .subscription-edit label { display: flex; flex-direction: column; gap: 4px; min-width: 0; font-size: 13px; }
.remote-form input, .subscription-edit input { width: 100%; min-width: 0; box-sizing: border-box; font-size: 16px; padding: 10px; border: 1px solid var(--color-border); border-radius: 8px; }
.subscription-item { flex-wrap: wrap; }
.subscription-edit { flex-basis: 100%; }
.subscription-list, .subscription-item, .subscription-main { min-width: 0; max-width: 100%; box-sizing: border-box; }
.subscription-item { flex-shrink: 0; }
.subscription-main { flex: 1 1 0; }
@media (max-width: 640px) { .subscription-edit { flex-basis: auto; } .subscription-main { flex: 0 1 auto; width: 100%; } }
.subscription-main strong { overflow-wrap: anywhere; }
.timestamp-retry { overflow-wrap: anywhere; }
.timestamp-retry span { display: block; font-size: 12px; }
.subscription-backdrop {
  --subscription-gap: 24px;
  position: fixed;
  top: var(--viewport-offset-top, 0px);
  left: var(--viewport-offset-left, 0px);
  width: var(--app-visual-width, var(--app-width, 100vw));
  height: var(--app-visual-height, var(--app-height, 100vh));
  box-sizing: border-box;
  z-index: calc(var(--z-modal) + 1);
  display: flex;
  align-items: center;
  justify-content: center;
  padding:
    calc(var(--subscription-gap) + var(--safe-area-top, 0px))
    calc(var(--subscription-gap) + var(--safe-area-right, 0px))
    calc(var(--subscription-gap) + var(--safe-area-bottom, 0px))
    calc(var(--subscription-gap) + var(--safe-area-left, 0px));
  background: rgba(0, 0, 0, 0.28);
}

.subscription-panel {
  width: min(720px, 100%);
  max-height: min(calc(var(--app-visual-height, var(--app-height, 100vh)) * 0.78), 720px, 100%);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  border: 1px solid var(--color-border-light);
  border-radius: var(--radius-xl);
  background: var(--color-bg-elevated);
  box-shadow: var(--shadow-xl);
  overflow: auto;
  overscroll-behavior: contain;
}

.subscription-panel > * { flex-shrink: 0; }

.subscription-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.subscription-header h3 {
  margin: 0;
  font-size: 17px;
}

.subscription-header p {
  margin-top: 6px;
  color: var(--color-text-tertiary);
  font-size: 13px;
}

.remote-form {
  display: flex;
  gap: 10px;
}

.remote-form input {
  flex: 1;
  min-width: 0;
  min-height: 40px;
  padding: 0 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
}

.subscription-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.subscription-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--color-border-light);
  border-radius: var(--radius-lg);
  background: var(--color-bg);
}

.subscription-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.subscription-url {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subscription-time,
.subscription-empty {
  margin-top: 4px;
  color: var(--color-text-tertiary);
  font-size: 12px;
}

.subscription-actions {
  display: flex;
  gap: 8px;
}

.action-btn,
.mini-btn,
.icon-btn {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: transparent;
  transition: all var(--duration-fast);
}

.action-btn {
  min-height: 40px;
  padding: 0 12px;
  font-size: 13px;
  white-space: nowrap;
}

.action-btn.primary {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: #fff;
}

.mini-btn {
  min-height: 32px;
  padding: 0 10px;
  font-size: 12px;
}

.mini-btn.danger {
  color: var(--color-danger);
  border-color: rgba(245, 34, 45, 0.2);
}

.icon-btn {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.icon-btn svg {
  width: 16px;
  height: 16px;
}

.action-btn:hover,
.mini-btn:hover,
.icon-btn:hover {
  background: var(--color-bg-hover);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--duration-normal) var(--ease-out);
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@media (max-width: 640px) {
  .subscription-backdrop {
    --subscription-gap: 12px;
    align-items: stretch;
  }

  .remote-form,
  .subscription-item {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
