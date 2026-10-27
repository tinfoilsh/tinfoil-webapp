'use client'

import { ChatInterface } from '@/components/chat'
import { ProjectProvider } from '@/components/project'
import { useRouter } from 'next/router'

export default function ChatCatchAllPage() {
  const router = useRouter()
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
