/**
 * Tests for the "Local computer driver detected — pair to enable" banner.
 *   - show=false: renders nothing.
 *   - show=true: renders, Connect fires the handler, X dismisses for the page.
 *   - After dismissal: stays hidden until sessionStorage is cleared.
 */
import { ComputerUseConnectBanner } from '@/components/chat/ComputerUseConnectBanner'
import { fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('ComputerUseConnectBanner', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })
  afterEach(() => {
    window.sessionStorage.clear()
  })

  it('renders nothing when show=false', () => {
    const { container } = render(
      <ComputerUseConnectBanner
        show={false}
        onConnect={() => {}}
        isDarkMode={false}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders the copy and a Connect button when show=true', () => {
    const { getByText, getByRole } = render(
      <ComputerUseConnectBanner
        show={true}
        onConnect={() => {}}
        isDarkMode={false}
      />,
    )
    expect(getByText(/Local computer driver detected/)).toBeDefined()
    expect(getByRole('button', { name: 'Connect' })).toBeDefined()
  })

  it('Connect button calls onConnect', () => {
    const onConnect = vi.fn()
    const { getByRole } = render(
      <ComputerUseConnectBanner
        show={true}
        onConnect={onConnect}
        isDarkMode={false}
      />,
    )
    fireEvent.click(getByRole('button', { name: 'Connect' }))
    expect(onConnect).toHaveBeenCalledOnce()
  })

  it('Dismiss hides the banner and writes a sessionStorage flag', () => {
    const { getByRole, queryByText } = render(
      <ComputerUseConnectBanner
        show={true}
        onConnect={() => {}}
        isDarkMode={false}
      />,
    )
    expect(queryByText(/Local computer driver detected/)).toBeTruthy()
    fireEvent.click(getByRole('button', { name: 'Dismiss' }))
    expect(queryByText(/Local computer driver detected/)).toBeNull()
    expect(
      window.sessionStorage.getItem(
        'tinfoil-computer-use-connect-banner-dismissed',
      ),
    ).toBe('1')
  })

  it('Stays hidden on subsequent renders when sessionStorage flag is set', () => {
    window.sessionStorage.setItem(
      'tinfoil-computer-use-connect-banner-dismissed',
      '1',
    )
    const { container } = render(
      <ComputerUseConnectBanner
        show={true}
        onConnect={() => {}}
        isDarkMode={false}
      />,
    )
    expect(container.firstChild).toBeNull()
  })
})
