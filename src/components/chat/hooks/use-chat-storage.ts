import { useToast } from '@/hooks/use-toast'
import { cloudStorage } from '@/services/cloud/cloud-storage'
import { streamingTracker } from '@/services/cloud/streaming-tracker'
import { isChatRecoveryTurnCancelled } from '@/services/inference/chat-recovery'
import { sameRecoveredResponse } from '@/services/inference/chat-recovery-sync'
import { chatEvents } from '@/services/storage/chat-events'
import { chatStorage } from '@/services/storage/chat-storage'
import { deletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import { indexedDBStorage } from '@/services/storage/indexed-db'
import { samePendingRecoveryEnvelope } from '@/types/chat-recovery'
import { logError, logInfo } from '@/utils/error-handling'
import { useAuth } from '@clerk/nextjs'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { BLANK_LOCAL_QUEUE_ID, isBlankQueueId } from '../message-queue-identity'
import { readDefaultPresetId } from '../prompts/default-preset'
import type { Chat, PendingRecoveryEnvelope } from '../types'
import {
  createBlankChat,
  deleteChat as deleteChatFromStorage,
  ensureAtLeastOneChat,
  getBlankChat,
  loadChats,
  sortChats,
} from './chat-operations'
import { ChatPersistenceManager } from './chat-persistence-manager'
import { useChatCollection } from './use-chat-collection'

const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect

interface UseChatStorageProps {
  storeHistory: boolean
  scrollToBottom?: () => void
  initialChatId?: string | null
  isLocalChatUrl?: boolean
  initialNewChatIsLocalOnly?: boolean
}

interface UseChatStorageReturn {
  chats: Chat[]
  currentChat: Chat
  setChats: React.Dispatch<React.SetStateAction<Chat[]>>
  setCurrentChat: React.Dispatch<React.SetStateAction<Chat>>
  createNewChat: (isLocalOnly?: boolean, fromUserAction?: boolean) => void
  deleteChat: (chatId: string) => void
  updateChatTitle: (chatId: string, newTitle: string) => void
  updateChatModel: (model: string) => void
  switchChat: (chat: Chat) => void
  handleChatSelect: (chatId: string) => void
  loadChatById: (chatId: string, isLocalUrl: boolean) => Promise<void>
  setIsInitialLoad: (loading: boolean) => void
  isInitialLoad: boolean
  isChatHydrating: boolean
  reloadChats: () => Promise<void>
  initialChatDecryptionFailed: boolean
  clearInitialChatDecryptionFailed: () => void
  localChatNotFound: boolean
  initialChatLoadFailed: boolean
  cloudChatNotFound: boolean
  retryInitialChatLoad: () => void
}

function pendingRecoveriesMatch(
  left: readonly PendingRecoveryEnvelope[] = [],
  right: readonly PendingRecoveryEnvelope[] = [],
): boolean {
  return (
    left.length === right.length &&
    left.every((envelope, index) =>
      right[index]
        ? samePendingRecoveryEnvelope(envelope, right[index])
        : false,
    )
  )
}

/**
 * Drop envelopes for turns the user explicitly stopped. An envelope can
 * land in storage in the window between the stop press and the async
 * envelope removal completing; adopting it into the on-screen chat would
 * flash "Recovering stream..." for a turn that is not coming back.
 */
function withoutCancelledRecoveries(
  chatId: string,
  envelopes: readonly PendingRecoveryEnvelope[] | undefined,
): PendingRecoveryEnvelope[] | undefined {
  if (!envelopes?.length) return undefined
  const remaining = envelopes.filter(
    (envelope) => !isChatRecoveryTurnCancelled(chatId, envelope.turnId),
  )
  return remaining.length > 0 ? remaining : undefined
}

function pendingTitleFields(chat: Chat, isPending: boolean): Partial<Chat> {
  return isPending
    ? {
        title: chat.title,
        titleState: chat.titleState,
        updatedAt: chat.updatedAt,
      }
    : {}
}

export function useChatStorage({
  storeHistory,
  initialChatId,
  isLocalChatUrl = false,
  initialNewChatIsLocalOnly = false,
}: UseChatStorageProps): UseChatStorageReturn {
  const { isSignedIn, userId } = useAuth()
  const { toast } = useToast()
  const [isInitialLoad, setIsInitialLoad] = useState(true)
  const [hydratingChatId, setHydratingChatId] = useState<string | null>(null)
  const initialChatLoadedRef = useRef(false)
  const reloadGenerationRef = useRef(0)
  const pendingRecoveryReloadIdsRef = useRef(new Set<string>())
  const [initialChatDecryptionFailed, setInitialChatDecryptionFailed] =
    useState(false)
  const [localChatNotFound, setLocalChatNotFound] = useState(false)
  const [initialChatLoadFailed, setInitialChatLoadFailed] = useState(false)
  const [cloudChatNotFound, setCloudChatNotFound] = useState(false)

  // Initialize with blank chats for both modes
  const { chats, currentChat, setChats, setCurrentChat, setChatCollection } =
    useChatCollection(() => {
      const initialChats = [createBlankChat(false), createBlankChat(true)]
      return {
        chats: initialChats,
        currentChat:
          getBlankChat(initialChats, initialNewChatIsLocalOnly) ??
          initialChats[0],
      }
    })
  const currentChatRef = useRef(currentChat)
  currentChatRef.current = currentChat
  const chatsRef = useRef(chats)
  chatsRef.current = chats
  const selectionRequestRef = useRef(0)
  const selectionFallbackRef = useRef<Chat | null>(null)
  const titleSaveSequenceRef = useRef(0)
  const titleSaveGenerationRef = useRef(new Map<string, number>())
  const accountKey = `${!!isSignedIn}:${userId ?? ''}`
  const previousAccountKeyRef = useRef(accountKey)
  const committedAccountKeyRef = useRef(accountKey)
  const accountGenerationRef = useRef(0)
  useIsomorphicLayoutEffect(() => {
    if (previousAccountKeyRef.current !== accountKey) {
      previousAccountKeyRef.current = accountKey
      accountGenerationRef.current += 1
    }
    committedAccountKeyRef.current = accountKey
  }, [accountKey])
  const initialLoadAccountKeyRef = useRef(accountKey)

  // Create persistence manager
  const persistenceManager = useMemo(
    () =>
      new ChatPersistenceManager(
        !!isSignedIn,
        accountKey,
        () => committedAccountKeyRef.current,
      ),
    [isSignedIn, accountKey],
  )

  // Update persistence manager when auth changes
  useEffect(() => {
    persistenceManager.setSignedIn(!!isSignedIn)
  }, [isSignedIn, persistenceManager])

  // Cleanup on unmount
  useIsomorphicLayoutEffect(() => {
    persistenceManager.activate()
    return () => {
      persistenceManager.cleanup()
    }
  }, [persistenceManager])

  // Load chats from storage
  const reloadChats = useCallback(
    async (recoveryIds?: readonly string[]) => {
      if (typeof window === 'undefined') return

      recoveryIds?.forEach((id) => pendingRecoveryReloadIdsRef.current.add(id))
      const reloadGeneration = ++reloadGenerationRef.current
      const reloadAccountGeneration = accountGenerationRef.current
      try {
        const current = currentChatRef.current
        const needsFullReload =
          !!recoveryIds?.length ||
          (!current.isBlankChat && !!current.pendingRecoveries?.length)
        const loadedChats = await loadChats(
          storeHistory && !!isSignedIn,
          !needsFullReload,
        )
        if (
          reloadGeneration !== reloadGenerationRef.current ||
          reloadAccountGeneration !== accountGenerationRef.current
        ) {
          return
        }
        const currentSummary = loadedChats.find(
          (chat) => chat.id === current.id,
        )
        const currentContentChanged =
          !current.isBlankChat &&
          !current.isMetadataOnly &&
          !current.pendingSave &&
          !streamingTracker.isStreamingOrPending(current.id) &&
          currentSummary !== undefined &&
          currentSummary.updatedAt !== undefined &&
          (current.updatedAt === undefined ||
            currentSummary.updatedAt > current.updatedAt)
        const refreshedCurrentChat = currentContentChanged
          ? currentSummary.isMetadataOnly
            ? await chatStorage.getChat(current.id)
            : currentSummary
          : null
        if (
          reloadGeneration !== reloadGenerationRef.current ||
          reloadAccountGeneration !== accountGenerationRef.current
        ) {
          return
        }
        const pendingRecoveryIds = [...pendingRecoveryReloadIdsRef.current]
        pendingRecoveryReloadIdsRef.current.clear()

        setChatCollection((previous) => {
          if (
            reloadGeneration !== reloadGenerationRef.current ||
            reloadAccountGeneration !== accountGenerationRef.current
          ) {
            return previous
          }
          const { chats: prevChats, currentChat: prev } = previous
          // Always ensure we have blank chats for both modes
          const cloudBlank =
            getBlankChat(prevChats, false) || createBlankChat(false)
          const localBlank =
            getBlankChat(prevChats, true) || createBlankChat(true)

          // Merge loaded chats with state (excluding blank chats). Re-check the
          // deleted tracker at apply-time: a chat can be deleted after this
          // reload's loadChats() snapshot resolved but before this setChats runs.
          // Without this re-filter, an in-flight reload would resurrect a chat
          // the user just deleted until the next page refresh.
          // Cancelled recoveries are stripped here too, not just on
          // currentChat: switching to a chat adopts its entry from this
          // list, which must not reintroduce a stopped turn's envelope.
          const previousById = new Map(prevChats.map((chat) => [chat.id, chat]))
          const nonBlankChats = loadedChats
            .filter(
              (c) => !c.isBlankChat && !deletedChatsTracker.isDeleted(c.id),
            )
            .map((c) => {
              const existing = previousById.get(c.id)
              let chat = c
              const hasPendingTitle =
                existing !== undefined &&
                (existing.pendingSave === true ||
                  titleSaveGenerationRef.current.has(c.id))
              if (c.isMetadataOnly && existing && !existing.isMetadataOnly) {
                // A hydrated copy keeps its messages only while it still
                // mirrors storage. When the stored chat has newer content
                // (another device, a background write), fall back to the
                // summary so the next selection rehydrates instead of
                // pinning stale messages. Streaming chats and sends in
                // their pre-save window are ahead of storage, so they
                // always keep their in-memory messages.
                const hydratedMatchesStorage =
                  existing.updatedAt === c.updatedAt &&
                  existing.messages.length === (c.messageCount ?? 0)
                if (
                  hydratedMatchesStorage ||
                  existing.pendingSave === true ||
                  titleSaveGenerationRef.current.has(c.id) ||
                  streamingTracker.isStreamingOrPending(c.id)
                ) {
                  chat = {
                    ...existing,
                    ...c,
                    ...pendingTitleFields(existing, hasPendingTitle),
                    messages: existing.messages,
                    isMetadataOnly: false,
                  }
                }
              } else if (existing && hasPendingTitle) {
                chat = existing.pendingSave
                  ? { ...c, ...existing }
                  : {
                      ...c,
                      ...pendingTitleFields(existing, hasPendingTitle),
                    }
              }
              return chat.pendingRecoveries?.length
                ? {
                    ...chat,
                    pendingRecoveries: withoutCancelledRecoveries(
                      chat.id,
                      chat.pendingRecoveries,
                    ),
                  }
                : chat
            })

          // Combine blank chats with loaded chats and sort
          const finalChats = sortChats([
            cloudBlank,
            localBlank,
            ...nonBlankChats,
          ])

          // Update current chat metadata only - NEVER switch to a different chat.
          // Chat switching should only happen through explicit user actions.
          // This prevents race conditions in Safari PWA where timing differences
          // could cause unexpected chat resets.
          let nextCurrent = prev
          if (!prev.isBlankChat) {
            // Only update metadata (syncedAt, title) if the same chat exists in storage
            const existingChat = nonBlankChats.find((c) => c.id === prev.id)
            if (existingChat) {
              const storedRecoveries = withoutCancelledRecoveries(
                prev.id,
                existingChat.pendingRecoveries,
              )
              // Include sends still in their pre-stream phase: a recovery
              // reload racing a just-resumed generation must not adopt the
              // stored copy over the messages the new stream is about to write.
              const isStreaming = streamingTracker.isStreamingOrPending(prev.id)
              const isRecoveryReload = pendingRecoveryIds.includes(prev.id)
              const hasPendingTitle =
                prev.pendingSave || titleSaveGenerationRef.current.has(prev.id)
              const pendingCurrentTitle = pendingTitleFields(
                prev,
                hasPendingTitle,
              )
              const existingMessageCount = existingChat.isMetadataOnly
                ? (existingChat.messageCount ?? 0)
                : existingChat.messages.length
              const canAdoptRefreshedCurrent =
                refreshedCurrentChat !== null &&
                prev === current &&
                !isStreaming &&
                refreshedCurrentChat.updatedAt === existingChat.updatedAt &&
                refreshedCurrentChat.messages.length === existingMessageCount
              if (canAdoptRefreshedCurrent) {
                nextCurrent = {
                  ...prev,
                  ...refreshedCurrentChat,
                  ...pendingCurrentTitle,
                  pendingRecoveries: storedRecoveries,
                  pendingSave: prev.pendingSave,
                }
              } else if (isRecoveryReload && isStreaming) {
                nextCurrent = {
                  ...prev,
                  pendingRecoveries: storedRecoveries,
                }
              } else {
                // A turn this view still tracks as pending recovery may have been
                // completed elsewhere (another device, or a background scan) and
                // reached storage through a plain sync. Metadata-only merging
                // would clear the indicator but keep the stale on-screen
                // messages, so adopt the stored chat that carries the recovered
                // response.
                const recoveryResolvedElsewhere = (
                  prev.pendingRecoveries ?? []
                ).some(
                  (envelope) =>
                    !existingChat.pendingRecoveries?.some(
                      (candidate) => candidate.turnId === envelope.turnId,
                    ) &&
                    existingChat.messages.some((message) => {
                      if (
                        message.role !== 'assistant' ||
                        message.turnId !== envelope.turnId
                      ) {
                        return false
                      }
                      const currentResponse = prev.messages.find(
                        (candidate) =>
                          candidate.role === 'assistant' &&
                          candidate.turnId === envelope.turnId,
                      )
                      return (
                        currentResponse === undefined ||
                        !sameRecoveredResponse(currentResponse, message)
                      )
                    }),
                )
                if (
                  (isRecoveryReload || recoveryResolvedElsewhere) &&
                  !isStreaming &&
                  // A summary entry has no messages to adopt; keep the
                  // on-screen copy and only update its metadata below.
                  !existingChat.isMetadataOnly
                ) {
                  nextCurrent = {
                    ...existingChat,
                    ...pendingCurrentTitle,
                    pendingRecoveries: storedRecoveries,
                    pendingSave: prev.pendingSave,
                  }
                } else if (
                  prev.syncedAt !== existingChat.syncedAt ||
                  prev.title !== existingChat.title ||
                  prev.presetId !== existingChat.presetId ||
                  !pendingRecoveriesMatch(
                    prev.pendingRecoveries,
                    storedRecoveries,
                  )
                ) {
                  nextCurrent = {
                    ...prev,
                    syncedAt: existingChat.syncedAt,
                    title: hasPendingTitle ? prev.title : existingChat.title,
                    presetId: existingChat.presetId,
                    pendingRecoveries: storedRecoveries,
                  }
                }
              }

              if (
                nextCurrent.isLocalOnly !== existingChat.isLocalOnly ||
                nextCurrent.projectId !== existingChat.projectId
              ) {
                nextCurrent = {
                  ...nextCurrent,
                  isLocalOnly: existingChat.isLocalOnly,
                  projectId: existingChat.projectId,
                }
              }
            }
          }

          return { chats: finalChats, currentChat: nextCurrent }
        })
      } catch (error) {
        logError('Failed to reload chats', error, {
          component: 'useChatStorage',
        })
      }
    },
    [storeHistory, isSignedIn, setChatCollection],
  )

  // Listen for chat events (cloud sync, pagination, etc.)
  useEffect(() => {
    const cleanup = chatEvents.on((event) => {
      if (
        event.reason === 'sync' ||
        event.reason === 'pagination' ||
        event.reason === 'recovery'
      ) {
        // Apply ID changes eagerly to avoid temp/server ID mismatch races before reload
        if (event.idChanges && event.idChanges.length > 0) {
          const idMap = new Map(event.idChanges.map((c) => [c.from, c.to]))

          setChats((prevChats) =>
            prevChats.map((c) =>
              idMap.has(c.id) ? { ...c, id: idMap.get(c.id)! } : c,
            ),
          )

          setCurrentChat((prev) =>
            idMap.has(prev.id) ? { ...prev, id: idMap.get(prev.id)! } : prev,
          )
        }

        if (event.reason === 'recovery') {
          void reloadChats(event.ids)
        } else {
          void reloadChats()
        }
      }
    })

    return cleanup
  }, [reloadChats, setChats, setCurrentChat])

  // Initial load
  useEffect(() => {
    let mounted = true
    const initialAccountKey = accountKey
    const initialAccountGeneration = accountGenerationRef.current
    const accountChanged =
      initialLoadAccountKeyRef.current !== initialAccountKey
    initialLoadAccountKeyRef.current = initialAccountKey

    const loadInitialChats = async () => {
      if (typeof window === 'undefined') return

      try {
        const loadedChats = await loadChats(
          storeHistory && !!isSignedIn,
          storeHistory && !!isSignedIn,
        )

        if (
          !mounted ||
          accountGenerationRef.current !== initialAccountGeneration
        ) {
          return
        }

        // Always have blank chats for both modes
        const cloudBlank = createBlankChat(false)
        const localBlank = createBlankChat(true)

        // Filter out any blank chats from loaded data (they shouldn't be persisted)
        const nonBlankChats = loadedChats.filter((c) => !c.isBlankChat)

        // Combine and sort
        const finalChats = sortChats([cloudBlank, localBlank, ...nonBlankChats])
        setChatCollection(({ currentChat: current }) => ({
          chats: finalChats,
          // Preserve an explicit blank-mode selection made while storage was
          // loading. Never reset a non-blank chat.
          currentChat:
            accountChanged ||
            (current.isBlankChat &&
              current.id === '' &&
              current.isTemporary !== true)
              ? (getBlankChat(finalChats, current.isLocalOnly === true) ??
                finalChats[0])
              : current,
        }))
      } catch (error) {
        logError('Failed to load initial chats', error, {
          component: 'useChatStorage',
        })
      } finally {
        if (mounted) {
          setIsInitialLoad(false)
        }
      }
    }

    loadInitialChats()

    return () => {
      mounted = false
    }
  }, [
    storeHistory,
    isSignedIn,
    accountKey,
    initialNewChatIsLocalOnly,
    setChatCollection,
  ])

  // Create new chat (switch to the appropriate blank chat)
  const createNewChat = useCallback(
    (isLocalOnly = false, fromUserAction = true) => {
      // Find the blank chat for this mode
      const blankChat = chats.find(
        (c) => c.isBlankChat === true && c.isLocalOnly === isLocalOnly,
      )

      // If blank chat exists, just switch to it
      if (blankChat) {
        // Always switch when from user action, or when we're on a different blank chat
        if (fromUserAction || currentChat.isBlankChat) {
          // A reused blank represents a fresh chat, so drop any per-chat
          // web search override left behind by an earlier visit and start
          // from the user's current default prompt preset.
          const defaultPresetId = readDefaultPresetId() ?? undefined
          const freshBlank =
            blankChat.webSearchEnabled === undefined &&
            blankChat.presetId === defaultPresetId
              ? blankChat
              : {
                  ...blankChat,
                  webSearchEnabled: undefined,
                  presetId: defaultPresetId,
                }
          if (freshBlank !== blankChat) {
            // Blank chats share an empty id, so match by mode to avoid
            // touching the other mode's blank entry.
            setChats((prev) =>
              prev.map((c) =>
                c.isBlankChat && c.isLocalOnly === isLocalOnly ? freshBlank : c,
              ),
            )
          }
          setCurrentChat(freshBlank)
        }
      } else {
        // Create a new blank chat if it doesn't exist (shouldn't normally happen)
        const newBlankChat = createBlankChat(isLocalOnly)
        setChats((prev) => sortChats([newBlankChat, ...prev]))
        setCurrentChat(newBlankChat)
      }
    },
    [chats, currentChat.isBlankChat, setChats, setCurrentChat],
  )

  // Delete chat
  const deleteChat = useCallback(
    (chatId: string) => {
      setChatCollection(({ chats: previousChats, currentChat: current }) => {
        const filtered = previousChats.filter((chat) => chat.id !== chatId)
        const newChats = ensureAtLeastOneChat(filtered)
        return {
          chats: newChats,
          currentChat: current.id === chatId ? newChats[0] : current,
        }
      })

      // Delete from storage
      deleteChatFromStorage(chatId, !!isSignedIn).catch((error) => {
        logError('Failed to delete chat', error, {
          component: 'useChatStorage',
          metadata: { chatId },
        })
      })
    },
    [isSignedIn, setChatCollection],
  )

  // Update chat title
  const updateChatTitle = useCallback(
    (chatId: string, newTitle: string) => {
      const updatedAt = new Date().toISOString()
      const current = currentChatRef.current
      const titleSnapshot =
        current.id === chatId
          ? current
          : chatsRef.current.find((chat) => chat.id === chatId)
      const saveGeneration = storeHistory
        ? ++titleSaveSequenceRef.current
        : null
      if (saveGeneration !== null) {
        titleSaveGenerationRef.current.set(chatId, saveGeneration)
      }
      const titleAccountGeneration = accountGenerationRef.current
      const clearTitleGenerationIfOwned = () => {
        if (
          saveGeneration === null ||
          titleSaveGenerationRef.current.get(chatId) !== saveGeneration
        ) {
          return false
        }
        titleSaveGenerationRef.current.delete(chatId)
        return true
      }
      const finishSave = (savedUpdatedAt?: string) => {
        if (accountGenerationRef.current !== titleAccountGeneration) {
          clearTitleGenerationIfOwned()
          return
        }
        if (!clearTitleGenerationIfOwned()) return
        setChatCollection((previous) => {
          if (accountGenerationRef.current !== titleAccountGeneration) {
            return previous
          }
          const finish = (chat: Chat) =>
            chat.id === chatId && chat.updatedAt === updatedAt
              ? {
                  ...chat,
                  updatedAt: savedUpdatedAt ?? chat.updatedAt,
                }
              : chat
          return {
            chats: previous.chats.map(finish),
            currentChat: finish(previous.currentChat),
          }
        })
        void reloadChats()
      }
      setChats((prevChats) => {
        const updatedChats = prevChats.map((chat) =>
          chat.id === chatId
            ? {
                ...chat,
                title: newTitle,
                titleState: 'manual' as const,
                updatedAt,
              }
            : chat,
        )

        const chatToUpdate = updatedChats.find((c) => c.id === chatId)
        if (chatToUpdate && !chatToUpdate.isTemporary && storeHistory) {
          persistenceManager
            .save(chatToUpdate)
            .then((saved) => finishSave(saved.updatedAt))
            .catch((error) => {
              const clearedTitleGeneration = clearTitleGenerationIfOwned()
              if (
                accountGenerationRef.current === titleAccountGeneration &&
                clearedTitleGeneration
              ) {
                if (titleSnapshot) {
                  setChatCollection((previous) => {
                    if (
                      accountGenerationRef.current !== titleAccountGeneration
                    ) {
                      return previous
                    }
                    const rollback = (chat: Chat) =>
                      chat.id === chatId && chat.updatedAt === updatedAt
                        ? {
                            ...chat,
                            title: titleSnapshot.title,
                            titleState: titleSnapshot.titleState,
                            updatedAt: titleSnapshot.updatedAt,
                          }
                        : chat
                    return {
                      chats: previous.chats.map(rollback),
                      currentChat: rollback(previous.currentChat),
                    }
                  })
                }
                void reloadChats()
              }
              logError('Failed to save chat title update', error, {
                component: 'useChatStorage',
                metadata: { chatId },
              })
            })
        } else {
          clearTitleGenerationIfOwned()
        }

        return updatedChats
      })

      if (current.id === chatId) {
        setCurrentChat((prev) => ({
          ...prev,
          title: newTitle,
          titleState: 'manual' as const,
          updatedAt,
        }))
      }
    },
    [
      storeHistory,
      persistenceManager,
      reloadChats,
      setChats,
      setChatCollection,
      setCurrentChat,
    ],
  )

  // Set the model for the currently active chat. Blank chats are matched by
  // reference (they share an empty id) and kept as a single object so the
  // send path's reference-based blank-chat replacement still works; real
  // chats are persisted so the choice survives reloads and syncs to cloud.
  const updateChatModel = useCallback(
    (model: string) => {
      const target = currentChat
      const updated = { ...target, model }

      setCurrentChat(updated)
      setChats((prevChats) =>
        prevChats.map((c) =>
          (target.isBlankChat ? c === target : c.id === target.id)
            ? updated
            : c,
        ),
      )

      if (!target.isBlankChat && !target.isTemporary && storeHistory) {
        persistenceManager.save(updated).catch((error) => {
          logError('Failed to save chat model update', error, {
            component: 'useChatStorage',
            metadata: { chatId: target.id },
          })
        })
      }
    },
    [currentChat, storeHistory, persistenceManager, setChats, setCurrentChat],
  )

  // Switch to a different chat. Streams keep running in the background, so
  // switching never cancels an in-flight generation.
  const switchChat = useCallback(
    (chat: Chat) => {
      setCurrentChat(chat)
    },
    [setCurrentChat],
  )

  const selectChat = useCallback(
    async (chat: Chat) => {
      const selectionRequest = ++selectionRequestRef.current
      if (!chat.isMetadataOnly) {
        selectionFallbackRef.current = null
        setHydratingChatId(null)
        switchChat(chat)
        return
      }

      if (selectionFallbackRef.current === null) {
        selectionFallbackRef.current = currentChatRef.current
      }
      setCurrentChat(chat)
      setHydratingChatId(chat.id)

      try {
        const hydratedChat = await chatStorage.getChat(chat.id)
        if (!hydratedChat) {
          throw new Error('Selected chat no longer exists')
        }
        // Apply by id, not reference: a concurrent reload may have
        // replaced the objects in state. The selected summary revision
        // must still be current so a live update is never overwritten.
        setChatCollection((previous) => {
          if (selectionRequest !== selectionRequestRef.current) return previous
          const candidate = previous.chats.find(({ id }) => id === chat.id)
          if (
            !candidate?.isMetadataOnly ||
            candidate.updatedAt !== chat.updatedAt ||
            candidate.messageCount !== chat.messageCount
          ) {
            return previous
          }
          return {
            chats: previous.chats.map((current) =>
              current.id === chat.id ? hydratedChat : current,
            ),
            currentChat: hydratedChat,
          }
        })
        if (selectionRequest === selectionRequestRef.current) {
          selectionFallbackRef.current = null
          setHydratingChatId(null)
        }
      } catch (error) {
        if (selectionRequest !== selectionRequestRef.current) return
        const fallback = selectionFallbackRef.current
        selectionFallbackRef.current = null
        setHydratingChatId(null)
        if (fallback) {
          setCurrentChat(fallback)
        }
        logError('Failed to load selected chat', error, {
          component: 'useChatStorage',
          metadata: { chatId: chat.id },
        })
        toast({
          title: 'Failed to load chat',
          description: 'Please try again.',
          variant: 'destructive',
        })
      }
    },
    [setChatCollection, setCurrentChat, switchChat, toast],
  )

  // Handle chat selection
  const handleChatSelect = useCallback(
    (chatId: string) => {
      // Handle special blank chat identifiers
      if (isBlankQueueId(chatId)) {
        const isLocal = chatId === BLANK_LOCAL_QUEUE_ID
        const selectedChat = chats.find(
          (chat) => chat.isBlankChat && chat.isLocalOnly === isLocal,
        )
        if (selectedChat) {
          void selectChat(selectedChat)
        }
        return
      }

      // For regular chats, find by ID
      const selectedChat = chats.find((chat) => chat.id === chatId)
      if (selectedChat) {
        void selectChat(selectedChat)
      }
    },
    [chats, selectChat],
  )

  // Load a specific chat by ID from URL
  const loadChatById = useCallback(
    async (chatId: string, isLocalUrl: boolean) => {
      // Reset not found state when attempting to load a new chat
      setLocalChatNotFound(false)
      setCloudChatNotFound(false)
      setInitialChatLoadFailed(false)

      // First check if chat already exists in local state
      const existingChat = chats.find((c) => c.id === chatId)
      if (existingChat) {
        await selectChat(existingChat)
        return
      }

      setIsInitialLoad(true)

      try {
        // For local chat URLs, load directly from IndexedDB (chatStorage)
        // This avoids race conditions and ensures we check the right storage
        // (loadChats routes to sessionStorage when not signed in, but local chats are in IndexedDB)
        if (isLocalUrl) {
          const loadedChats = await chatStorage.getAllChats()
          const chatFromStorage = loadedChats.find((c) => c.id === chatId)
          if (chatFromStorage) {
            setChats((prev) => {
              if (prev.some((c) => c.id === chatId)) {
                return prev
              }
              return sortChats([...prev, chatFromStorage])
            })
            setCurrentChat(chatFromStorage)
            return
          }

          logError('Local chat not found', null, {
            component: 'useChatStorage',
            metadata: { chatId },
          })
          setLocalChatNotFound(true)
          return
        }

        // Chat not in local state, try to fetch from cloud
        if (!isSignedIn) {
          logError('Cannot load chat: user not signed in', null, {
            component: 'useChatStorage',
            metadata: { chatId },
          })
          return
        }

        const downloadedChat = await cloudStorage.downloadChat(chatId)

        if (!downloadedChat) {
          logError('Chat not found', null, {
            component: 'useChatStorage',
            metadata: { chatId },
          })
          setCloudChatNotFound(true)
          return
        }

        // Convert StoredChat to Chat. Spread everything through — an
        // explicit field list here silently dropped presetId and
        // webSearchEnabled in the past (chats lost their prompt preset on
        // refresh); only createdAt needs transforming.
        const chat: Chat = {
          ...downloadedChat,
          createdAt: new Date(downloadedChat.createdAt),
        }

        if (storeHistory) {
          try {
            await indexedDBStorage.applyRemoteChatIfFresh({
              chat: downloadedChat,
              syncVersion: downloadedChat.syncVersion ?? 1,
              expectedLocalUpdatedAt: null,
            })
          } catch (error) {
            logError('Failed to cache URL-loaded chat', error, {
              component: 'useChatStorage',
              metadata: { chatId },
            })
          }
        }

        // Add to chats list and select it
        setChats((prev) => {
          // Don't add if it already exists
          if (prev.some((c) => c.id === chatId)) {
            return prev
          }
          return sortChats([...prev, chat])
        })

        setCurrentChat(chat)

        // Track if the initial URL-loaded chat failed to decrypt
        if (chat.decryptionFailed) {
          setInitialChatDecryptionFailed(true)
        }

        logInfo('Loaded chat from URL', {
          component: 'useChatStorage',
          metadata: { chatId, decryptionFailed: chat.decryptionFailed },
        })
      } catch (error) {
        logError('Failed to load chat by ID', error, {
          component: 'useChatStorage',
          metadata: { chatId },
        })
        setInitialChatLoadFailed(true)
      } finally {
        setIsInitialLoad(false)
      }
    },
    [chats, isSignedIn, storeHistory, selectChat, setChats, setCurrentChat],
  )

  // Load initial chat from URL if provided
  useEffect(() => {
    // For local chat URLs: load after initial load completes (chat should be in IndexedDB)
    if (
      initialChatId &&
      isLocalChatUrl &&
      !initialChatLoadedRef.current &&
      !isInitialLoad
    ) {
      initialChatLoadedRef.current = true
      loadChatById(initialChatId, true)
      return
    }

    // For cloud chat URLs: require sign-in
    if (
      initialChatId &&
      !isLocalChatUrl &&
      isSignedIn &&
      !initialChatLoadedRef.current &&
      !isInitialLoad
    ) {
      initialChatLoadedRef.current = true
      loadChatById(initialChatId, false)
    }
  }, [initialChatId, isSignedIn, isInitialLoad, loadChatById, isLocalChatUrl])

  // Lazy-load full-res images for synced chats with v1 encrypted attachments.
  // Keyed on the set of attachments still missing bytes rather than on the
  // chat object, so hydration after a metadata-only selection (same id,
  // messages arrive later) re-triggers the fetch while streaming updates
  // that leave the set unchanged do not.
  const currentChatId = currentChat.id
  const unfetchedImageKey = currentChat.messages
    .flatMap(
      (msg) =>
        msg.attachments?.filter(
          (att) => att.type === 'image' && att.encryptionKey && !att.base64,
        ) ?? [],
    )
    .map((att) => att.id)
    .sort()
    .join('\n')
  useEffect(() => {
    if (!unfetchedImageKey) return
    const messages = currentChatRef.current.messages

    let cancelled = false

    async function loadImages() {
      const imageMap = await cloudStorage.loadChatImages(
        currentChatId,
        messages,
      )
      if (cancelled || Object.keys(imageMap).length === 0) return

      // Merge loaded base64 data into the current messages by attachment ID,
      // rather than replacing the whole array with a stale snapshot.
      const applyImages = (prev: Chat): Chat => {
        const updated = prev.messages.map((msg) => ({
          ...msg,
          attachments: msg.attachments?.map((att) =>
            imageMap[att.id] ? { ...att, base64: imageMap[att.id] } : att,
          ),
        }))
        return { ...prev, messages: updated }
      }

      setCurrentChat(applyImages)
      setChats((prev) =>
        prev.map((c) => (c.id === currentChatId ? applyImages(c) : c)),
      )
    }

    loadImages()
    return () => {
      cancelled = true
    }
  }, [currentChatId, unfetchedImageKey, setChats, setCurrentChat])

  // Clear the decryption failed state (called after entering correct key)
  const clearInitialChatDecryptionFailed = useCallback(() => {
    setInitialChatDecryptionFailed(false)
  }, [])

  const retryInitialChatLoad = useCallback(() => {
    setInitialChatLoadFailed(false)
    initialChatLoadedRef.current = false
    if (initialChatId) {
      loadChatById(initialChatId, isLocalChatUrl)
    }
  }, [initialChatId, isLocalChatUrl, loadChatById])

  return {
    chats,
    currentChat,
    setChats,
    setCurrentChat,
    createNewChat,
    deleteChat,
    updateChatTitle,
    updateChatModel,
    switchChat,
    handleChatSelect,
    loadChatById,
    setIsInitialLoad,
    isInitialLoad,
    isChatHydrating:
      hydratingChatId !== null && currentChat.id === hydratingChatId,
    reloadChats,
    initialChatDecryptionFailed,
    clearInitialChatDecryptionFailed,
    localChatNotFound,
    initialChatLoadFailed,
    cloudChatNotFound,
    retryInitialChatLoad,
  }
}
