/**
 * Safeguards store: the signed-in user's flagged chats as reported by the
 * controlplane, plus the thresholds that govern an account ban.
 *
 * Fetched once per signed-in session and refreshed on demand from the
 * Safeguards settings page. Framework-free singleton with a
 * `subscribe`/`getSnapshot` surface so React consumers can use
 * `useSyncExternalStore`, mirroring the sync-health store.
 */

import { API_BASE_URL, IS_DEV } from '@/config'
import { AuthTokenUnavailableError, authTokenManager } from '@/services/auth'
import { logError } from '@/utils/error-handling'

export const SAFEGUARDS_INFO_URL = 'https://tinfoil.sh/safety-and-safeguards'

export interface FlaggedChat {
  id: string
  conversationId: string
  createdAt: number
}

export interface SafeguardsSnapshot {
  flaggedChats: readonly FlaggedChat[]
  /** conversationId -> true, for O(1) sidebar lookups. */
  flaggedChatIds: Readonly<Record<string, true>>
  /** Flags inside the rolling window that count toward a ban. */
  inWindow: number
  windowHours: number
  warnThreshold: number
  banThreshold: number
  status: 'idle' | 'loading' | 'ready' | 'error'
}

interface ViolationsResponse {
  violations: Array<{ id: string; conversation_id: string; created_at: string }>
  in_window: number
  window_hours: number
  warn_threshold: number
  ban_threshold: number
}

const EMPTY_SNAPSHOT: SafeguardsSnapshot = {
  flaggedChats: [],
  flaggedChatIds: {},
  inWindow: 0,
  windowHours: 7 * 24,
  warnThreshold: 8,
  banThreshold: 10,
  status: 'idle',
}

// Placeholder data so the Safeguards page can be exercised locally without
// a flagged account. One flag is outside the counting window on purpose.
const DEV_PLACEHOLDER_VIOLATIONS: ViolationsResponse = {
  violations: [
    {
      id: 'dev-flag-1',
      conversation_id: 'dev-flagged-chat-1',
      created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'dev-flag-2',
      conversation_id: 'dev-flagged-chat-2',
      created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'dev-flag-3',
      conversation_id: 'dev-flagged-chat-3',
      created_at: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ],
  in_window: 2,
  window_hours: 7 * 24,
  warn_threshold: 8,
  ban_threshold: 10,
}

type Listener = () => void

let snapshot: SafeguardsSnapshot = EMPTY_SNAPSHOT
const listeners = new Set<Listener>()
let inflight: Promise<void> | null = null

function publish(next: SafeguardsSnapshot): void {
  snapshot = next
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeSafeguards(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getSafeguardsSnapshot(): SafeguardsSnapshot {
  return snapshot
}

export function getSafeguardsServerSnapshot(): SafeguardsSnapshot {
  return EMPTY_SNAPSHOT
}

function toSnapshot(
  data: ViolationsResponse,
  status: SafeguardsSnapshot['status'],
): SafeguardsSnapshot {
  const flaggedChats = data.violations.map((v) => ({
    id: v.id,
    conversationId: v.conversation_id,
    createdAt: Date.parse(v.created_at),
  }))
  const flaggedChatIds: Record<string, true> = {}
  for (const chat of flaggedChats) {
    if (chat.conversationId) flaggedChatIds[chat.conversationId] = true
  }
  return {
    flaggedChats,
    flaggedChatIds,
    inWindow: data.in_window,
    windowHours: data.window_hours,
    warnThreshold: data.warn_threshold,
    banThreshold: data.ban_threshold,
    status,
  }
}

async function fetchViolations(): Promise<ViolationsResponse> {
  const response = await fetch(`${API_BASE_URL}/api/users/me/aup-violations`, {
    headers: await authTokenManager.getAuthHeaders(),
  })
  if (!response.ok) {
    throw new Error(`Failed to load flagged chats: ${response.status}`)
  }
  return (await response.json()) as ViolationsResponse
}

/**
 * Loads the signed-in user's flagged chats. Concurrent calls share one
 * request. Errors are logged and surfaced through `status` rather than
 * thrown, since callers only render from the snapshot.
 */
export function refreshSafeguards(): Promise<void> {
  if (inflight) return inflight
  publish({ ...snapshot, status: 'loading' })
  inflight = (async () => {
    try {
      const data = IS_DEV ? DEV_PLACEHOLDER_VIOLATIONS : await fetchViolations()
      publish(toSnapshot(data, 'ready'))
    } catch (err) {
      if (!(err instanceof AuthTokenUnavailableError)) {
        logError('Failed to load flagged chats', err, {
          component: 'safeguards',
        })
      }
      publish({ ...snapshot, status: 'error' })
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** Drops all loaded data, e.g. on sign-out or account switch. */
export function resetSafeguards(): void {
  publish(EMPTY_SNAPSHOT)
}
