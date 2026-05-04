import { cloudStorage } from '@/services/cloud/cloud-storage'
import { chatEvents } from '@/services/storage/chat-events'
import { chatStorage } from '@/services/storage/chat-storage'
import { logError, logInfo } from '@/utils/error-handling'
import { useAuth } from '@clerk/nextjs'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CONSTANTS } from '../constants'
import type { Chat } from '../types'
import {
  createBlankChat,
  deleteChat as deleteChatFromStorage,
  ensureAtLeastOneChat,
  getBlankChat,
  loadChats,
  sortChats,
} from './chat-operations'
import { ChatPersistenceManager } from './chat-persistence-manager'

interface UseChatStorageProps {
  storeHistory: boolean
  scrollToBottom?: () => void
  beforeSwitchChat?: () => Promise<void>
  initialChatId?: string | null
  isLocalChatUrl?: boolean
}

interface UseChatStorageReturn {
  chats: Chat[]
  currentChat: Chat
  setChats: React.Dispatch<React.SetStateAction<Chat[]>>
  setCurrentChat: React.Dispatch<React.SetStateAction<Chat>>
  createNewChat: (isLocalOnly?: boolean, fromUserAction?: boolean) => void
  deleteChat: (chatId: string) => void
  updateChatTitle: (chatId: string, newTitle: string) => void
  switchChat: (chat: Chat) => Promise<void>
  handleChatSelect: (chatId: string) => void
  setIsInitialLoad: (loading: boolean) => void
  isInitialLoad: boolean
  reloadChats: () => Promise<void>
  initialChatDecryptionFailed: boolean
  clearInitialChatDecryptionFailed: () => void
  localChatNotFound: boolean
}

export function useChatStorage({
  storeHistory,
  beforeSwitchChat,
  initialChatId,
  isLocalChatUrl = false,
}: UseChatStorageProps): UseChatStorageReturn {
  const { isSignedIn } = useAuth()
  const [isInitialLoad, setIsInitialLoad] = useState(true)
  const initialChatLoadedRef = useRef(false)
  const [initialChatDecryptionFailed, setInitialChatDecryptionFailed] =
    useState(false)
  const [localChatNotFound, setLocalChatNotFound] = useState(false)

  // Initialize with blank chats for both modes
  const [chats, setChats] = useState<Chat[]>(() => {
    if (typeof window === 'undefined') {
      return [createBlankChat(false), createBlankChat(true)]
    }
    return [createBlankChat(false), createBlankChat(true)]
  })

  const [currentChat, setCurrentChat] = useState<Chat>(chats[0])

  // Create persistence manager
  const persistenceManager = useMemo(
    () => new ChatPersistenceManager(!!isSignedIn),
    [isSignedIn],
  )

  // Update persistence manager when auth changes
  useEffect(() => {
    persistenceManager.setSignedIn(!!isSignedIn)
  }, [isSignedIn, persistenceManager])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      persistenceManager.cleanup()
    }
  }, [persistenceManager])

  // Load chats from storage
  const reloadChats = useCallback(async () => {
    if (typeof window === 'undefined') return

    try {
      const loadedChats = await loadChats(storeHistory && !!isSignedIn)

      setChats((prevChats) => {
        // Always ensure we have blank chats for both modes
        const cloudBlank =
          getBlankChat(prevChats, false) || createBlankChat(false)
        const localBlank =
          getBlankChat(prevChats, true) || createBlankChat(true)

        // Merge loaded chats with state (excluding blank chats)
        const nonBlankChats = loadedChats.filter((c) => !c.isBlankChat)

        // Combine blank chats with loaded chats and sort
        const finalChats = sortChats([cloudBlank, localBlank, ...nonBlankChats])

        return finalChats
      })

      // Update current chat metadata only - NEVER switch to a different chat.
      // Chat switching should only happen through explicit user actions.
      // This prevents race conditions in Safari PWA where timing differences
      // could cause unexpected chat resets.
      setCurrentChat((prev) => {
        if (isSwitchingChatRef.current || prev.isBlankChat) {
          return prev
        }

        // Only update metadata (syncedAt, title) if the same chat exists in storage
        const existingChat = loadedChats.find((c) => c.id === prev.id)
        if (existingChat) {
          if (
            prev.syncedAt !== existingChat.syncedAt ||
            prev.title !== existingChat.title
          ) {
            return {
              ...prev,
              syncedAt: existingChat.syncedAt,
              title: existingChat.title,
            }
          }
        }

        return prev
      })
    } catch (error) {
      logError('Failed to reload chats', error, {
        component: 'useChatStorage',
      })
    }
  }, [storeHistory, isSignedIn])

  // Listen for chat events (cloud sync, pagination, etc.)
  useEffect(() => {
    const cleanup = chatEvents.on((event) => {
      if (event.reason === 'sync' || event.reason === 'pagination') {
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

        reloadChats()
      }
    })

    return cleanup
  }, [reloadChats])

  // Initial load
  useEffect(() => {
    let mounted = true

    const loadInitialChats = async () => {
      if (typeof window === 'undefined') return

      try {
        const loadedChats = await loadChats(storeHistory && !!isSignedIn)

        if (!mounted) return

        // Always have blank chats for both modes
        const cloudBlank = createBlankChat(false)
        const localBlank = createBlankChat(true)

        // Filter out any blank chats from loaded data (they shouldn't be persisted)
        const nonBlankChats = loadedChats.filter((c) => !c.isBlankChat)

        // Combine and sort
        const finalChats = sortChats([cloudBlank, localBlank, ...nonBlankChats])

        setChats(finalChats)

        // Only set current chat to first loaded chat if we're on a blank chat.
        // Never reset a non-blank chat - prevents Safari PWA timing issues.
        setCurrentChat((prev) =>
          isSwitchingChatRef.current || !prev.isBlankChat
            ? prev
            : finalChats[0],
        )
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
  }, [storeHistory, isSignedIn])

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
          setCurrentChat(blankChat)
        }
      } else {
        // Create a new blank chat if it doesn't exist (shouldn't normally happen)
        const newBlankChat = createBlankChat(isLocalOnly)
        setChats((prev) => sortChats([newBlankChat, ...prev]))
        setCurrentChat(newBlankChat)
      }
    },
    [chats, currentChat.isBlankChat],
  )

  // Delete chat
  const deleteChat = useCallback(
    (chatId: string) => {
      // Delete from storage
      deleteChatFromStorage(chatId, !!isSignedIn)
        .then(() => {
          setChats((prevChats) => {
            const filtered = prevChats.filter((c) => c.id !== chatId)
            const newChats = ensureAtLeastOneChat(filtered)

            // Switch to another chat if we deleted the current one
            if (currentChat?.id === chatId && newChats.length > 0) {
              setCurrentChat(newChats[0])
            }

            return newChats
          })
        })
        .catch((error) => {
          logError('Failed to delete chat', error, {
            component: 'useChatStorage',
            metadata: { chatId },
          })
        })
    },
    [currentChat?.id, isSignedIn],
  )

  // Update chat title
  const updateChatTitle = useCallback(
    (chatId: string, newTitle: string) => {
      setChats((prevChats) => {
        const updatedChats = prevChats.map((chat) =>
          chat.id === chatId
            ? { ...chat, title: newTitle, titleState: 'manual' as const }
            : chat,
        )

        const chatToUpdate = updatedChats.find((c) => c.id === chatId)
        if (chatToUpdate && storeHistory) {
          persistenceManager.save(chatToUpdate).catch((error) => {
            logError('Failed to save chat title update', error, {
              component: 'useChatStorage',
              metadata: { chatId },
            })
          })
        }

        return updatedChats
      })

      if (currentChat?.id === chatId) {
        setCurrentChat((prev) => ({
          ...prev,
          title: newTitle,
          titleState: 'manual' as const,
        }))
      }
    },
    [storeHistory, currentChat?.id, persistenceManager],
  )

  // Track when we're in the middle of switching chats to prevent reloadChats from interfering
  const isSwitchingChatRef = useRef(false)
  const switchChatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cleanup switch chat timer on unmount
  useEffect(() => {
    return () => {
      if (switchChatTimerRef.current) {
        clearTimeout(switchChatTimerRef.current)
      }
    }
  }, [])

  // Switch to a different chat
  const switchChat = useCallback(
    async (chat: Chat) => {
      // Cancel any ongoing stream before switching
      if (beforeSwitchChat) {
        await beforeSwitchChat()
      }

      // Clear any pending timer from a previous switch
      if (switchChatTimerRef.current) {
        clearTimeout(switchChatTimerRef.current)
      }

      isSwitchingChatRef.current = true
      setCurrentChat(chat)
      setIsInitialLoad(true)

      // Brief delay to show loading state
      switchChatTimerRef.current = setTimeout(() => {
        setIsInitialLoad(false)
        isSwitchingChatRef.current = false
        switchChatTimerRef.current = null
      }, CONSTANTS.CHAT_INIT_DELAY_MS)
    },
    [beforeSwitchChat],
  )

  // Handle chat selection
  const handleChatSelect = useCallback(
    (chatId: string) => {
      // Handle special blank chat identifiers
      if (chatId === 'blank-local' || chatId === 'blank-cloud') {
        const isLocal = chatId === 'blank-local'
        const selectedChat = chats.find(
          (chat) => chat.isBlankChat && chat.isLocalOnly === isLocal,
        )
        if (selectedChat) {
          switchChat(selectedChat)
        }
        return
      }

      // For regular chats, find by ID
      const selectedChat = chats.find((chat) => chat.id === chatId)
      if (selectedChat) {
        switchChat(selectedChat)
      }
    },
    [chats, switchChat],
  )

  // Load a specific chat by ID from URL
  const loadChatById = useCallback(
    async (chatId: string, isLocalUrl: boolean) => {
      // Reset not found state when attempting to load a new chat
      setLocalChatNotFound(false)

      // First check if chat already exists in local state
      const existingChat = chats.find((c) => c.id === chatId)
      if (existingChat) {
        switchChat(existingChat)
        return
      }

      // For local chat URLs, load directly from IndexedDB (chatStorage)
      // This avoids race conditions and ensures we check the right storage
      // (loadChats routes to sessionStorage when not signed in, but local chats are in IndexedDB)
      if (isLocalUrl) {
        try {
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
        } catch (error) {
          logError('Failed to load local chat from storage', error, {
            component: 'useChatStorage',
            metadata: { chatId },
          })
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

      try {
        const downloadedChat = await cloudStorage.downloadChat(chatId)

        if (!downloadedChat) {
          logError('Chat not found', null, {
            component: 'useChatStorage',
            metadata: { chatId },
          })
          return
        }

        // Convert StoredChat to Chat type
        const chat: Chat = {
          id: downloadedChat.id,
          title: downloadedChat.title,
          messages: downloadedChat.messages,
          createdAt: new Date(downloadedChat.createdAt),
          syncedAt: downloadedChat.syncedAt,
          locallyModified: downloadedChat.locallyModified,
          decryptionFailed: downloadedChat.decryptionFailed,
          projectId: downloadedChat.projectId,
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
      }
    },
    [chats, isSignedIn, switchChat],
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
  // Depends on currentChat.id (not currentChat) to avoid re-triggering on
  // every streaming message update.
  const currentChatId = currentChat.id
  useEffect(() => {
    const messages = currentChat.messages
    const hasUnfetchedImages = messages.some((msg) =>
      msg.attachments?.some(
        (att) => att.type === 'image' && att.encryptionKey && !att.base64,
      ),
    )
    if (!hasUnfetchedImages) return

    let cancelled = false

    async function loadImages() {
      const imageMap = await cloudStorage.loadChatImages(messages)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChatId])

  // Clear the decryption failed state (called after entering correct key)
  const clearInitialChatDecryptionFailed = useCallback(() => {
    setInitialChatDecryptionFailed(false)
  }, [])

  return {
    chats,
    currentChat,
    setChats,
    setCurrentChat,
    createNewChat,
    deleteChat,
    updateChatTitle,
    switchChat,
    handleChatSelect,
    setIsInitialLoad,
    isInitialLoad,
    reloadChats,
    initialChatDecryptionFailed,
    clearInitialChatDecryptionFailed,
    localChatNotFound,
  }
}
