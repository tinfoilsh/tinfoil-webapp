import { CONSTANTS } from './constants'

export function getChatSpacerHeight(container: HTMLElement): number {
  return (
    container.querySelector<HTMLElement>('[data-spacer]')?.offsetHeight ?? 0
  )
}

export function getChatContentBottomScrollTop(
  scrollHeight: number,
  clientHeight: number,
  spacerHeight: number,
): number {
  return Math.max(0, scrollHeight - clientHeight - spacerHeight)
}

// The scroll position that puts the latest prompt at the top of the view.
export function getChatPromptScrollTop(container: HTMLElement): number | null {
  const prompts = container.querySelectorAll<HTMLElement>(
    '[data-message-role="user"]',
  )
  const prompt = prompts[prompts.length - 1]
  if (!prompt) return null
  return (
    container.scrollTop +
    prompt.getBoundingClientRect().top -
    container.getBoundingClientRect().top -
    CONSTANTS.CHAT_MESSAGE_TOP_GAP_PX
  )
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
