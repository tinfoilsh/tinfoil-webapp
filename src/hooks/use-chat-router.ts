import { getChatPath, getNewChatPath } from '@/utils/navigation'
import { MESSAGE_HASH_PREFIX, MESSAGE_QUERY_PARAM } from '@/utils/redirect-url'
import { useRouter } from 'next/router'
import { useCallback, useEffect, useState } from 'react'

interface UseChatRouterReturn {
  initialChatId: string | null
  initialProjectId: string | null
  isLocalChatUrl: boolean
  isRouterReady: boolean
  updateUrlForChat: (chatId: string, projectId?: string) => void
  updateUrlForLocalChat: (chatId: string) => void
  updateUrlForProject: (projectId: string) => void
  clearUrl: () => void
}

function preservePendingMessage(path: string): string {
  const next = new URL(path, window.location.origin)
  const query = new URLSearchParams(window.location.search)
  const message = query.get(MESSAGE_QUERY_PARAM)
  if (message !== null) next.searchParams.set(MESSAGE_QUERY_PARAM, message)
  if (window.location.hash.startsWith(MESSAGE_HASH_PREFIX)) {
    next.hash = window.location.hash
  }
  return next.pathname + next.search + next.hash
}

export function useChatRouter(): UseChatRouterReturn {
  const router = useRouter()
  const [isRouterReady, setIsRouterReady] = useState(false)

  const initialChatId =
    router.isReady && typeof router.query.chatId === 'string'
      ? router.query.chatId
      : null
  const initialProjectId =
    router.isReady && typeof router.query.projectId === 'string'
      ? router.query.projectId
      : null

  const isLocalChatUrl =
    router.isReady && router.pathname === '/chat/local/[chatId]'

  useEffect(() => {
    if (router.isReady && !isRouterReady) {
      setIsRouterReady(true)
    }
  }, [router.isReady, isRouterReady])

  // Use history.replaceState directly to avoid Next.js route changes
  // This keeps us on the same page component while updating the URL.
  const updateUrlForChat = useCallback((chatId: string, projectId?: string) => {
    if (typeof window === 'undefined') return

    const newPath = getChatPath(chatId, { projectId })

    if (window.location.pathname !== newPath) {
      const nextUrl = preservePendingMessage(newPath)
      window.history.replaceState(
        { ...window.history.state, as: nextUrl, url: nextUrl },
        '',
        nextUrl,
      )
    }
  }, [])

  const updateUrlForLocalChat = useCallback((chatId: string) => {
    if (typeof window === 'undefined') return

    const newPath = getChatPath(chatId, { isLocalOnly: true })

    if (window.location.pathname !== newPath) {
      const nextUrl = preservePendingMessage(newPath)
      window.history.replaceState(
        { ...window.history.state, as: nextUrl, url: nextUrl },
        '',
        nextUrl,
      )
    }
  }, [])

  const updateUrlForProject = useCallback((projectId: string) => {
    if (typeof window === 'undefined') return

    const newPath = getNewChatPath({ projectId })

    if (window.location.pathname !== newPath) {
      const nextUrl = preservePendingMessage(newPath)
      window.history.replaceState(
        { ...window.history.state, as: nextUrl, url: nextUrl },
        '',
        nextUrl,
      )
    }
  }, [])

  const clearUrl = useCallback(() => {
    if (typeof window === 'undefined') return

    if (window.location.pathname !== '/') {
      const nextUrl = preservePendingMessage('/')
      window.history.replaceState(
        { ...window.history.state, as: nextUrl, url: nextUrl },
        '',
        nextUrl,
      )
    }
  }, [])

  return {
    initialChatId,
    initialProjectId,
    isLocalChatUrl,
    isRouterReady,
    updateUrlForChat,
    updateUrlForLocalChat,
    updateUrlForProject,
    clearUrl,
  }
}
