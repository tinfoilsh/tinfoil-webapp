import {
  SIDEBAR_PANEL_ID,
  SidebarPanel,
  SidebarRail,
} from '@/components/chat/sidebar-layout'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { describe, expect, it, vi } from 'vitest'

function ToggleableSidebar({
  isMobile,
  initiallyOpen = false,
}: {
  isMobile: boolean
  initiallyOpen?: boolean
}) {
  const [isOpen, setIsOpen] = useState(initiallyOpen)
  return (
    <>
      {!isOpen && (
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={SIDEBAR_PANEL_ID}
          data-sidebar-toggle
          onClick={() => setIsOpen(true)}
        >
          Open sidebar
        </button>
      )}
      <input aria-label="Message" />
      <SidebarPanel
        isOpen={isOpen}
        isMobile={isMobile}
        onDismiss={() => setIsOpen(false)}
        aria-label="Chat history"
      >
        <button
          type="button"
          data-sidebar-close
          onClick={() => setIsOpen(false)}
        >
          Close sidebar
        </button>
        <input
          aria-label="Chat title"
          onKeyDown={(event) => {
            if (event.key === 'Escape') event.preventDefault()
          }}
        />
      </SidebarPanel>
    </>
  )
}

function Sidebar({ isOpen }: { isOpen: boolean }) {
  return (
    <>
      <SidebarRail isOpen={isOpen} aria-label="Collapsed sidebar">
        <button>Expand sidebar</button>
      </SidebarRail>
      <SidebarPanel
        isOpen={isOpen}
        isMobile={false}
        aria-label="Expanded sidebar"
      >
        <div>
          <button>Close sidebar</button>
        </div>
        <div>
          <input aria-label="Persistent sidebar input" defaultValue="Draft" />
        </div>
      </SidebarPanel>
    </>
  )
}

describe('sidebar layout', () => {
  it('keeps the same rail and contents mounted across a toggle', () => {
    const { rerender } = render(<Sidebar isOpen={false} />)
    const rail = screen.getByRole('navigation', { name: 'Collapsed sidebar' })
    const panel = document.querySelector('[data-sidebar-panel]')!
    const input = panel.querySelector('input')!
    input.value = 'Unsaved edit'

    rerender(<Sidebar isOpen />)
    expect(document.querySelector('[data-sidebar-rail]')).toBe(rail)
    expect(rail).toHaveAttribute('inert')
    expect(rail).toHaveAttribute('aria-hidden', 'true')
    expect(panel).not.toHaveAttribute('inert')
    expect(panel).toHaveAttribute('aria-hidden', 'false')

    rerender(<Sidebar isOpen={false} />)
    expect(document.querySelector('[data-sidebar-rail]')).toBe(rail)
    expect(rail).not.toHaveAttribute('inert')
    expect(rail).toHaveAttribute('aria-hidden', 'false')
    expect(panel).toHaveAttribute('inert')
    expect(panel).toHaveAttribute('aria-hidden', 'true')
    expect(panel.querySelector('input')).toBe(input)
    expect(input.value).toBe('Unsaved edit')
  })

  it('moves focus into the mobile sidebar on open and back to its toggle on close', () => {
    render(<ToggleableSidebar isMobile />)
    const toggle = screen.getByRole('button', { name: 'Open sidebar' })
    expect(toggle).toHaveAttribute('aria-controls', SIDEBAR_PANEL_ID)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    toggle.focus()
    fireEvent.click(toggle)

    const panel = screen.getByRole('navigation', { name: 'Chat history' })
    expect(panel).toHaveAttribute('id', SIDEBAR_PANEL_ID)
    const close = screen.getByRole('button', { name: 'Close sidebar' })
    expect(document.activeElement).toBe(close)

    fireEvent.click(close)
    expect(panel).toHaveAttribute('inert')
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Open sidebar' }),
    )
  })

  it('closes the mobile sidebar on Escape unless a control inside used the key', () => {
    render(<ToggleableSidebar isMobile initiallyOpen />)
    const panel = screen.getByRole('navigation', { name: 'Chat history' })
    const title = screen.getByRole('textbox', { name: 'Chat title' })
    title.focus()

    expect(fireEvent.keyDown(title, { key: 'Escape' })).toBe(false)
    expect(panel).not.toHaveAttribute('inert')
    expect(document.activeElement).toBe(title)

    const close = screen.getByRole('button', { name: 'Close sidebar' })
    close.focus()
    expect(fireEvent.keyDown(close, { key: 'Escape' })).toBe(false)
    expect(panel).toHaveAttribute('inert')
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Open sidebar' }),
    )
  })

  it('lets a menu portaled out of the mobile sidebar handle its own Escape', () => {
    const dismiss = vi.fn()
    render(
      <SidebarPanel
        isOpen
        isMobile
        onDismiss={dismiss}
        aria-label="Chat history"
      >
        <button type="button">Chat options</button>
        {createPortal(<button type="button">Rename</button>, document.body)}
      </SidebarPanel>,
    )

    fireEvent.keyDown(screen.getByRole('button', { name: 'Rename' }), {
      key: 'Escape',
    })
    expect(dismiss).not.toHaveBeenCalled()

    fireEvent.keyDown(screen.getByRole('button', { name: 'Chat options' }), {
      key: 'Escape',
    })
    expect(dismiss).toHaveBeenCalledOnce()
  })

  it('leaves the persistent desktop sidebar and focus elsewhere alone', () => {
    const dismiss = vi.fn()
    const desktopSidebar = (isOpen: boolean) => (
      <SidebarPanel
        isOpen={isOpen}
        isMobile={false}
        onDismiss={dismiss}
        aria-label="Chat history"
      >
        <button type="button" data-sidebar-close>
          Close sidebar
        </button>
      </SidebarPanel>
    )
    const { rerender } = render(desktopSidebar(false))
    const message = document.createElement('textarea')
    document.body.append(message)
    try {
      message.focus()
      rerender(desktopSidebar(true))
      const panel = screen.getByRole('navigation', { name: 'Chat history' })
      expect(panel).not.toHaveAttribute('inert')
      expect(document.activeElement).toBe(message)

      const close = screen.getByRole('button', { name: 'Close sidebar' })
      expect(fireEvent.keyDown(close, { key: 'Escape' })).toBe(true)
      expect(dismiss).not.toHaveBeenCalled()
    } finally {
      message.remove()
    }
  })
})
