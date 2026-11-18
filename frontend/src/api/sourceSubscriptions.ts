import http from './http'
export type SourceSubscription = { url: string; name?: string; lastSyncedAt?: number }
export type SubscriptionDocument = { revision: number; items: SourceSubscription[] }
export type SubscriptionOperation = { operation: 'add' | 'synced'; url: string; name?: string; existingOnly?: boolean } | { operation: 'remove'; url: string } | { operation: 'update'; url: string; newUrl: string; name: string; expectedName: string | null } | { operation: 'migrate'; items: SourceSubscription[] }
export function getSourceSubscriptions(signal?: AbortSignal) {
  return http.get<SubscriptionDocument>('/getSourceSubscriptions', { signal }).then((response) => response.data)
}
export function changeSourceSubscriptions(operation: SubscriptionOperation, signal?: AbortSignal) {
  return http.post<SubscriptionDocument>('/changeSourceSubscriptions', operation, { signal }).then((response) => response.data)
}
