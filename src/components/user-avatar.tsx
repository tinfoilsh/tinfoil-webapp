'use client'

import { useUser } from '@clerk/react'
import { UserAvatar as SharedUserAvatar } from '@tinfoil/chat-ui/user-avatar'

type UserAvatarProps = {
  size?: number
  className?: string
}

export function UserAvatar({ size, className }: UserAvatarProps) {
  const { user } = useUser()
  return <SharedUserAvatar user={user} size={size} className={className} />
}
