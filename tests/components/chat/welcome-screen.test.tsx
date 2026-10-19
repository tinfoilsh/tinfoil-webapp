import { WelcomeScreen } from '@/components/chat/WelcomeScreen'
import { PRIVACY_POLICY_URL, TERMS_URL } from '@/constants/external-links'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { auth } = vi.hoisted(() => ({
  auth: {
    user: null as { id: string; firstName: string } | null | undefined,
    isSignedIn: false as boolean | undefined,
  },
}))

vi.mock('@clerk/react', () => ({ useUser: () => auth }))
vi.mock('@/components/chat/chat-input', () => ({ ChatInput: () => null }))
vi.mock('@/components/chat/model-selector', () => ({
  ModelSelector: () => null,
}))
vi.mock('@/components/chat/hooks/use-prompt-library', () => ({
  usePromptLibrary: () => ({ favoritePresets: [] }),
}))

function renderWelcome(isDarkMode = false) {
  return render(
    <WelcomeScreen
      isDarkMode={isDarkMode}
      autoIntelligence="high"
      setAutoIntelligence={vi.fn()}
      onOpenPromptLibrary={vi.fn()}
      onSelectPromptPreset={vi.fn()}
    />,
  )
}

describe('anonymous welcome legal notice', () => {
  beforeEach(() => {
    auth.user = null
    auth.isSignedIn = false
  })

  it.each([false, true])(
    'shows the notice below prompt choices with legal links (dark mode: %s)',
    (isDarkMode) => {
      renderWelcome(isDarkMode)

      const notice = screen.getByText(/By using this chat, you agree to our/)
      expect(notice).toHaveTextContent(
        'By using this chat, you agree to our Terms of Service and Privacy Policy.',
      )
      expect(
        screen
          .getByRole('button', { name: 'More' })
          .compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()

      for (const [name, href] of [
        ['Terms of Service', TERMS_URL],
        ['Privacy Policy', PRIVACY_POLICY_URL],
      ]) {
        const link = screen.getByRole('link', { name })
        expect(link).toHaveAttribute('href', href)
        expect(link).toHaveAttribute('target', '_blank')
        expect(link).toHaveAttribute('rel', 'noopener noreferrer')
      }
    },
  )

  it('does not show the notice to signed-in users', () => {
    auth.user = { id: 'user-test', firstName: 'Alex' }
    auth.isSignedIn = true
    renderWelcome()

    expect(screen.queryByText(/By using this chat/)).not.toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: 'Terms of Service' }),
    ).not.toBeInTheDocument()
  })

  it('waits for authentication to resolve before showing the notice', () => {
    auth.user = undefined
    auth.isSignedIn = undefined
    renderWelcome()

    expect(screen.queryByText(/By using this chat/)).not.toBeInTheDocument()
  })
})
