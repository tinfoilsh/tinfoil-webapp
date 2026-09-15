'use client'

import { PremiumProjectRoute } from '@/components/project/premium-project-route'
import { useRouter } from 'next/router'

export default function ProjectPage() {
  const router = useRouter()
  const projectId =
    typeof router.query.projectId === 'string' ? router.query.projectId : null

  return (
    <div className="h-screen font-aeonik">
      <PremiumProjectRoute projectId={projectId} />
    </div>
  )
}
