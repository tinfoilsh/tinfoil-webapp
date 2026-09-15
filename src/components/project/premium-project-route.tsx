'use client'

import { ChatInterface } from '@/components/chat'
import { useSubscriptionStatus } from '@/hooks/use-subscription-status'
import { useRouter } from 'next/router'
import { useEffect } from 'react'
import { ProjectProvider } from './project-provider'

interface PremiumProjectRouteProps {
  projectId: string | null
  chatId?: string | null
}

export function PremiumProjectRoute({
  projectId,
  chatId = null,
}: PremiumProjectRouteProps) {
  const router = useRouter()
  const { isLoading, chat_subscription_active } = useSubscriptionStatus()

  useEffect(() => {
    if (router.isReady && !isLoading && !chat_subscription_active) {
      void router.replace('/chat?upgrade=projects')
    }
  }, [chat_subscription_active, isLoading, router, router.isReady])

  if (!router.isReady || isLoading || !chat_subscription_active) return null

  return (
    <ProjectProvider initialProjectId={projectId}>
      <ChatInterface initialProjectId={projectId} initialChatId={chatId} />
    </ProjectProvider>
  )
}
