import Avatar from 'boring-avatars'

const AVATAR_COLORS = ['#004444', '#F9F8F6']

export type AvatarUser = {
  id: string
  firstName?: string | null
  lastName?: string | null
  hasImage: boolean
  imageUrl: string
}

type UserAvatarProps = {
  user: AvatarUser | null | undefined
  size?: number
  className?: string
}

export function UserAvatar({ user, size = 32, className }: UserAvatarProps) {
  if (!user) return null

  const displayName =
    [user.firstName, user.lastName].filter(Boolean).join(' ') || user.id

  if (user.hasImage) {
    return (
      <img
        src={user.imageUrl}
        alt={displayName}
        width={size}
        height={size}
        className={className}
        style={{ borderRadius: '50%' }}
      />
    )
  }

  return (
    <Avatar size={size} name={user.id} variant="pixel" colors={AVATAR_COLORS} />
  )
}
