'use client'

import { PremiumProjectRoute } from '@/components/project/premium-project-route'
import { LogoLoading } from '@/components/ui/logo-loading'
import { useRouter } from 'next/router'

export default function ProjectCatchAllPage() {
  const router = useRouter()
  // Same as the chat shell: wait for the slug before mounting the chat.
  if (!router.isReady) return <LogoLoading />

  const slug = router.query.slug
  const parts =
    typeof slug === 'string' ? [slug] : Array.isArray(slug) ? slug : []

  const projectId = parts[0] ?? null
  const isProjectChat = parts[1] === 'chat'
  const chatId = isProjectChat ? (parts[2] ?? null) : null

  return (
    <div className="h-screen font-aeonik">
      <PremiumProjectRoute
        projectId={typeof projectId === 'string' ? projectId : null}
        chatId={typeof chatId === 'string' ? chatId : null}
      />
    </div>
  )
}
