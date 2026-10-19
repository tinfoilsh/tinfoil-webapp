export function getChatSpacerHeight(container: HTMLElement): number {
  const spacer = container.querySelector('[data-spacer]') as HTMLElement | null
  return spacer?.offsetHeight ?? 0
}

export function getChatContentBottomScrollTop(
  scrollHeight: number,
  clientHeight: number,
  spacerHeight: number,
): number {
  return Math.max(0, scrollHeight - clientHeight - spacerHeight)
}

export function canRemoveChatSpacerWithoutJump(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  spacerHeight: number,
): boolean {
  return (
    scrollTop <=
    getChatContentBottomScrollTop(scrollHeight, clientHeight, spacerHeight)
  )
}

export function getDistanceFromChatContentBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  spacerHeight: number,
): number {
  return scrollHeight - scrollTop - clientHeight - spacerHeight
}
