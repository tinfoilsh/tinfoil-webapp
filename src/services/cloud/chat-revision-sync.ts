import { CLOUD_SYNC } from '@/config'
import {
  SYNC_ALL_CHATS_STATUS,
  SYNC_CHAT_DELETES_WATERMARK,
  SYNC_CHAT_STATUS,
  SYNC_CHATS,
  SYNC_DELETED_CHATS,
  SYNC_PROJECT_CHAT_STATUS_PREFIX,
  SYNC_SESSION_CHATS,
} from '@/constants/storage-keys'
import { chatEvents } from '@/services/storage/chat-events'
import { deletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import {
  indexedDBStorage,
  type RemoteChatState,
  type StoredChat,
} from '@/services/storage/indexed-db'
import {
  PULL_ITEM_CODES,
  revisionEvents,
  revisionSnapshot,
  revisionSummary,
  type RevisionEvent,
  type RevisionSnapshotItem,
} from '@/services/sync-enclave/sync-api'
import { ingestRemoteChats, type RemoteChatEntry } from './chat-ingestion'
import { cloudStorage } from './cloud-storage'
import { isUploadableChat } from './sync-predicates'

const REVISION_PAGE_LIMIT = 250
export const BOOTSTRAP_RECENT_CONTENT_LIMIT = 50
const DECIMAL_REVISION_PATTERN = /^\d+$/

export interface RevisionSyncResult {
  uploaded: number
  downloaded: number
  errors: string[]
}

export interface RevisionUploadAdapter {
  upload(chat: StoredChat): Promise<void>
  isStreaming(id: string): boolean
  /**
   * Resolve once no upload for this chat is in flight. Deletes MUST
   * settle in-flight uploads first: a create push racing the delete
   * makes the enclave observe "already gone", acknowledge the intent,
   * and then commit the push — resurrecting the deleted chat.
   */
  waitForUpload(id: string): Promise<void>
}

function parseRevision(revision: string): bigint {
  if (!DECIMAL_REVISION_PATTERN.test(revision)) {
    throw new Error('Sync enclave returned an invalid revision')
  }
  return BigInt(revision)
}

function ensureCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) {
    throw new Error('Cloud account changed during synchronization')
  }
}

function etagToSyncVersion(etag: string | undefined): number {
  const version = Number(etag)
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('Sync enclave returned an invalid chat ETag')
  }
  return version
}

type RemoteChatMetadata = Pick<
  RevisionEvent,
  'id' | 'etag' | 'project_id' | 'updated_at'
>

/**
 * Pull and store content for the given rows. Revision sync must mirror
 * the server exactly, so a row the enclave could not return is fatal
 * unless it was deleted between the listing and the pull; a later
 * delete event reconciles that case.
 *
 * Rows are downloaded and stored one batch at a time. Each stored chat
 * carries its etag, so when a later batch fails the next sync cycle
 * recognizes the earlier ones as current and only re-pulls what is
 * still missing instead of starting the whole download over.
 */
async function pullAndIngest(
  rows: readonly RemoteChatMetadata[],
  userId: string,
  isCurrent: () => boolean,
): Promise<number> {
  let downloaded = 0
  for (
    let start = 0;
    start < rows.length;
    start += CLOUD_SYNC.PULL_BATCH_SIZE
  ) {
    const batch = rows.slice(start, start + CLOUD_SYNC.PULL_BATCH_SIZE)
    downloaded += await pullAndIngestBatch(batch, userId, isCurrent)
  }
  return downloaded
}

async function pullAndIngestBatch(
  rows: readonly RemoteChatMetadata[],
  userId: string,
  isCurrent: () => boolean,
): Promise<number> {
  if (rows.length === 0) return 0
  const metadata = new Map(rows.map((row) => [row.id, row]))
  const results = await cloudStorage.downloadChats([...metadata.keys()])
  ensureCurrent(isCurrent)
  const remoteChats: RemoteChatEntry[] = []
  for (const result of results) {
    if (result.status === 'unavailable') {
      if (result.code === PULL_ITEM_CODES.NotFound) continue
      throw new Error(
        `Sync enclave could not return chat ${result.id}: ${result.code}`,
      )
    }
    const row = metadata.get(result.id)!
    remoteChats.push({
      id: result.id,
      content: result.content,
      updatedAt: row.updated_at,
      syncVersion: etagToSyncVersion(row.etag),
      projectId: row.project_id,
    })
  }
  const ingest = await ingestRemoteChats(remoteChats, { isCurrent, userId })
  if (ingest.errors.length > 0) {
    const [failure] = ingest.errors
    throw new Error(`Failed to process chat ${failure.chatId}`, {
      cause: failure.error,
    })
  }
  return ingest.downloaded
}

function toRemoteState(
  event: RevisionEvent | RevisionSnapshotItem,
  revision: string,
  kind: 'upsert' | 'delete',
): RemoteChatState {
  return {
    id: event.id,
    revision,
    kind,
    etag: event.etag,
    keyId: 'key_id' in event ? event.key_id : undefined,
    projectId: event.project_id,
    updatedAt: event.updated_at,
  }
}

function clearLegacyChatSyncKeys(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(SYNC_CHAT_STATUS)
  localStorage.removeItem(SYNC_CHATS)
  localStorage.removeItem(SYNC_ALL_CHATS_STATUS)
  localStorage.removeItem(SYNC_CHAT_DELETES_WATERMARK)
  sessionStorage.removeItem(SYNC_SESSION_CHATS)
  sessionStorage.removeItem(SYNC_DELETED_CHATS)
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const key = localStorage.key(index)
    if (key?.startsWith(SYNC_PROJECT_CHAT_STATUS_PREFIX)) {
      localStorage.removeItem(key)
    }
  }
}

async function applyPulledUpserts(
  events: RevisionEvent[],
  userId: string,
  isCurrent: () => boolean,
): Promise<{ downloaded: number; states: RemoteChatState[] }> {
  if (events.length === 0) return { downloaded: 0, states: [] }
  const pendingDeleteIds = new Set(
    (await indexedDBStorage.getPendingDeletes(userId)).map((entry) => entry.id),
  )
  ensureCurrent(isCurrent)
  const latestById = new Map<string, RevisionEvent>()
  for (const event of events) latestById.set(event.id, event)
  const latest = [...latestById.values()]
  const toPull: RevisionEvent[] = []
  for (const event of latest) {
    if (pendingDeleteIds.has(event.id)) continue
    const local = await indexedDBStorage.getChat(event.id)
    ensureCurrent(isCurrent)
    if (local?.locallyModified) continue
    if (!local || String(local.syncVersion ?? 0) !== event.etag) {
      toPull.push(event)
    }
  }

  const downloaded = await pullAndIngest(toPull, userId, isCurrent)
  return {
    downloaded,
    states: latest.map((event) =>
      toRemoteState(event, event.revision, 'upsert'),
    ),
  }
}

async function bootstrapFromSnapshot(
  userId: string,
  isCurrent: () => boolean,
): Promise<{
  downloaded: number
  revision: string
}> {
  clearLegacyChatSyncKeys()
  const items: RevisionSnapshotItem[] = []
  let cursor: string | undefined
  let snapshotRevision: string | null = null
  do {
    const page = await revisionSnapshot({ cursor, limit: REVISION_PAGE_LIMIT })
    ensureCurrent(isCurrent)
    parseRevision(page.snapshot_revision)
    if (snapshotRevision && snapshotRevision !== page.snapshot_revision) {
      throw new Error('Revision snapshot changed while paginating')
    }
    snapshotRevision = page.snapshot_revision
    items.push(...page.items)
    cursor = page.next_cursor
  } while (cursor)
  if (snapshotRevision === null) {
    throw new Error('Sync enclave returned no snapshot revision')
  }

  const staleExisting: RevisionSnapshotItem[] = []
  const recentMissing: RevisionSnapshotItem[] = []
  const pendingDeleteIds = new Set(
    (await indexedDBStorage.getPendingDeletes(userId)).map((entry) => entry.id),
  )
  ensureCurrent(isCurrent)
  for (const item of [...items].sort((a, b) =>
    b.updated_at.localeCompare(a.updated_at),
  )) {
    const local = await indexedDBStorage.getChat(item.id)
    ensureCurrent(isCurrent)
    if (pendingDeleteIds.has(item.id) || local?.locallyModified) continue
    if (
      local &&
      (local.decryptionFailed || String(local.syncVersion ?? 0) !== item.etag)
    ) {
      staleExisting.push(item)
    } else if (
      !local &&
      recentMissing.length < BOOTSTRAP_RECENT_CONTENT_LIMIT
    ) {
      recentMissing.push(item)
    }
  }
  const downloaded = await pullAndIngest(
    [...staleExisting, ...recentMissing],
    userId,
    isCurrent,
  )

  ensureCurrent(isCurrent)
  const deletedIds = await indexedDBStorage.reconcileRevisionSnapshot(
    items.map((item) => toRemoteState(item, snapshotRevision!, 'upsert')),
    snapshotRevision,
    userId,
  )
  for (const id of deletedIds) deletedChatsTracker.markAsRemoteDeleted(id)
  const restoredIds: string[] = []
  for (const item of items) {
    if (
      !pendingDeleteIds.has(item.id) &&
      deletedChatsTracker.removeRemoteDeletion(item.id)
    ) {
      restoredIds.push(item.id)
    }
  }
  if (restoredIds.length > 0) {
    chatEvents.emit({ reason: 'sync', ids: restoredIds })
  }
  if (deletedIds.length > 0) {
    chatEvents.emit({ reason: 'sync', ids: deletedIds })
  }
  return { downloaded, revision: snapshotRevision }
}

async function applyEvents(
  afterRevision: string,
  throughRevision: string,
  userId: string,
  isCurrent: () => boolean,
): Promise<number> {
  let cursor: string | undefined
  let lastRevision = parseRevision(afterRevision)
  let downloaded = 0
  const committedStates: RemoteChatState[] = []
  let pendingUpserts: RevisionEvent[] = []
  const clearTombstoneIds = new Set<string>()

  const flushUpserts = async () => {
    const applied = await applyPulledUpserts(pendingUpserts, userId, isCurrent)
    downloaded += applied.downloaded
    committedStates.push(...applied.states)
    const pendingDeleteIds = new Set(
      (await indexedDBStorage.getPendingDeletes(userId)).map(
        (entry) => entry.id,
      ),
    )
    for (const state of applied.states) {
      if (!pendingDeleteIds.has(state.id)) clearTombstoneIds.add(state.id)
    }
    pendingUpserts = []
  }

  do {
    const page = await revisionEvents({
      afterRevision,
      throughRevision,
      cursor,
      limit: REVISION_PAGE_LIMIT,
    })
    ensureCurrent(isCurrent)
    for (const event of page.events) {
      const revision = parseRevision(event.revision)
      if (
        revision <= lastRevision ||
        revision > parseRevision(throughRevision)
      ) {
        throw new Error('Sync enclave returned out-of-order revision events')
      }
      lastRevision = revision
      if (event.kind === 'upsert') {
        pendingUpserts.push(event)
        continue
      }
      await flushUpserts()
      ensureCurrent(isCurrent)
      const deleted = await indexedDBStorage.applyRemoteDeletion(
        event.id,
        userId,
        isCurrent,
      )
      deletedChatsTracker.markAsRemoteDeleted(event.id)
      clearTombstoneIds.delete(event.id)
      committedStates.push(toRemoteState(event, event.revision, 'delete'))
      if (deleted) chatEvents.emit({ reason: 'sync', ids: [event.id] })
    }
    cursor = page.next_cursor
  } while (cursor)
  await flushUpserts()
  ensureCurrent(isCurrent)
  await indexedDBStorage.commitRevisionBatch(
    committedStates,
    throughRevision,
    userId,
  )
  const restoredIds: string[] = []
  for (const state of committedStates) {
    if (
      state.kind === 'upsert' &&
      clearTombstoneIds.has(state.id) &&
      deletedChatsTracker.removeRemoteDeletion(state.id)
    ) {
      restoredIds.push(state.id)
    }
  }
  if (restoredIds.length > 0) {
    chatEvents.emit({ reason: 'sync', ids: restoredIds })
  }
  return downloaded
}

async function uploadPendingWork(
  adapter: RevisionUploadAdapter,
  userId: string,
  isCurrent: () => boolean,
): Promise<{ uploaded: number; errors: string[] }> {
  const errors: string[] = []
  const deletes = await indexedDBStorage.getPendingDeletes(userId)
  ensureCurrent(isCurrent)
  for (const entry of deletes) {
    try {
      await adapter.waitForUpload(entry.id)
      ensureCurrent(isCurrent)
      await cloudStorage.deleteChat(entry.id, entry.idempotencyKey)
      ensureCurrent(isCurrent)
      await indexedDBStorage.acknowledgePendingDelete(entry.id, userId)
    } catch (error) {
      // A failing delete keeps its intent queued for the next cycle
      // but must not starve the remaining deletes or the uploads
      // below — except when the account changed, which invalidates
      // the whole drain.
      if (!isCurrent()) throw error
      errors.push(
        `Failed to delete chat ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  let uploaded = 0
  const chats = await indexedDBStorage.getPendingUploadChats(userId)
  ensureCurrent(isCurrent)
  for (const chat of chats) {
    if (!isUploadableChat(chat, (id) => adapter.isStreaming(id))) continue
    try {
      await adapter.upload(chat)
      ensureCurrent(isCurrent)
      uploaded++
    } catch (error) {
      // Same policy as deletes: one failing chat stays pending for
      // the next cycle without starving the rest of the queue.
      if (!isCurrent()) throw error
      errors.push(
        `Failed to upload chat ${chat.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return { uploaded, errors }
}

export async function drainChatRevisionSync(
  adapter: RevisionUploadAdapter,
  userId: string,
  isCurrent: () => boolean = () => true,
): Promise<RevisionSyncResult> {
  const result: RevisionSyncResult = { uploaded: 0, downloaded: 0, errors: [] }
  const state = await indexedDBStorage.getSyncState(userId)
  const [pending, summary] = await Promise.all([
    indexedDBStorage.hasPendingSyncWork(userId),
    revisionSummary(),
  ])
  ensureCurrent(isCurrent)
  const current = parseRevision(summary.current_revision)
  const oldest = parseRevision(summary.oldest_replayable_revision)

  let appliedRevision = state?.appliedRevision ?? null
  if (
    !state?.bootstrapped ||
    appliedRevision === null ||
    parseRevision(appliedRevision) < oldest ||
    parseRevision(appliedRevision) > current
  ) {
    const bootstrap = await bootstrapFromSnapshot(userId, isCurrent)
    result.downloaded += bootstrap.downloaded
    appliedRevision = bootstrap.revision
  }

  if (parseRevision(appliedRevision) === current && !pending) return result
  if (parseRevision(appliedRevision) < current) {
    result.downloaded += await applyEvents(
      appliedRevision,
      summary.current_revision,
      userId,
      isCurrent,
    )
  }
  const work = await uploadPendingWork(adapter, userId, isCurrent)
  result.uploaded = work.uploaded
  result.errors.push(...work.errors)
  return result
}
