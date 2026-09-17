/**
 * Safeguards store: the signed-in user's flagged chats as reported by the
 * controlplane, plus the thresholds that govern an account suspension.
 *
 * Fetched once per signed-in session and refreshed on demand from the
 * Safeguards settings page. Framework-free singleton with a
 * `subscribe`/`getSnapshot` surface so React consumers can use
 * `useSyncExternalStore`, mirroring the sync-health store.
 */

import { API_BASE_URL, IS_DEV } from '@/config'
import { AuthTokenUnavailableError, authTokenManager } from '@/services/auth'
import { logError } from '@/utils/error-handling'
import { z } from 'zod'

export const SAFEGUARDS_INFO_URL = 'https://tinfoil.sh/safety-and-safeguards'

export interface FlaggedChat {
  id: string
  conversationId: string
  createdAt: number
}

/** The suspension policy as reported by the controlplane. */
export interface SafeguardsPolicy {
  /** Flags inside the rolling window that count toward a suspension. */
  inWindow: number
  windowHours: number
  warnThreshold: number
  banThreshold: number
}

export interface SafeguardsSnapshot {
  flaggedChats: readonly FlaggedChat[]
  /** conversationId -> true, for O(1) sidebar lookups. */
  flaggedChatIds: Readonly<Record<string, true>>
  /** Null until a response has been received, so the UI never presents a
   * guessed policy as the active one. */
  policy: SafeguardsPolicy | null
  status: 'idle' | 'loading' | 'ready' | 'error'
}

const FlagsResponseSchema = z.object({
  flags: z.array(
    z.object({
      id: z.string(),
      conversation_id: z.string(),
      created_at: z.string(),
    }),
  ),
  in_window: z.number().int().nonnegative(),
  window_hours: z.number().int().positive(),
  warn_threshold: z.number().int().nonnegative(),
  ban_threshold: z.number().int().positive(),
})

type FlagsResponse = z.infer<typeof FlagsResponseSchema>

const EMPTY_SNAPSHOT: SafeguardsSnapshot = {
  flaggedChats: [],
  flaggedChatIds: {},
  policy: null,
  status: 'idle',
}

// Placeholder data so the Safeguards page can be exercised locally without
// a flagged account. One flag is outside the counting window on purpose.
const DEV_PLACEHOLDER_FLAGS: FlagsResponse = {
  flags: [
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
// Bumped by reset so a response from before the reset is discarded rather
// than published for the next account.
let generation = 0

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
  data: FlagsResponse,
  status: SafeguardsSnapshot['status'],
): SafeguardsSnapshot {
  const flaggedChats = data.flags.map((v) => ({
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
    policy: {
      inWindow: data.in_window,
      windowHours: data.window_hours,
      warnThreshold: data.warn_threshold,
      banThreshold: data.ban_threshold,
    },
    status,
  }
}

async function fetchFlags(): Promise<FlagsResponse> {
  const response = await fetch(`${API_BASE_URL}/api/users/me/safeguard-flags`, {
    headers: await authTokenManager.getAuthHeaders(),
  })
  if (!response.ok) {
    throw new Error(`Failed to load flagged chats: ${response.status}`)
  }
  return FlagsResponseSchema.parse(await response.json())
}

/**
 * Loads the signed-in user's flagged chats. Concurrent calls share one
 * request. Errors are logged and surfaced through `status` rather than
 * thrown, since callers only render from the snapshot.
 */
export function refreshSafeguards(): Promise<void> {
  if (inflight) return inflight
  const requestGeneration = generation
  publish({ ...snapshot, status: 'loading' })
  const request = (async () => {
    try {
      const data = IS_DEV ? DEV_PLACEHOLDER_FLAGS : await fetchFlags()
      if (requestGeneration !== generation) return
      publish(toSnapshot(data, 'ready'))
    } catch (err) {
      if (!(err instanceof AuthTokenUnavailableError)) {
        logError('Failed to load flagged chats', err, {
          component: 'safeguards',
        })
      }
      if (requestGeneration !== generation) return
      publish({ ...snapshot, status: 'error' })
    } finally {
      // A reset may have already cleared inflight and a newer request may
      // own it; only release it if it is still this one.
      if (requestGeneration === generation) inflight = null
    }
  })()
  inflight = request
  return request
}

/** Drops all loaded data, e.g. on sign-out or account switch. Any request
 * still in flight is orphaned and its result discarded. */
export function resetSafeguards(): void {
  generation += 1
  inflight = null
  publish(EMPTY_SNAPSHOT)
}
