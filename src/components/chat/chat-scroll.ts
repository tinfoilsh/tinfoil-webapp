function getChatContentBottomScrollTop(
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
