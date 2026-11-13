import { logError } from '@tinfoil/chat-client/logging'
import { createContext, useContext, useEffect, useState } from 'react'
import type { TaskStore } from './storage'

// The pictures this device keeps of the page as a chat's browser actions saw
// it, as image sources by the id of the tool call each answered.
export type Captures = ReadonlyMap<string, string>

const JPEG_SOURCE_PREFIX = 'data:image/jpeg;base64,'
const NONE: Captures = new Map()
const CapturesContext = createContext<Captures>(NONE)

export const CapturesProvider = CapturesContext.Provider
export const useCaptures = () => useContext(CapturesContext)

// Reads the pictures kept of a chat's browser actions as the chat comes to
// list them, each of them once.
export function useStoredCaptures(
  store: Pick<TaskStore, 'capture'>,
  owner: string,
  taskId: string | undefined,
  toolCallIds: readonly string[],
): Captures {
  const [read, setRead] = useState<{ chat: string; captures: Captures }>()
  const chat =
    taskId === undefined ? undefined : JSON.stringify([owner, taskId])
  const captures = read && read.chat === chat ? read.captures : NONE
  const missing = JSON.stringify(
    toolCallIds.filter((toolCallId) => !captures.has(toolCallId)),
  )
  useEffect(() => {
    const wanted: string[] = JSON.parse(missing)
    if (taskId === undefined || chat === undefined || wanted.length === 0)
      return
    let current = true
    Promise.all(
      wanted.map(
        async (toolCallId) =>
          [toolCallId, await store.capture(owner, taskId, toolCallId)] as const,
      ),
    )
      .then((found) => {
        if (!current) return
        setRead((before) => {
          const next = new Map(before?.chat === chat ? before.captures : [])
          for (const [toolCallId, image] of found)
            if (image) next.set(toolCallId, JPEG_SOURCE_PREFIX + image)
          return { chat, captures: next }
        })
      })
      .catch((cause) => logError('Unable to read a kept capture', cause))
    return () => {
      current = false
    }
  }, [store, owner, taskId, chat, missing])
  return captures
}
