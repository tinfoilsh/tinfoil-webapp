import { cn } from '@/components/ui/utils'
import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { RxDotsVertical } from 'react-icons/rx'
import { CONSTANTS } from '../../constants'

export interface MessageOverflowMenuItem {
  label: string
  ariaLabel?: string
  icon: React.ReactNode
  onSelect: () => void
  destructive?: boolean
}

const menuItemButtons = (menu: HTMLElement) =>
  Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))

export function MessageOverflowMenu({
  items,
  isDarkMode,
  triggerRef: externalTriggerRef,
}: {
  items: MessageOverflowMenuItem[]
  isDarkMode?: boolean
  // Exposed so callers can return focus to the trigger after a menu action
  // completes, since the menu items themselves unmount on selection.
  triggerRef?: React.RefObject<HTMLButtonElement | null>
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [position, setPosition] = useState<{
    top: number
    left: number
  } | null>(null)
  const internalTriggerRef = useRef<HTMLButtonElement>(null)
  const triggerRef = externalTriggerRef ?? internalTriggerRef
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  // Position after mount so the menu's real size is known: open upward when
  // there is not enough room below the trigger, and keep it inside the viewport.
  useLayoutEffect(() => {
    if (!isOpen) return
    const trigger = triggerRef.current
    const menu = menuRef.current
    if (!trigger || !menu) return

    const triggerRect = trigger.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const offset = CONSTANTS.OVERFLOW_MENU_OFFSET_PX
    const margin = CONSTANTS.OVERFLOW_MENU_VIEWPORT_MARGIN_PX

    const fitsBelow =
      triggerRect.bottom + offset + menuRect.height <=
      window.innerHeight - margin
    const top = fitsBelow
      ? triggerRect.bottom + offset
      : Math.max(margin, triggerRect.top - offset - menuRect.height)

    const maxLeft = window.innerWidth - margin - menuRect.width
    const left = Math.max(margin, Math.min(triggerRect.left, maxLeft))

    setPosition({ top, left })
  }, [isOpen, triggerRef])

  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setIsOpen(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false)
        triggerRef.current?.focus()
        return
      }
      if (event.key === 'Tab') {
        setIsOpen(false)
        return
      }

      const menu = menuRef.current
      if (!menu) return
      const buttons = menuItemButtons(menu)
      if (buttons.length === 0) return
      const currentIndex = buttons.findIndex(
        (button) => button === document.activeElement,
      )

      let nextIndex: number | null = null
      if (event.key === 'ArrowDown') {
        nextIndex = (currentIndex + 1) % buttons.length
      } else if (event.key === 'ArrowUp') {
        nextIndex = currentIndex <= 0 ? buttons.length - 1 : currentIndex - 1
      } else if (event.key === 'Home') {
        nextIndex = 0
      } else if (event.key === 'End') {
        nextIndex = buttons.length - 1
      }
      if (nextIndex === null) return

      event.preventDefault()
      buttons[nextIndex]?.focus()
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    const frame = requestAnimationFrame(() => {
      if (menuRef.current) menuItemButtons(menuRef.current)[0]?.focus()
    })
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
      cancelAnimationFrame(frame)
    }
  }, [isOpen, triggerRef])

  if (items.length === 0) return null

  return (
    <div className="group/more relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (isOpen) {
            setIsOpen(false)
            return
          }
          setPosition(null)
          setIsOpen(true)
        }}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        className="flex items-center gap-1.5 rounded px-2 py-2 text-xs font-medium text-content-secondary transition-all hover:bg-surface-chat-background hover:text-content-primary"
      >
        <RxDotsVertical className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {!isOpen && (
        <span className="pointer-events-none absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover/more:opacity-100">
          More
        </span>
      )}
      {isOpen &&
        createPortal(
          <div
            id={menuId}
            ref={menuRef}
            role="menu"
            aria-label="Message actions"
            className={cn(
              'fixed z-[9999] min-w-[180px] rounded-lg border py-1 shadow-lg',
              isDarkMode
                ? 'border-border-subtle bg-surface-chat'
                : 'border-border-subtle bg-white',
            )}
            style={
              position
                ? { top: position.top, left: position.left }
                : { top: 0, left: 0, visibility: 'hidden' }
            }
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                aria-label={item.ariaLabel}
                onClick={() => {
                  setIsOpen(false)
                  item.onSelect()
                }}
                className={cn(
                  'flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors',
                  item.destructive
                    ? 'text-red-500 hover:bg-red-500/10'
                    : isDarkMode
                      ? 'text-content-secondary hover:bg-surface-sidebar'
                      : 'text-content-secondary hover:bg-gray-100',
                )}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  )
}
