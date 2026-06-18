import { streamingTracker } from '@/services/cloud/streaming-tracker'
import { useSyncExternalStore } from 'react'

/**
 * Subscribe to the set of chat ids that currently have an in-flight
 * assistant stream. Re-renders only when a stream starts or ends.
 *
 * Backed by the app-wide `streamingTracker`, so any component can show a
 * live "streaming" indicator without threading props through the tree.
 */
export function useStreamingChats(): ReadonlySet<string> {
  return useSyncExternalStore(
    streamingTracker.subscribe,
    streamingTracker.getSnapshot,
    streamingTracker.getSnapshot,
  )
}
