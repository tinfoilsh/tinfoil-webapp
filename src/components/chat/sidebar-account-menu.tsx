'use client'

import { UserAvatar } from '@/components/user-avatar'
import { PRIVACY_POLICY_URL, TERMS_URL } from '@/constants/external-links'
import { useRateLimit } from '@/hooks/use-rate-limit'
import { postAuthRedirectTarget } from '@/utils/redirect-url'
import { useUser } from '@clerk/react'
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  BugAntIcon,
  CheckIcon,
  ChevronRightIcon,
  Cog6ToothIcon,
  DocumentTextIcon,
  QuestionMarkCircleIcon,
  ShieldCheckIcon,
  UserCircleIcon,
} from '@heroicons/react/24/outline'
import { useRouter } from 'next/router'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { PiSpinner } from 'react-icons/pi'
import { Link } from '../link'
import { cn } from '../ui/utils'
import { CONSTANTS } from './constants'
import { useManualSync } from './hooks/use-manual-sync'
import { hasTokenUsage, RateLimitUsage } from './rate-limit-usage'
import type { SettingsTab } from './settings-modal'

const MENU_WIDTH_PX = 256
const HELP_MENU_WIDTH_PX = 224
const MENU_GAP_PX = 8

const MENU_ITEM_CLASS_NAME =
  'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-content-secondary hover:bg-surface-chat hover:text-content-primary focus:outline-none focus-visible:bg-surface-chat focus-visible:text-content-primary disabled:cursor-default disabled:opacity-60'

type MenuEdge = 'first' | 'last'

function enabledMenuItems(menu: HTMLElement | null): HTMLElement[] {
  return Array.from(
    menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
  ).filter(
    (item) =>
      item.closest('[role="menu"]') === menu &&
      !item.matches(':disabled') &&
      item.getAttribute('aria-disabled') !== 'true',
  )
}

function focusMenuEdge(menu: HTMLElement | null, edge: MenuEdge): boolean {
  const items = enabledMenuItems(menu)
  const target = edge === 'first' ? items[0] : items[items.length - 1]
  target?.focus({ preventScroll: true })
  return Boolean(target)
}

interface SidebarAccountMenuProps {
  isSidebarOpen: boolean
  isSignedIn: boolean
  isPremium: boolean
  isDarkMode: boolean
  /** Whether the sync row is offered (signed in with cloud sync enabled). */
  canSync: boolean
  isSyncing: boolean
  syncFailed: boolean
  syncNeedsAttention: boolean
  onSync?: () => Promise<boolean>
  onOpenSettings: (tab?: SettingsTab) => void
  onReportBug: () => void
}

export function SidebarAccountMenu({
  isSidebarOpen,
  isSignedIn,
  isPremium,
  isDarkMode,
  canSync,
  isSyncing,
  syncFailed,
  syncNeedsAttention,
  onSync,
  onOpenSettings,
  onReportBug,
}: SidebarAccountMenuProps) {
  const { user } = useUser()
  const router = useRouter()
  const [isOpen, setIsOpen] = useState(false)
  const [isHelpOpen, setIsHelpOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const helpPanelRef = useRef<HTMLDivElement>(null)
  const helpTriggerRef = useRef<HTMLButtonElement>(null)
  const pendingMenuFocus = useRef<MenuEdge | null>(null)
  const pendingHelpFocus = useRef<MenuEdge | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const clickPointerTypeRef = useRef('')
  const [panelPosition, setPanelPosition] = useState<{
    left: number
    bottom: number
  } | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const menuId = useId()
  const triggerId = useId()
  const helpMenuId = useId()
  const isMenuVisible = isSidebarOpen && isOpen

  const rateLimit = useRateLimit()
  const showUsage = isSignedIn && isPremium && hasTokenUsage(rateLimit)

  const manualSync = useManualSync({
    isSyncing,
    syncFailed,
    onSync: onSync ?? (() => Promise.resolve(false)),
  })

  const displayName = isSignedIn
    ? user?.firstName ||
      user?.emailAddresses?.[0]?.emailAddress?.split('@')[0] ||
      'Account'
    : 'Menu'

  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const close = useCallback(() => {
    cancelScheduledClose()
    pendingMenuFocus.current = null
    pendingHelpFocus.current = null
    setIsOpen(false)
    setIsHelpOpen(false)
  }, [cancelScheduledClose])

  const closeAndRestoreFocus = useCallback(() => {
    close()
    triggerRef.current?.focus()
  }, [close])

  const setPanelRef = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node
    if (node && pendingMenuFocus.current) {
      focusMenuEdge(node, pendingMenuFocus.current)
      pendingMenuFocus.current = null
    }
  }, [])

  const setHelpPanelRef = useCallback((node: HTMLDivElement | null) => {
    helpPanelRef.current = node
    if (node && pendingHelpFocus.current) {
      focusMenuEdge(node, pendingHelpFocus.current)
      pendingHelpFocus.current = null
    }
  }, [])

  const openMenuWithFocus = (edge: MenuEdge) => {
    cancelScheduledClose()
    if (!focusMenuEdge(panelRef.current, edge)) pendingMenuFocus.current = edge
    setIsOpen(true)
  }

  const openHelpWithFocus = () => {
    cancelScheduledClose()
    if (!focusMenuEdge(helpPanelRef.current, 'first'))
      pendingHelpFocus.current = 'first'
    setIsHelpOpen(true)
  }

  useEffect(() => {
    if (!isSidebarOpen) close()
  }, [isSidebarOpen, close])

  // Hover-open only applies to real pointers; touch devices toggle on tap.
  const isHoverPointer = () =>
    window.matchMedia('(hover: hover) and (pointer: fine)').matches

  const handlePointerEnter = (event: ReactPointerEvent) => {
    if (event.pointerType !== 'mouse' || !isHoverPointer()) return
    cancelScheduledClose()
    setIsOpen(true)
  }

  const handleOtherRowEnter = (event: ReactPointerEvent) => {
    if (event.pointerType !== 'mouse' || !isHoverPointer()) return
    setIsHelpOpen(false)
  }

  const rememberClickPointer = (event: ReactPointerEvent) => {
    clickPointerTypeRef.current = event.pointerType
  }

  // A mouse click confirms the hover-open state. Touch and keyboard clicks
  // toggle instead, since those interactions do not open on hover.
  const isHoverClick = (detail: number) =>
    detail > 0 && clickPointerTypeRef.current === 'mouse' && isHoverPointer()

  useEffect(() => cancelScheduledClose, [cancelScheduledClose])

  // While hover-opened, the trigger and the portaled panel form one hover
  // region (plus a tolerance margin covering the gap between them). The menu
  // closes only after the pointer has been outside that region for the grace
  // period, so moving from the trigger up into the panel never dismisses it.
  useEffect(() => {
    if (!isMenuVisible || !isHoverPointer()) return

    const isInsideHoverRegion = (x: number, y: number) => {
      const margin = CONSTANTS.SIDEBAR_MENU_HOVER_TOLERANCE_PX
      const rects = [
        containerRef.current?.getBoundingClientRect(),
        panelRef.current?.getBoundingClientRect(),
        helpPanelRef.current?.getBoundingClientRect(),
      ]
      return rects.some(
        (rect) =>
          rect &&
          x >= rect.left - margin &&
          x <= rect.right + margin &&
          y >= rect.top - margin &&
          y <= rect.bottom + margin,
      )
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return
      const { clientX, clientY } = event
      if (
        panelRef.current?.contains(document.activeElement) ||
        isInsideHoverRegion(clientX, clientY)
      ) {
        cancelScheduledClose()
        return
      }
      if (closeTimerRef.current === null) {
        closeTimerRef.current = setTimeout(
          close,
          CONSTANTS.SIDEBAR_MENU_HOVER_CLOSE_DELAY_MS,
        )
      }
    }

    document.addEventListener('pointermove', handlePointerMove)
    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
      cancelScheduledClose()
    }
  }, [isMenuVisible, cancelScheduledClose, close])

  useEffect(() => {
    if (!isMenuVisible) return

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node
      if (
        !containerRef.current?.contains(target) &&
        !panelRef.current?.contains(target)
      ) {
        close()
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      closeAndRestoreFocus()
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('touchstart', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('touchstart', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isMenuVisible, close, closeAndRestoreFocus])

  // The sidebar clips overflow, so the panel is portaled to the body and
  // anchored to the trigger. Anchoring by bottom lets it grow upward without
  // measuring its own height.
  useLayoutEffect(() => {
    if (!isMenuVisible) {
      setPanelPosition(null)
      return
    }
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      setPanelPosition({
        left: rect.left,
        bottom: window.innerHeight - rect.top + MENU_GAP_PX,
      })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    return () => window.removeEventListener('resize', updatePosition)
  }, [isMenuVisible])

  const runAndClose = (action: () => void) => {
    closeAndRestoreFocus()
    action()
  }

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return
    const menu = (event.target as HTMLElement).closest<HTMLElement>(
      '[role="menu"]',
    )
    if (!menu) return
    cancelScheduledClose()
    if (event.key === 'Tab') {
      event.stopPropagation()
      closeAndRestoreFocus()
      return
    }
    if (
      event.key === 'Escape' ||
      (event.key === 'ArrowLeft' && menu === helpPanelRef.current)
    ) {
      event.preventDefault()
      event.stopPropagation()
      if (menu === helpPanelRef.current) {
        setIsHelpOpen(false)
        helpTriggerRef.current?.focus()
      } else closeAndRestoreFocus()
      return
    }
    if (
      event.key === 'ArrowRight' &&
      (event.target as HTMLElement).closest('[role="menuitem"]') ===
        helpTriggerRef.current
    ) {
      event.preventDefault()
      event.stopPropagation()
      openHelpWithFocus()
      return
    }
    const items = enabledMenuItems(menu)
    if (!items.length) return
    const current = items.indexOf(document.activeElement as HTMLElement)
    let next: number
    if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else if (event.key === 'ArrowDown') next = (current + 1) % items.length
    else if (event.key === 'ArrowUp')
      next =
        current < 0
          ? items.length - 1
          : (current - 1 + items.length) % items.length
    else return
    event.preventDefault()
    event.stopPropagation()
    if (menu === panelRef.current && items[next] !== helpTriggerRef.current)
      setIsHelpOpen(false)
    items[next].focus({ preventScroll: true })
  }

  const handleMenuLinkKeyDown = (
    event: React.KeyboardEvent<HTMLAnchorElement>,
  ) => {
    if (event.key !== ' ') return
    event.preventDefault()
    if (!event.repeat) event.currentTarget.click()
  }

  const panelClassName = cn(
    'rounded-lg border border-border-subtle p-1.5 shadow-lg',
    isDarkMode ? 'bg-surface-chat-background' : 'bg-white',
  )

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        onPointerEnter={handlePointerEnter}
        onPointerDown={rememberClickPointer}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return
          if (event.key === 'Tab' && isMenuVisible) close()
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          openMenuWithFocus(event.key === 'ArrowDown' ? 'first' : 'last')
        }}
        type="button"
        id={triggerId}
        data-account-menu-trigger
        aria-haspopup="menu"
        aria-expanded={isMenuVisible}
        aria-controls={menuId}
        onClick={(event) => {
          cancelScheduledClose()
          if (isOpen && !isHoverClick(event.detail)) close()
          else if (event.detail === 0) openMenuWithFocus('first')
          else setIsOpen(true)
        }}
        className={cn(
          'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm',
          isMenuVisible
            ? 'bg-surface-chat text-content-primary'
            : 'text-content-secondary hover:bg-surface-chat hover:text-content-primary',
        )}
      >
        <span className="relative flex h-7 w-7 flex-none items-center justify-center overflow-hidden rounded-full">
          {isSignedIn ? (
            <UserAvatar size={28} />
          ) : (
            <UserCircleIcon className="h-7 w-7" aria-hidden="true" />
          )}
          {syncNeedsAttention && (
            <span
              className="absolute right-0 top-0 h-2 w-2 rounded-full bg-orange-500 ring-2 ring-surface-sidebar"
              title="Cloud sync needs attention"
              aria-hidden="true"
            />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate font-aeonik font-medium">
          {displayName}
        </span>
        <ChevronRightIcon
          className={cn(
            'h-4 w-4 flex-none text-content-muted transition-transform',
            isOpen && '-rotate-90',
          )}
          aria-hidden="true"
        />
      </button>

      {isMenuVisible &&
        panelPosition &&
        createPortal(
          <div
            ref={setPanelRef}
            id={menuId}
            role="menu"
            onKeyDown={handleMenuKeyDown}
            aria-labelledby={triggerId}
            style={{
              left: panelPosition.left,
              bottom: panelPosition.bottom,
              width: MENU_WIDTH_PX,
            }}
            className={cn('fixed z-[60]', panelClassName)}
          >
            {showUsage && (
              <>
                <RateLimitUsage isPremium={isPremium} />
                <div className="my-1.5 border-t border-border-subtle" />
              </>
            )}
            {isSignedIn ? (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={MENU_ITEM_CLASS_NAME}
                onPointerEnter={handleOtherRowEnter}
                onClick={() => runAndClose(() => onOpenSettings('account'))}
              >
                <UserCircleIcon className="h-4 w-4" aria-hidden="true" />
                Account
              </button>
            ) : (
              <Link
                href={`/signin?redirect_url=${postAuthRedirectTarget(router.asPath)}`}
                role="menuitem"
                tabIndex={-1}
                className={MENU_ITEM_CLASS_NAME}
                onPointerEnter={handleOtherRowEnter}
                onClick={closeAndRestoreFocus}
                onKeyDown={handleMenuLinkKeyDown}
              >
                <UserCircleIcon className="h-4 w-4" aria-hidden="true" />
                Sign in
              </Link>
            )}
            <button
              type="button"
              data-settings-button
              onPointerEnter={handleOtherRowEnter}
              role="menuitem"
              tabIndex={-1}
              className={MENU_ITEM_CLASS_NAME}
              onClick={() =>
                runAndClose(() =>
                  onOpenSettings(syncNeedsAttention ? 'cloud-sync' : 'general'),
                )
              }
            >
              <Cog6ToothIcon className="h-4 w-4" aria-hidden="true" />
              <span className="flex-1">Settings</span>
              {syncNeedsAttention && (
                <span
                  className="h-2 w-2 rounded-full bg-orange-500"
                  title="Cloud sync needs attention"
                  aria-hidden="true"
                />
              )}
            </button>
            {canSync && onSync && (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={MENU_ITEM_CLASS_NAME}
                disabled={manualSync.isDisabled}
                aria-label={`Sync cloud data. ${manualSync.statusLabel}`}
                onPointerEnter={handleOtherRowEnter}
                onClick={() => void manualSync.sync()}
              >
                {manualSync.showSpinner ? (
                  <PiSpinner className="h-4 w-4 animate-spin" aria-hidden />
                ) : manualSync.showSuccess ? (
                  <CheckIcon
                    className="h-4 w-4 text-green-600 dark:text-green-400"
                    strokeWidth={2.5}
                    aria-hidden="true"
                  />
                ) : (
                  <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
                )}
                <span className="flex-1">Sync now</span>
                <span
                  className={cn(
                    'font-aeonik-fono text-xs',
                    manualSync.hasSyncFailure
                      ? 'text-orange-500'
                      : 'text-content-muted',
                  )}
                >
                  {manualSync.statusLabel}
                </span>
              </button>
            )}

            <div className="my-1.5 border-t border-border-subtle" />

            <div className="relative">
              <button
                ref={helpTriggerRef}
                type="button"
                onPointerEnter={(event) => {
                  if (event.pointerType === 'mouse' && isHoverPointer()) {
                    cancelScheduledClose()
                    setIsHelpOpen(true)
                  }
                }}
                onPointerDown={rememberClickPointer}
                role="menuitem"
                tabIndex={-1}
                aria-haspopup="menu"
                aria-expanded={isHelpOpen}
                aria-controls={helpMenuId}
                className={cn(
                  MENU_ITEM_CLASS_NAME,
                  isHelpOpen && 'bg-surface-chat text-content-primary',
                )}
                onClick={(event) => {
                  cancelScheduledClose()
                  if (!isHelpOpen && event.detail === 0) openHelpWithFocus()
                  else setIsHelpOpen(isHoverClick(event.detail) || !isHelpOpen)
                }}
              >
                <QuestionMarkCircleIcon
                  className="h-4 w-4"
                  aria-hidden="true"
                />
                <span className="flex-1">Help</span>
                <ChevronRightIcon
                  className="h-4 w-4 text-content-muted"
                  aria-hidden="true"
                />
              </button>

              {isHelpOpen && (
                <div
                  ref={setHelpPanelRef}
                  id={helpMenuId}
                  role="menu"
                  onKeyDown={handleMenuKeyDown}
                  aria-label="Help"
                  style={{ width: HELP_MENU_WIDTH_PX }}
                  className={cn(
                    // Flyout to the right on desktop; stacked above the Help
                    // row on narrow screens where there is no room beside it.
                    'absolute z-[60] max-md:bottom-full max-md:left-0 max-md:mb-1 md:bottom-0 md:left-full md:ml-2',
                    panelClassName,
                  )}
                >
                  <a
                    role="menuitem"
                    tabIndex={-1}
                    href={TERMS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={MENU_ITEM_CLASS_NAME}
                    onClick={closeAndRestoreFocus}
                    onKeyDown={handleMenuLinkKeyDown}
                  >
                    <DocumentTextIcon className="h-4 w-4" aria-hidden="true" />
                    <span className="flex-1">Terms of Service</span>
                    <ArrowTopRightOnSquareIcon
                      className="h-3.5 w-3.5 text-content-muted"
                      aria-hidden="true"
                    />
                  </a>
                  <a
                    role="menuitem"
                    tabIndex={-1}
                    href={PRIVACY_POLICY_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={MENU_ITEM_CLASS_NAME}
                    onClick={closeAndRestoreFocus}
                    onKeyDown={handleMenuLinkKeyDown}
                  >
                    <ShieldCheckIcon className="h-4 w-4" aria-hidden="true" />
                    <span className="flex-1">Privacy Policy</span>
                    <ArrowTopRightOnSquareIcon
                      className="h-3.5 w-3.5 text-content-muted"
                      aria-hidden="true"
                    />
                  </a>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={MENU_ITEM_CLASS_NAME}
                    onClick={() => runAndClose(onReportBug)}
                  >
                    <BugAntIcon className="h-4 w-4" aria-hidden="true" />
                    Report a bug
                  </button>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
