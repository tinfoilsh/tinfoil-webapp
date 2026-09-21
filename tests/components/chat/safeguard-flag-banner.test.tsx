import { SafeguardFlagBanner } from '@/components/chat/safeguard-flag-banner'
import { useSafeguards } from '@/hooks/use-safeguards'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-safeguards', () => ({ useSafeguards: vi.fn() }))

function setFlags(isPreview = false) {
  vi.mocked(useSafeguards).mockReturnValue({
    flaggedChats: [],
    flaggedChatIds: { 'flagged-chat': true },
    policy: null,
    status: 'ready',
    isPreview,
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

  it('clearly distinguishes simulated flags and keeps signed-in settings unavailable to guests', () => {
    setFlags(true)
    render(<SafeguardFlagBanner chatId="flagged-chat" isDarkMode={false} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Local preview:')
    expect(
      screen.getByText('This is a simulated flag. Your account is unaffected.'),
    ).toBeVisible()
    expect(
      screen.getByText('Sign in to view Settings → Safeguards.'),
    ).toBeVisible()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
