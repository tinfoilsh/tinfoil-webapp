export interface FavoriteDestination {
  id: string
  projectId?: string
}

interface OpenFavoriteChatOptions {
  favorite: FavoriteDestination
  activeProjectId?: string
  isProjectMode: boolean
  enterProjectMode: (
    projectId: string,
    isCurrent: () => boolean,
  ) => Promise<boolean>
  exitProjectMode: () => void
  openChat: (chatId: string) => Promise<void>
  isCurrent: () => boolean
}

export async function openFavoriteChat({
  favorite,
  activeProjectId,
  isProjectMode,
  enterProjectMode,
  exitProjectMode,
  openChat,
  isCurrent,
}: OpenFavoriteChatOptions): Promise<boolean> {
  if (
    favorite.projectId &&
    (!isProjectMode || activeProjectId !== favorite.projectId)
  ) {
    const entered = await enterProjectMode(favorite.projectId, isCurrent)
    if (!entered || !isCurrent()) return false
  } else if (!favorite.projectId && isProjectMode) {
    exitProjectMode()
  }

  if (!isCurrent()) return false
  await openChat(favorite.id)
  return isCurrent()
}
