'use client'

import { PremiumProjectRoute } from '@/components/project/premium-project-route'
import { useRouter } from 'next/router'

export default function ProjectChatPage() {
  const router = useRouter()
  const projectId =
    typeof router.query.projectId === 'string' ? router.query.projectId : null
  const chatId =
    typeof router.query.chatId === 'string' ? router.query.chatId : null

  return (
    <div className="h-screen font-aeonik">
      <PremiumProjectRoute projectId={projectId} chatId={chatId} />
    </div>
  )
}
