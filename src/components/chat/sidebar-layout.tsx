import {
  useEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import { cn } from '../ui/utils'
import { CONSTANTS } from './constants'

/** Id of the expanded sidebar, for the `aria-controls` of controls that open it. */
export const SIDEBAR_PANEL_ID = 'sidebar-panel'

/** Where the chat starts beside the open sidebar, gaps included. */
export const SIDEBAR_OPEN_OFFSET_PX =
  CONSTANTS.CHAT_SIDEBAR_WIDTH_PX + 2 * CONSTANTS.CHAT_SIDEBAR_INSET_PX

/** Where the chat starts beside the collapsed rail, gaps included. */
export const SIDEBAR_COLLAPSED_OFFSET_PX =
  CONSTANTS.CHAT_SIDEBAR_COLLAPSED_WIDTH_PX +
  2 * CONSTANTS.CHAT_SIDEBAR_INSET_PX

// The rail and the expanded panel are matching cards that float inside the
// window. A hidden card moves past the window edge and drops its shadow so
// none of it shows in the gap.
const FLOATING_SIDEBAR_CLASS_NAME =
  'fixed flex flex-col rounded-2xl border border-border-subtle bg-surface-sidebar text-content-primary'
const FLOATING_SIDEBAR_SHOWN_CLASS_NAME = 'translate-x-0 shadow-md'
const FLOATING_SIDEBAR_HIDDEN_CLASS_NAME =
  'translate-x-[var(--sidebar-hidden-offset)] shadow-none'
const FLOATING_SIDEBAR_STYLE = {
  top: CONSTANTS.CHAT_SIDEBAR_INSET_PX,
  left: CONSTANTS.CHAT_SIDEBAR_INSET_PX,
  height: `calc(100dvh - ${2 * CONSTANTS.CHAT_SIDEBAR_INSET_PX}px)`,
  '--sidebar-hidden-offset': `calc(-100% - ${CONSTANTS.CHAT_SIDEBAR_INSET_PX}px)`,
} as CSSProperties

// Controls that open the sidebar carry `data-sidebar-toggle` so focus can
// return to one on close; its close button carries `data-sidebar-close` so it
// can take focus on open.
const SIDEBAR_TOGGLE_SELECTOR = '[data-sidebar-toggle]'
const SIDEBAR_CLOSE_SELECTOR = '[data-sidebar-close]'

function isFocusLost(element: Element | null): boolean {
  return (
    !element || element === document.body || element.closest('[inert]') !== null
  )
}

type SidebarRailProps = ComponentPropsWithoutRef<'nav'> & {
  isOpen: boolean
}

export function SidebarRail({
  isOpen,
  className,
  style,
  ...props
}: SidebarRailProps) {
  return (
    <nav
      {...props}
      data-sidebar-rail
      aria-hidden={isOpen}
      inert={isOpen}
      className={cn(
        'z-50',
        FLOATING_SIDEBAR_CLASS_NAME,
        CONSTANTS.SIDEBAR_LAYOUT_TRANSITION_CLASS_NAME,
        isOpen && 'pointer-events-none',
        isOpen
          ? FLOATING_SIDEBAR_HIDDEN_CLASS_NAME
          : FLOATING_SIDEBAR_SHOWN_CLASS_NAME,
        className,
      )}
      style={{
        ...FLOATING_SIDEBAR_STYLE,
        width: CONSTANTS.CHAT_SIDEBAR_COLLAPSED_WIDTH_PX,
        ...style,
      }}
    />
  )
}

type SidebarPanelProps = ComponentPropsWithoutRef<'div'> & {
  as?: 'nav' | 'div'
  isOpen: boolean
  isMobile: boolean
  animate?: boolean
  /** Closes the mobile sidebar when Escape is pressed inside it. */
  onDismiss?: () => void
}

export function SidebarPanel({
  as: Component = 'nav',
  isOpen,
  isMobile,
  animate = true,
  onDismiss,
  className,
  style,
  onKeyDown,
  ...props
}: SidebarPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const wasOpenRef = useRef(isOpen)

  useEffect(() => {
    const wasOpen = wasOpenRef.current
    wasOpenRef.current = isOpen
    const panel = panelRef.current
    if (wasOpen === isOpen || !panel) return
    const active = document.activeElement

    if (isOpen) {
      // The control that opened the sidebar unmounts or turns inert, and on
      // mobile the sidebar covers the chat, so move focus into the sidebar
      // rather than leaving it on the page body.
      if (panel.contains(active) || (!isMobile && !isFocusLost(active))) return
      panel
        .querySelector<HTMLElement>(SIDEBAR_CLOSE_SELECTOR)
        ?.focus({ preventScroll: true })
      return
    }

    // Closing makes the panel inert, so return focus to whichever control
    // reopens it unless focus already moved somewhere else.
    if (!panel.contains(active) && !isFocusLost(active)) return
    Array.from(document.querySelectorAll<HTMLElement>(SIDEBAR_TOGGLE_SELECTOR))
      .find((toggle) => !toggle.closest('[inert]'))
      ?.focus({ preventScroll: true })
  }, [isOpen, isMobile])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event)
    // React also delivers keys from menus portaled out of the panel; those
    // close themselves, so only Escape from the panel's own DOM dismisses it.
    if (
      event.key !== 'Escape' ||
      event.defaultPrevented ||
      !isMobile ||
      !onDismiss ||
      !event.currentTarget.contains(event.target as Node)
    ) {
      return
    }
    event.preventDefault()
    onDismiss()
  }

  return (
    <Component
      id={SIDEBAR_PANEL_ID}
      {...props}
      ref={panelRef}
      onKeyDown={handleKeyDown}
      data-sidebar-panel
      aria-hidden={!isOpen}
      inert={!isOpen}
      className={cn(
        'z-40 overflow-hidden',
        FLOATING_SIDEBAR_CLASS_NAME,
        isOpen
          ? FLOATING_SIDEBAR_SHOWN_CLASS_NAME
          : FLOATING_SIDEBAR_HIDDEN_CLASS_NAME,
        animate && CONSTANTS.SIDEBAR_LAYOUT_TRANSITION_CLASS_NAME,
        className,
      )}
      style={{
        ...FLOATING_SIDEBAR_STYLE,
        width: isMobile
          ? CONSTANTS.MOBILE_SIDEBAR_WIDTH
          : CONSTANTS.CHAT_SIDEBAR_WIDTH_PX,
        maxWidth: CONSTANTS.CHAT_SIDEBAR_WIDTH_PX,
        ...style,
      }}
    />
  )
}
