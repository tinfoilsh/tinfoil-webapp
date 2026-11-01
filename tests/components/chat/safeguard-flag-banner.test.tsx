import { SafeguardFlagBanner } from '@/components/chat/safeguard-flag-banner'
import { useSafeguards } from '@/hooks/use-safeguards'
import { render, screen } from '@testing-library/react'
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

  it('disappears when switching to a chat that is not flagged', () => {
    const { rerender } = render(
      <SafeguardFlagBanner chatId="flagged-chat" isDarkMode />,
    )
    expect(screen.getByRole('alert')).toBeVisible()
    rerender(<SafeguardFlagBanner chatId="other-chat" isDarkMode />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
