import { CONSTANTS } from '@/components/chat/constants'
import { SidebarPanel, SidebarRail } from '@/components/chat/sidebar-layout'
import { SidebarPatternEdge } from '@/components/ui/sidebar-pattern-edge'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

function Sidebar({
  isOpen,
  isMobile = false,
}: {
  isOpen: boolean
  isMobile?: boolean
}) {
  return (
    <>
      {!isMobile && (
        <SidebarRail isOpen={isOpen} aria-label="Collapsed sidebar">
          <button>Expand sidebar</button>
        </SidebarRail>
      )}
      <SidebarPanel
        isOpen={isOpen}
        isMobile={isMobile}
        aria-label="Expanded sidebar"
      >
        <SidebarPatternEdge isDarkMode={false} />
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
  it('keeps the same rail and contents mounted across repeated toggles', () => {
    const { rerender } = render(<Sidebar isOpen={false} />)
    const rail = screen.getByRole('navigation', { name: 'Collapsed sidebar' })
    const panel = document.querySelector('[data-sidebar-panel]')!
    const input = panel.querySelector('input')!
    input.value = 'Unsaved edit'
    expect(
      document.querySelectorAll('[data-sidebar-pattern-edge]'),
    ).toHaveLength(1)

    for (let count = 0; count < 5; count += 1) {
      rerender(<Sidebar isOpen />)
      expect(
        document.querySelectorAll('[data-sidebar-pattern-edge]'),
      ).toHaveLength(1)
      expect(document.querySelector('[data-sidebar-rail]')).toBe(rail)
      expect(rail).toHaveAttribute('inert')
      expect(rail).toHaveAttribute('aria-hidden', 'true')
      expect(rail).toHaveClass('-translate-x-full', 'pointer-events-none')
      expect(rail).not.toHaveClass('invisible')
      expect(panel).not.toHaveAttribute('inert')
      expect(panel).toHaveAttribute('aria-hidden', 'false')
      expect(panel).toHaveStyle({
        width: `${CONSTANTS.CHAT_SIDEBAR_WIDTH_PX}px`,
      })
      expect(
        screen.queryByRole('button', { name: 'Expand sidebar' }),
      ).not.toBeInTheDocument()

      rerender(<Sidebar isOpen={false} />)
      expect(document.querySelector('[data-sidebar-rail]')).toBe(rail)
      expect(rail).not.toHaveAttribute('inert')
      expect(rail).toHaveAttribute('aria-hidden', 'false')
      expect(rail).not.toHaveClass('invisible')
      expect(rail).toHaveClass('translate-x-0')
      expect(panel).toHaveAttribute('inert')
      expect(panel).toHaveAttribute('aria-hidden', 'true')
      expect(panel).toHaveStyle({
        width: `${CONSTANTS.CHAT_SIDEBAR_WIDTH_PX}px`,
      })
      expect(panel).toHaveClass('translate-x-[var(--sidebar-closed-offset)]')
      expect(panel).not.toHaveClass('[&>*:not(:first-child)]:invisible')
      expect(panel.querySelector('input')).toBe(input)
      expect(input.value).toBe('Unsaved edit')
    }
  })

  it('slides the mobile panel without resizing or remounting its contents', () => {
    const { rerender } = render(<Sidebar isOpen={false} isMobile />)
    const panel = document.querySelector('[data-sidebar-panel]')!
    const input = panel.querySelector('input')!
    expect(document.querySelector('[data-sidebar-rail]')).toBeNull()
    expect(panel).toHaveClass('-translate-x-full')
    expect((panel as HTMLElement).style.width).toBe('85vw')

    rerender(<Sidebar isOpen isMobile />)
    expect(panel).toHaveClass('translate-x-0')
    expect(panel).not.toHaveAttribute('inert')
    expect((panel as HTMLElement).style.width).toBe('85vw')
    expect(panel.querySelector('input')).toBe(input)
  })

  it('preserves project tint, panel semantics, and first-paint animation opt-out', () => {
    const { container } = render(
      <SidebarPanel
        as="div"
        isOpen
        isMobile={false}
        animate={false}
        style={{ backgroundImage: 'linear-gradient(red, blue)' }}
      >
        <span>Project contents</span>
      </SidebarPanel>,
    )
    const panel = container.firstElementChild!
    expect(panel.tagName).toBe('DIV')
    expect(panel).toHaveStyle({ backgroundImage: 'linear-gradient(red, blue)' })
    expect(panel).not.toHaveClass('duration-200')
    expect(screen.getByText('Project contents')).toBeInTheDocument()
  })
})
