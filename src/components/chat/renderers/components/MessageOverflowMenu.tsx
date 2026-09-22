import { cn } from '@/components/ui/utils'
import { EllipsisHorizontalIcon } from '@heroicons/react/24/outline'
import React, { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CONSTANTS } from '../../constants'

export interface MessageOverflowMenuItem {
  label: string
  ariaLabel?: string
  icon: React.ReactNode
  onSelect: () => void
  destructive?: boolean
  buttonRef?: React.Ref<HTMLButtonElement>
}

export function MessageOverflowMenu({
  items,
  isDarkMode,
}: {
  items: MessageOverflowMenuItem[]
  isDarkMode?: boolean
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

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
      if (event.key !== 'Escape') return
      setIsOpen(false)
      triggerRef.current?.focus()
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector('button')?.focus()
    })
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
      cancelAnimationFrame(frame)
    }
  }, [isOpen])

  if (items.length === 0) return null

  return (
    <div className="group/more relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => {
          if (isOpen) {
            setIsOpen(false)
            return
          }
          const rect = e.currentTarget.getBoundingClientRect()
          setPosition({
            top: rect.bottom + CONSTANTS.OVERFLOW_MENU_OFFSET_PX,
            left: rect.left,
          })
          setIsOpen(true)
        }}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        className="flex items-center gap-1.5 rounded px-2 py-2 text-xs font-medium text-content-secondary transition-all hover:bg-surface-chat-background hover:text-content-primary"
      >
        <EllipsisHorizontalIcon className="h-3.5 w-3.5" aria-hidden="true" />
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
            style={{ top: position.top, left: position.left }}
          >
            {items.map((item) => (
              <button
                key={item.label}
                ref={item.buttonRef}
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
