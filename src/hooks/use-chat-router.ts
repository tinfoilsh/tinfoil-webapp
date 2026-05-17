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

    const newPath = projectId
      ? `/project/${projectId}/chat/${chatId}`
      : `/chat/${chatId}`

    if (window.location.pathname !== newPath) {
      window.history.replaceState(
        { ...window.history.state, as: newPath, url: newPath },
        '',
        newPath,
      )
    }
  }, [])

  const updateUrlForLocalChat = useCallback((chatId: string) => {
    if (typeof window === 'undefined') return

    const newPath = `/chat/local/${chatId}`

    if (window.location.pathname !== newPath) {
      window.history.replaceState(
        { ...window.history.state, as: newPath, url: newPath },
        '',
        newPath,
      )
    }
  }, [])

  const updateUrlForProject = useCallback((projectId: string) => {
    if (typeof window === 'undefined') return

    const newPath = `/project/${projectId}`

    if (window.location.pathname !== newPath) {
      window.history.replaceState(
        { ...window.history.state, as: newPath, url: newPath },
        '',
        newPath,
      )
    }
  }, [])

  const clearUrl = useCallback(() => {
    if (typeof window === 'undefined') return

    if (window.location.pathname !== '/') {
      window.history.replaceState(
        { ...window.history.state, as: '/', url: '/' },
        '',
        '/',
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
