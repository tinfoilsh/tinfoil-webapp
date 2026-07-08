/**
 * Encrypted chat search over the sync enclave.
 *
 * The enclave keeps a per-user search index sealed under a key derived
 * from the CEK, so queries need the primary key on every call. Results
 * are chat ids + scores only; `resolveSearchResultChats` maps them back
 * to locally stored chats (falling back to a pull for chats outside the
 * loaded pages).
 *
 * When the enclave reports `needs_reindex` (index never built, sealed
 * under a different key, or embedding model changed) this module kicks
 * the background rebuild automatically and exposes the in-flight job as
 * a promise so callers can re-query once it settles.
 */

import { logError, logInfo } from '@/utils/error-handling'
import { chatStorage } from '../storage/chat-storage'
import {
  pull,
  searchQuery,
  searchReindex,
  searchReindexStatus,
  SyncEnclaveError,
  type SearchQueryResult,
  type SearchReindexStatus,
} from '../sync-enclave/sync-api'
import { hasPrimaryKey, pullKey, requirePrimaryKeyB64 } from './cek-encoding'
import { processRemoteChat } from './chat-codec'

export const SEARCH_REINDEX_POLL_INTERVAL_MS = 2_000
export const SEARCH_REINDEX_POLL_BUDGET_MS = 10 * 60 * 1_000
export const SEARCH_REINDEX_FAILURE_COOLDOWN_MS = 60_000

/**
 * How a reindex request settled. `skipped` means no kick was sent
 * (no keys loaded, or a recent failure put kicks on cooldown);
 * `timeout` means the poll budget ran out while the job was still
 * running server-side.
 */
export type ReindexSettleResult = 'completed' | 'failed' | 'timeout' | 'skipped'

export interface ChatSearchOutcome {
  results: SearchQueryResult[]
  totalIndexed: number
  /**
   * True when the enclave has no complete index for this key yet and a
   * rebuild has been kicked; results may be partial until it settles.
   */
  indexing: boolean
  /**
   * False when search cannot run at all: no primary key loaded, or the
   * enclave has no search backend (older deploy / unconfigured). The
   * UI should fall back to local title filtering.
   */
  available: boolean
}

function unavailableOutcome(): ChatSearchOutcome {
  return { results: [], totalIndexed: 0, indexing: false, available: false }
}

/**
 * The enclave answers 503 when the search backend is not configured;
 * an older enclave without the routes answers 404/405. Both mean
 * "no server-side search here", not a transient failure.
 */
export function isSearchUnavailableError(err: unknown): boolean {
  return (
    err instanceof SyncEnclaveError &&
    (err.status === 503 || err.status === 404 || err.status === 405)
  )
}

/**
 * Rank synced chats against a query using the caller's primary CEK.
 * Kicks a background reindex (once per settled job) when the enclave
 * reports the index is missing or incomplete.
 */
export async function searchSyncedChats(
  query: string,
  limit?: number,
): Promise<ChatSearchOutcome> {
  if (!hasPrimaryKey()) return unavailableOutcome()
  let resp
  try {
    resp = await searchQuery({ keyB64: requirePrimaryKeyB64(), query, limit })
  } catch (err) {
    if (isSearchUnavailableError(err)) return unavailableOutcome()
    throw err
  }
  const indexing = resp.needs_reindex === true
  if (indexing) {
    void ensureSearchIndex()
  }
  return {
    results: resp.results,
    totalIndexed: resp.total_indexed,
    indexing,
    available: true,
  }
}

let reindexInFlight: Promise<ReindexSettleResult> | null = null
let lastReindexFailureAt = 0

/**
 * Kick (or join) the enclave-side index rebuild and resolve with how
 * it settled. Concurrent callers share one poll loop; the enclave
 * itself dedupes kickoffs for the same key set, so an extra kick
 * after a settle is harmless. A failed run puts further kicks on a
 * cooldown: the enclave allows an immediate re-kick after a failure,
 * and every attempt re-pulls and re-embeds chats, so retrying on each
 * query would loop a persistent failure at full rebuild cost. Never
 * rejects: failures are logged and resolve as `failed` so
 * fire-and-forget call sites cannot leak unhandled rejections.
 */
export function ensureSearchIndex(): Promise<ReindexSettleResult> {
  if (!reindexInFlight) {
    if (
      Date.now() - lastReindexFailureAt <
      SEARCH_REINDEX_FAILURE_COOLDOWN_MS
    ) {
      return Promise.resolve('skipped')
    }
    reindexInFlight = runReindex()
      .catch((err): ReindexSettleResult => {
        logError('search reindex failed', err, {
          component: 'chat-search',
          action: 'ensureSearchIndex',
        })
        return 'failed'
      })
      .then((result) => {
        if (result === 'failed') {
          lastReindexFailureAt = Date.now()
        } else if (result === 'completed') {
          lastReindexFailureAt = 0
        }
        return result
      })
      .finally(() => {
        reindexInFlight = null
      })
  }
  return reindexInFlight
}

function isTerminalStatus(status: SearchReindexStatus): boolean {
  return status !== 'running'
}

function settleResult(status: SearchReindexStatus): ReindexSettleResult {
  return status === 'completed' ? 'completed' : 'failed'
}

async function runReindex(): Promise<ReindexSettleResult> {
  const keys = pullKey()
  if (keys.length === 0) return 'skipped'
  const kicked = await searchReindex(keys)
  logInfo('search reindex kicked', {
    component: 'chat-search',
    action: 'runReindex',
    metadata: { jobId: kicked.job_id, status: kicked.status },
  })
  if (isTerminalStatus(kicked.status)) return settleResult(kicked.status)
  const deadline = Date.now() + SEARCH_REINDEX_POLL_BUDGET_MS
  while (Date.now() < deadline) {
    await sleep(SEARCH_REINDEX_POLL_INTERVAL_MS)
    const status = await searchReindexStatus()
    if (isTerminalStatus(status.status)) {
      logInfo('search reindex settled', {
        component: 'chat-search',
        action: 'runReindex',
        metadata: {
          jobId: status.job_id,
          status: status.status,
          indexed: status.indexed,
          failed: status.failed,
          partial: status.partial,
        },
      })
      return settleResult(status.status)
    }
  }
  return 'timeout'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Display data for one search hit, ready for the sidebar chat list. */
export interface SearchResultChat {
  id: string
  title: string
  updatedAt?: string
  messageCount: number
}

/**
 * Resolve search result ids to chat display data, preserving the
 * enclave's ranking. Local storage is the fast path; anything not on
 * this device yet (results can reach past the loaded sidebar pages) is
 * pulled and decoded without being written back. Unresolvable ids
 * (e.g. a chat deleted between indexing and the query) are dropped.
 */
export async function resolveSearchResultChats(
  results: SearchQueryResult[],
): Promise<SearchResultChat[]> {
  const byId = new Map<string, SearchResultChat>()
  const missing: string[] = []
  for (const r of results) {
    const local = await chatStorage.getChat(r.id)
    if (local) {
      byId.set(r.id, {
        id: local.id,
        title: local.title,
        updatedAt: local.updatedAt,
        messageCount: local.messages.length,
      })
    } else {
      missing.push(r.id)
    }
  }
  if (missing.length > 0 && hasPrimaryKey()) {
    try {
      const resp = await pull({ scope: 'chat', ids: missing, keys: pullKey() })
      for (const item of resp.items) {
        if (!item.ok || item.plaintext == null) continue
        try {
          const { chat } = await processRemoteChat({
            id: item.id,
            plaintext: item.plaintext,
          })
          byId.set(item.id, {
            id: chat.id,
            title: chat.title,
            updatedAt: chat.updatedAt,
            messageCount: chat.messages.length,
          })
        } catch (err) {
          logError('search result chat decode failed', err, {
            component: 'chat-search',
            action: 'resolveSearchResultChats',
            metadata: { chatId: item.id },
          })
        }
      }
    } catch (err) {
      logError('search result pull failed', err, {
        component: 'chat-search',
        action: 'resolveSearchResultChats',
        metadata: { count: missing.length },
      })
    }
  }
  const chats: SearchResultChat[] = []
  for (const r of results) {
    const chat = byId.get(r.id)
    if (chat) chats.push(chat)
  }
  return chats
}
