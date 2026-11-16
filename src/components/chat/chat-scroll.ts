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

// Changes the height of the conversation (the on-screen keyboard opening or
// closing, the window being resized) and keeps the messages just above the
// composer where they are. Left alone, the browser holds the top of the view
// still, so a shorter view hides the latest messages behind the composer.
export function resizeChatViewport(
  container: HTMLElement | null,
  resize: () => void,
): void {
  if (!container?.querySelector('[data-message-role]')) {
    resize()
    return
  }
  const getContentBottom = () =>
    getChatContentBottomScrollTop(
      container.scrollHeight,
      container.clientHeight,
      getChatSpacerHeight(container),
    )
  const scrollTop = container.scrollTop
  const hiddenBelow = getContentBottom() - scrollTop
  const promptAnchored = getChatSpacerHeight(container) > 0
  resize()
  const contentBottom = getContentBottom()
  let next = contentBottom - hiddenBelow
  if (promptAnchored) {
    // A new prompt sits at the top of the view with room under its reply.
    // The view leaves the prompt only as far as the end of the reply needs,
    // and only when that end was in view, so a reply that already runs past
    // the composer, or a prompt still scrolling to the top, is not moved.
    next =
      hiddenBelow > CONSTANTS.CHAT_SCROLL_ROUNDING_PX
        ? scrollTop
        : Math.max(
            contentBottom,
            Math.min(scrollTop, getChatPromptScrollTop(container) ?? scrollTop),
          )
  }
  if (Math.abs(next - scrollTop) >= CONSTANTS.CHAT_SCROLL_ROUNDING_PX) {
    container.scrollTop = next
  }
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
