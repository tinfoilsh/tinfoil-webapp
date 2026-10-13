import {
  useEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import { SIDEBAR_PATTERN_EDGE_WIDTH_PX } from '../ui/sidebar-pattern-edge'
import { cn } from '../ui/utils'
import { CONSTANTS } from './constants'

/** Id of the expanded sidebar, for the `aria-controls` of controls that open it. */
export const SIDEBAR_PANEL_ID = 'sidebar-panel'

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
  tintStyle?: CSSProperties
}

export function SidebarRail({
  isOpen,
  tintStyle,
  children,
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
        'fixed left-0 top-0 z-50 flex h-dvh flex-col text-content-primary',
        CONSTANTS.SIDEBAR_LAYOUT_TRANSITION_CLASS_NAME,
        isOpen ? 'pointer-events-none -translate-x-full' : 'translate-x-0',
        className,
      )}
      style={{ width: CONSTANTS.CHAT_SIDEBAR_COLLAPSED_WIDTH_PX, ...style }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 -z-10 bg-surface-sidebar"
        style={{ right: SIDEBAR_PATTERN_EDGE_WIDTH_PX, ...tintStyle }}
      />
      {children}
    </nav>
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
        'fixed left-0 top-0 z-40 flex h-dvh flex-col items-start overflow-hidden bg-surface-sidebar text-content-primary [&>*:not(:first-child)]:w-[var(--sidebar-content-width)]',
        isOpen
          ? 'translate-x-0'
          : isMobile
            ? '-translate-x-full'
            : 'translate-x-[var(--sidebar-closed-offset)]',
        animate && CONSTANTS.SIDEBAR_LAYOUT_TRANSITION_CLASS_NAME,
        className,
      )}
      style={
        {
          width: isMobile
            ? CONSTANTS.MOBILE_SIDEBAR_WIDTH
            : CONSTANTS.CHAT_SIDEBAR_WIDTH_PX,
          maxWidth: CONSTANTS.CHAT_SIDEBAR_WIDTH_PX,
          paddingRight: SIDEBAR_PATTERN_EDGE_WIDTH_PX,
          '--sidebar-closed-offset': `${CONSTANTS.CHAT_SIDEBAR_COLLAPSED_WIDTH_PX - CONSTANTS.CHAT_SIDEBAR_WIDTH_PX}px`,
          '--sidebar-content-width': isMobile
            ? '100%'
            : `${CONSTANTS.CHAT_SIDEBAR_WIDTH_PX - SIDEBAR_PATTERN_EDGE_WIDTH_PX}px`,
          ...style,
        } as CSSProperties
      }
    />
  )
}
