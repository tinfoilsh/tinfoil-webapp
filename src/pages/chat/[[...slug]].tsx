'use client'

import { ChatInterface } from '@/components/chat'
import { ProjectProvider } from '@/components/project'
import { LogoLoading } from '@/components/ui/logo-loading'
import { useRouter } from 'next/router'

export default function ChatCatchAllPage() {
  const router = useRouter()
  // The exported shell hydrates with an empty query; mounting ChatInterface
  // before the slug is known would let its URL sync clear /chat/<id>.
  if (!router.isReady) return <LogoLoading />

  const slug = router.query.slug
  const parts =
    typeof slug === 'string' ? [slug] : Array.isArray(slug) ? slug : []

  const isLocalChatUrl = parts[0] === 'local'
  const chatId = isLocalChatUrl ? (parts[1] ?? null) : (parts[0] ?? null)

  return (
    <div className="h-screen font-aeonik">
      <ProjectProvider>
        <ChatInterface
          initialChatId={typeof chatId === 'string' ? chatId : null}
          isLocalChatUrl={isLocalChatUrl}
        />
      </ProjectProvider>
    </div>
  )
}
