'use client'

import { ChatInterface } from '@/components/chat'
import { ProjectProvider } from '@/components/project/project-provider'
import { useSubscriptionStatus } from '@/hooks/use-subscription-status'
import { useRouter } from 'next/router'
import { useEffect } from 'react'

interface ChatRouteProps {
  projectId: string | null
  chatId?: string | null
  projectRoute?: boolean
  isLocalChatUrl?: boolean
  initialNewChatIsLocalOnly?: boolean
  suppressIntroModals?: boolean
}

export function ChatRoute({
  projectId,
  chatId = null,
  projectRoute = true,
  ...chatProps
}: ChatRouteProps) {
  const router = useRouter()
  const { isLoading, chat_subscription_active } = useSubscriptionStatus()

  useEffect(() => {
    if (
      projectRoute &&
      router.isReady &&
      !isLoading &&
      !chat_subscription_active
    ) {
      void router.replace('/chat?upgrade=projects')
    }
  }, [
    projectRoute,
    chat_subscription_active,
    isLoading,
    router,
    router.isReady,
  ])

  if (
    !router.isReady ||
    (projectRoute && (isLoading || !chat_subscription_active))
  )
    return null

  return (
    <ProjectProvider initialProjectId={projectId}>
      <ChatInterface
        initialProjectId={projectId}
        initialChatId={chatId}
        {...chatProps}
      />
    </ProjectProvider>
  )
}
