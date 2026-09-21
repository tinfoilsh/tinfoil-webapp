import { SafeguardFlagBanner } from '@/components/chat/safeguard-flag-banner'
import { useSafeguards } from '@/hooks/use-safeguards'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-safeguards', () => ({ useSafeguards: vi.fn() }))

function setFlags() {
  vi.mocked(useSafeguards).mockReturnValue({
    hasLoaded: true,
    flaggedChats: [],
    flaggedChatIds: { 'flagged-chat': true },
    policy: null,
    status: 'ready',
  })
}

describe('SafeguardFlagBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setFlags()
  })

  it('warns on the selected flagged chat and provides the settings action', () => {
    const onOpenSettings = vi.fn()
    render(
      <SafeguardFlagBanner
        chatId="flagged-chat"
        isDarkMode
        onOpenSettings={onOpenSettings}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This chat was flagged by a safeguard model.',
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This chat is now read-only. Start a new chat to continue.',
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Learn more in Settings → Safeguards',
      }),
    )
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('disappears when switching to a chat that is not flagged', () => {
    const { rerender } = render(
      <SafeguardFlagBanner chatId="flagged-chat" isDarkMode />,
    )
    expect(screen.getByRole('alert')).toBeVisible()
    rerender(<SafeguardFlagBanner chatId="other-chat" isDarkMode />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not distinguish mock flags: the banner is identical to production', () => {
    render(<SafeguardFlagBanner chatId="flagged-chat" isDarkMode={false} />)
    // No "Local preview" or "simulated flag" wording is rendered anywhere.
    expect(screen.queryByText(/Local preview/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/simulated/i)).not.toBeInTheDocument()
    expect(
      screen.getByText('Sign in to view Settings → Safeguards.'),
    ).toBeVisible()
  })
})
