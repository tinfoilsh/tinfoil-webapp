import { CONSTANTS } from '@/components/chat/constants'
import { SidebarAccountMenu } from '@/components/chat/sidebar-account-menu'
import { PRIVACY_POLICY_URL, TERMS_URL } from '@/constants/external-links'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userState: { user: unknown } = { user: null }

vi.mock('next/router', () => ({
  useRouter: () => ({ asPath: '/c/chat-1?view=compact#bottom' }),
}))

vi.mock('@clerk/nextjs', () => ({
  useUser: () => userState,
}))

vi.mock('@/hooks/use-rate-limit', () => ({
  useRateLimit: () => null,
}))

vi.mock('@/components/user-avatar', () => ({
  UserAvatar: () => <span data-testid="avatar" />,
}))

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', () => ({
    matches,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

function renderMenu(
  overrides: Partial<Parameters<typeof SidebarAccountMenu>[0]> = {},
) {
  const onOpenSettings = vi.fn()
  const onReportBug = vi.fn()
  const onSync = vi.fn().mockResolvedValue(true)
  render(
    <SidebarAccountMenu
      isSidebarOpen
      isSignedIn
      isPremium={false}
      isDarkMode={false}
      canSync
      isSyncing={false}
      syncFailed={false}
      syncNeedsAttention={false}
      onSync={onSync}
      onOpenSettings={onOpenSettings}
      onReportBug={onReportBug}
      {...overrides}
    />,
  )
  return { onOpenSettings, onReportBug, onSync }
}

describe('SidebarAccountMenu', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  beforeEach(() => {
    userState = {
      user: {
        firstName: 'Ada',
        emailAddresses: [{ emailAddress: 'ada@example.com' }],
      },
    }
    // jsdom has no matchMedia; treat the test environment as a touch device
    // so hover never opens the menu and clicks drive everything.
    stubMatchMedia(false)
  })

  it('shows the first name and opens settings from the menu', () => {
    const { onOpenSettings } = renderMenu()

    const trigger = screen.getByRole('button', { name: /Ada/ })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }))
    expect(onOpenSettings).toHaveBeenCalledWith('general')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('routes settings to cloud sync when sync needs attention', () => {
    const { onOpenSettings } = renderMenu({ syncNeedsAttention: true })

    fireEvent.click(screen.getByRole('button', { name: /Ada/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }))
    expect(onOpenSettings).toHaveBeenCalledWith('cloud-sync')
  })

  it('reveals help links and the bug report action in a submenu', () => {
    const { onReportBug } = renderMenu()

    fireEvent.click(screen.getByRole('button', { name: /Ada/ }))
    expect(screen.queryByRole('menu', { name: 'Help' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Help' }))
    const help = screen.getByRole('menu', { name: 'Help' })
    expect(help).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: /Terms of Service/ }),
    ).toHaveAttribute('href', TERMS_URL)
    expect(
      screen.getByRole('menuitem', { name: /Privacy Policy/ }),
    ).toHaveAttribute('href', PRIVACY_POLICY_URL)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Report a bug' }))
    expect(onReportBug).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('triggers a manual sync without closing the menu', async () => {
    vi.useFakeTimers()
    const { onSync } = renderMenu()

    fireEvent.click(screen.getByRole('button', { name: /Ada/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Sync cloud data/ }))

    expect(onSync).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        CONSTANTS.SIDEBAR_SYNC_MIN_SPINNER_MS +
          CONSTANTS.SIDEBAR_SYNC_SUCCESS_FEEDBACK_MS,
      )
    })
    expect(
      screen.getByRole('menuitem', { name: /Sync cloud data. Sync healthy/ }),
    ).toBeEnabled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('removes both menus when the parent sidebar closes and does not reopen them automatically', () => {
    const props = {
      isSignedIn: true,
      isPremium: false,
      isDarkMode: false,
      canSync: false,
      isSyncing: false,
      syncFailed: false,
      syncNeedsAttention: false,
      onOpenSettings: vi.fn(),
      onReportBug: vi.fn(),
    }
    const { rerender } = render(<SidebarAccountMenu {...props} isSidebarOpen />)
    fireEvent.click(screen.getByRole('button', { name: 'Ada' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Help' }))
    expect(screen.getAllByRole('menu')).toHaveLength(2)
    rerender(<SidebarAccountMenu {...props} isSidebarOpen={false} />)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    rerender(<SidebarAccountMenu {...props} isSidebarOpen />)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ada' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  it('uses distinct trigger IDs for multiple instances', () => {
    renderMenu()
    renderMenu()
    const triggers = screen.getAllByRole('button', { name: 'Ada' })
    expect(triggers[0].id).not.toBe(triggers[1].id)
    fireEvent.click(triggers[0])
    expect(screen.getByRole('menu')).toHaveAttribute(
      'aria-labelledby',
      triggers[0].id,
    )
  })

  it('activates the sign-in menu link with Space', () => {
    userState = { user: null }
    const { onOpenSettings } = renderMenu({ isSignedIn: false, canSync: false })
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    const signIn = screen.getByRole('menuitem', { name: 'Sign in' })
    const click = vi.fn((event: Event) => event.preventDefault())
    window.addEventListener('click', click, { once: true })
    fireEvent.keyDown(signIn, { key: ' ' })
    expect(click).toHaveBeenCalledTimes(1)
    expect(onOpenSettings).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('hides sync for signed-out users and offers sign in instead', () => {
    userState = { user: null }
    renderMenu({ isSignedIn: false, canSync: false, onSync: undefined })

    fireEvent.click(screen.getByRole('button', { name: /Menu/ }))
    expect(
      screen.getByRole('menuitem', { name: 'Sign in' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('menuitem', { name: /Sync cloud data/ }),
    ).not.toBeInTheDocument()
  })

  it('links directly to sign in with the return URL instead of opening account settings', () => {
    userState = { user: null }
    const { onOpenSettings } = renderMenu({ isSignedIn: false, canSync: false })
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    const signIn = screen.getByRole('menuitem', { name: 'Sign in' })
    expect(signIn.tagName).toBe('A')
    expect(signIn).toHaveAttribute(
      'href',
      '/signin?redirect_url=%2Fc%2Fchat-1%3Fview%3Dcompact%23bottom',
    )
    window.addEventListener('click', (event) => event.preventDefault(), {
      once: true,
    })
    fireEvent.click(signIn)
    expect(onOpenSettings).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('still opens account settings for signed-in users', () => {
    const { onOpenSettings } = renderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Ada' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Account' }))
    expect(onOpenSettings).toHaveBeenCalledWith('account')
  })

  it('closes on Escape and on outside clicks', () => {
    renderMenu()

    const trigger = screen.getByRole('button', { name: /Ada/ })
    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.click(trigger)
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('focuses and wraps menu items with the keyboard and navigates the Help submenu', () => {
    renderMenu()
    const trigger = screen.getByRole('button', { name: 'Ada' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const account = screen.getByRole('menuitem', { name: 'Account' })
    const help = screen.getByRole('menuitem', { name: 'Help' })
    expect(account).toHaveFocus()
    fireEvent.keyDown(account, { key: 'ArrowUp' })
    expect(help).toHaveFocus()
    fireEvent.keyDown(help, { key: 'Home' })
    expect(account).toHaveFocus()
    fireEvent.keyDown(account, { key: 'End' })
    expect(help).toHaveFocus()
    fireEvent.keyDown(help, { key: 'ArrowRight' })
    const terms = screen.getByRole('menuitem', { name: 'Terms of Service' })
    expect(terms).toHaveFocus()
    fireEvent.keyDown(terms, { key: 'ArrowDown' })
    const privacy = screen.getByRole('menuitem', { name: 'Privacy Policy' })
    expect(privacy).toHaveFocus()
    fireEvent.keyDown(privacy, { key: 'Escape' })
    expect(help).toHaveFocus()
    expect(screen.queryByRole('menu', { name: 'Help' })).not.toBeInTheDocument()
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(help, { key: 'Escape' })
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('skips disabled actions and lets Tab leave the menu', () => {
    renderMenu({ isSyncing: true })
    const trigger = screen.getByRole('button', { name: 'Ada' })
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })
    const help = screen.getByRole('menuitem', { name: 'Help' })
    expect(help).toHaveFocus()
    fireEvent.keyDown(help, { key: 'ArrowUp' })
    const settings = screen.getByRole('menuitem', { name: 'Settings' })
    expect(settings).toHaveFocus()
    expect(fireEvent.keyDown(settings, { key: 'Tab' })).toBe(true)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  describe('desktop pointer interactions', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      stubMatchMedia(true)
    })

    function openWithMouse() {
      renderMenu()
      const trigger = screen.getByRole('button', { name: /Ada/ })
      fireEvent.pointerOver(trigger, { pointerType: 'mouse' })
      const panel = screen.getByRole('menu', { name: /Ada/ })
      const help = screen.getByRole('menuitem', { name: 'Help' })
      vi.spyOn(trigger.parentElement!, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(16, 600, 256, 40),
      )
      vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(16, 300, 256, 292),
      )
      fireEvent.pointerOut(trigger, {
        relatedTarget: help,
        pointerType: 'mouse',
      })
      fireEvent.pointerOver(help, {
        relatedTarget: trigger,
        pointerType: 'mouse',
      })
      const flyout = screen.getByRole('menu', { name: 'Help' })
      vi.spyOn(flyout, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(280, 460, 224, 132),
      )
      return { trigger, panel, help, flyout }
    }

    function waitForCloseGrace() {
      act(() => {
        vi.advanceTimersByTime(CONSTANTS.SIDEBAR_MENU_HOVER_CLOSE_DELAY_MS + 1)
      })
    }

    it('does not toggle a hover-opened menu closed when the mouse clicks its trigger', () => {
      const { trigger, panel } = openWithMouse()
      fireEvent.pointerDown(trigger, { pointerType: 'mouse' })
      fireEvent.click(trigger, { detail: 1 })
      expect(trigger).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByRole('menu', { name: /Ada/ })).toBe(panel)
    })

    it('keeps Help open when clicking its already hovered trigger', () => {
      const { help, flyout } = openWithMouse()
      fireEvent.pointerDown(help, { pointerType: 'mouse' })
      fireEvent.click(help, { detail: 1 })
      expect(help).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByRole('menu', { name: 'Help' })).toBe(flyout)
    })

    it('changes the Help highlight without retaining faded flyouts during repeated row switches', () => {
      const { help, panel } = openWithMouse()
      const settings = screen.getByRole('menuitem', { name: 'Settings' })
      for (let pass = 0; pass < 10; pass += 1) {
        fireEvent.pointerOut(help, {
          relatedTarget: settings,
          pointerType: 'mouse',
        })
        fireEvent.pointerOver(settings, {
          relatedTarget: help,
          pointerType: 'mouse',
        })
        expect(help).not.toHaveClass('bg-surface-chat')
        expect(
          screen.queryByRole('menu', { name: 'Help' }),
        ).not.toBeInTheDocument()
        fireEvent.pointerOut(settings, {
          relatedTarget: help,
          pointerType: 'mouse',
        })
        fireEvent.pointerOver(help, {
          relatedTarget: settings,
          pointerType: 'mouse',
        })
        expect(help).toHaveClass('bg-surface-chat')
        expect(screen.getAllByRole('menu', { name: 'Help' })).toHaveLength(1)
        expect(screen.getByRole('menu', { name: /Ada/ })).toBe(panel)
      }
    })

    it('keeps the same panels mounted across the gap, flyout contents, and tolerance margin', () => {
      const { help, panel, flyout } = openWithMouse()
      const privacy = screen.getByRole('menuitem', { name: /Privacy Policy/ })
      fireEvent.pointerOut(help, {
        relatedTarget: privacy,
        pointerType: 'mouse',
      })
      fireEvent.pointerOver(privacy, {
        relatedTarget: help,
        pointerType: 'mouse',
      })
      const path = [
        { target: document.body, x: 276, y: 560 },
        { target: privacy.querySelector('svg')!, x: 310, y: 510 },
        {
          target: document.body,
          x: 504 + CONSTANTS.SIDEBAR_MENU_HOVER_TOLERANCE_PX - 1,
          y: 510,
        },
      ]
      for (const { target, x, y } of path) {
        fireEvent.pointerMove(target, {
          clientX: x,
          clientY: y,
          pointerType: 'mouse',
        })
        waitForCloseGrace()
        expect(screen.getByRole('menu', { name: /Ada/ })).toBe(panel)
        expect(screen.getByRole('menu', { name: 'Help' })).toBe(flyout)
      }
    })

    it('removes Help immediately on entering Settings without remounting the main panel', () => {
      const { help, panel, flyout } = openWithMouse()
      const settings = screen.getByRole('menuitem', { name: 'Settings' })
      fireEvent.pointerOut(help, {
        relatedTarget: settings,
        pointerType: 'mouse',
      })
      fireEvent.pointerOver(settings, {
        relatedTarget: help,
        pointerType: 'mouse',
      })
      fireEvent.pointerMove(settings, {
        clientX: 100,
        clientY: 420,
        pointerType: 'mouse',
      })
      expect(flyout).not.toBeInTheDocument()
      expect(help).toHaveAttribute('aria-expanded', 'false')
      expect(screen.getByRole('menu', { name: /Ada/ })).toBe(panel)
    })

    it('cancels a pending close when the pointer returns and closes after a real departure', () => {
      const { panel } = openWithMouse()
      fireEvent.pointerMove(document.body, {
        clientX: 900,
        clientY: 200,
        pointerType: 'mouse',
      })
      act(() => {
        vi.advanceTimersByTime(CONSTANTS.SIDEBAR_MENU_HOVER_CLOSE_DELAY_MS - 1)
      })
      fireEvent.pointerMove(panel, {
        clientX: 100,
        clientY: 400,
        pointerType: 'mouse',
      })
      waitForCloseGrace()
      expect(panel).toBeInTheDocument()
      fireEvent.pointerMove(document.body, {
        clientX: 900,
        clientY: 200,
        pointerType: 'mouse',
      })
      waitForCloseGrace()
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('does not interpret touch movement as mouse hover on a hybrid device', () => {
      renderMenu()
      const trigger = screen.getByRole('button', { name: /Ada/ })
      fireEvent.pointerOver(trigger, { pointerType: 'touch' })
      expect(trigger).toHaveAttribute('aria-expanded', 'false')
      fireEvent.pointerDown(trigger, { pointerType: 'touch' })
      fireEvent.click(trigger, { detail: 1 })
      expect(trigger).toHaveAttribute('aria-expanded', 'true')
      fireEvent.pointerMove(document.body, {
        clientX: 900,
        clientY: 200,
        pointerType: 'touch',
      })
      waitForCloseGrace()
      expect(trigger).toHaveAttribute('aria-expanded', 'true')
      fireEvent.pointerDown(trigger, { pointerType: 'touch' })
      fireEvent.click(trigger, { detail: 1 })
      expect(trigger).toHaveAttribute('aria-expanded', 'false')
    })
  })
})
