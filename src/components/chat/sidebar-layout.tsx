import type { ComponentPropsWithoutRef, CSSProperties } from 'react'
import { SIDEBAR_PATTERN_EDGE_WIDTH_PX } from '../ui/sidebar-pattern-edge'
import { cn } from '../ui/utils'
import { CONSTANTS } from './constants'

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
}

export function SidebarPanel({
  as: Component = 'nav',
  isOpen,
  isMobile,
  animate = true,
  className,
  style,
  ...props
}: SidebarPanelProps) {
  return (
    <Component
      {...props}
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
