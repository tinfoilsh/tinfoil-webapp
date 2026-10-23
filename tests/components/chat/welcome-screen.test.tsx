import { WelcomeScreen } from '@/components/chat/WelcomeScreen'
import { PRIVACY_POLICY_URL, TERMS_URL } from '@/constants/external-links'
import { publish } from '@/services/harness/runtime'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signIn } from '../../harness-fixture'

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

function renderWelcome() {
  return render(
    <WelcomeScreen
      isDarkMode={false}
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

  it('shows the notice with legal links', () => {
    renderWelcome()

    expect(
      screen.getByText(/By using this chat, you agree to our/),
    ).toHaveTextContent(
      'By using this chat, you agree to our Terms of Service and Privacy Policy.',
    )
    expect(
      screen.getByRole('link', { name: 'Terms of Service' }),
    ).toHaveAttribute('href', TERMS_URL)
    expect(
      screen.getByRole('link', { name: 'Privacy Policy' }),
    ).toHaveAttribute('href', PRIVACY_POLICY_URL)
  })

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

describe('welcome greeting', () => {
  const MORNING = new Date(2026, 9, 23, 9, 0)

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(MORNING)
    auth.user = { id: 'alice', firstName: 'Alex' }
    auth.isSignedIn = true
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('greets with the nickname saved in Settings, as it changes', () => {
    signIn({ profile: { nickname: 'Sam' } })
    renderWelcome()

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Good morning, Sam!',
    )

    act(() => publish({ profile: { nickname: 'Pat' } }))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Good morning, Pat!',
    )

    act(() => publish({ profile: { nickname: '' } }))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Good morning, Alex!',
    )
  })

  it('leaves a signed-out visitor ungreeted by name', () => {
    auth.user = null
    auth.isSignedIn = false
    signIn({ userId: null, profile: { nickname: 'Sam' } })
    renderWelcome()

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Tinfoil Chat',
    )
  })
})
