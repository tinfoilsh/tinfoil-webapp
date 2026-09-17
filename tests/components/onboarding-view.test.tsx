import { OnboardingView } from '@/components/onboarding/onboarding-view'
import { SETTINGS_HAS_SEEN_ONBOARDING } from '@/constants/storage-keys'
import OnboardingFlowDevPage from '@/pages/dev/onboarding-flow'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  useUser: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('@clerk/nextjs', () => ({
  useUser: mocks.useUser,
}))

vi.mock('@/config', () => ({
  IS_DEV: true,
}))

vi.mock('@/utils/error-handling', () => ({
  logError: mocks.logError,
}))

describe('OnboardingView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useUser.mockReturnValue({ user: null })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reserves space for the intro artwork', () => {
    render(<OnboardingView onComplete={vi.fn()} />)

    expect(
      screen.getByRole('img', {
        name: 'A garden seen through a porthole in a dense city',
      }),
    ).toHaveAttribute('width', '1024')
    expect(
      screen.getByRole('img', {
        name: 'A garden seen through a porthole in a dense city',
      }),
    ).toHaveAttribute('height', '338')
  })

  it('emphasizes that the private space belongs to the user', () => {
    render(<OnboardingView onComplete={vi.fn()} />)

    const emphasizedWord = screen.getByText('your')
    expect(emphasizedWord.tagName).toBe('EM')
    expect(emphasizedWord.parentElement).toHaveTextContent(
      'This is your space to explore ideas in private.',
    )
  })

  it('shows safeguards last and only persists completion after Get Started', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    mocks.useUser.mockReturnValue({
      user: { unsafeMetadata: { existing: true }, update },
    })
    const onComplete = vi.fn()
    render(<OnboardingView onComplete={onComplete} />)

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Private, by Design.' })
    fireEvent.click(screen.getByRole('button', { name: 'Toggle privacy' }))
    expect(
      screen.queryByRole('button', { name: 'Get Started' }),
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(
      await screen.findByRole('heading', { name: 'Tending the Garden' }),
    ).toBeInTheDocument()
    const learnMoreLink = screen.getByRole('link', {
      name: 'Learn more about safeguards',
    })
    expect(learnMoreLink).toHaveAttribute(
      'href',
      'https://tinfoil.sh/safety-and-safeguards',
    )
    expect(learnMoreLink).toHaveAttribute('target', '_blank')
    expect(learnMoreLink).toHaveAttribute('rel', 'noopener noreferrer')
    expect(learnMoreLink.closest('p')).toBeNull()
    const privacyEmphasis = screen.getByText(
      'Tinfoil cannot see the nature of the violation or conversation content.',
    )
    expect(privacyEmphasis.tagName).toBe('STRONG')
    expect(privacyEmphasis).toHaveClass('font-semibold')
    const introduction = privacyEmphasis.closest('p')
    expect(introduction).toHaveTextContent(
      'Privacy-preserving safeguards review the AI responses in this chat. The safeguards run inside secure enclaves at inference time, always keeping your conversations private. Tinfoil cannot see the nature of the violation or conversation content.',
    )
    expect(introduction).toHaveClass('text-balance')
    expect(introduction?.nextElementSibling).toBe(learnMoreLink)
    expect(
      screen.queryByText(/you will be notified of the flagging/),
    ).not.toBeInTheDocument()
    expect(onComplete).not.toHaveBeenCalled()
    expect(localStorage.getItem(SETTINGS_HAS_SEEN_ONBOARDING)).toBeNull()
    expect(update).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Get Started' }))
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(SETTINGS_HAS_SEEN_ONBOARDING)).toBe('true')
    expect(update).toHaveBeenCalledWith({
      unsafeMetadata: { existing: true, has_completed_onboarding: true },
    })
  })

  it('shows safeguards in the dev flow and reopens without persisting completion', async () => {
    const update = vi.fn()
    mocks.useUser.mockReturnValue({
      user: { unsafeMetadata: {}, update },
    })
    render(<OnboardingFlowDevPage />)

    fireEvent.click(
      await screen.findByRole('button', { name: /Open onboarding/ }),
    )
    expect(
      await screen.findByRole('heading', { name: 'Why Tinfoil Chat' }),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Private, by Design.' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(
      await screen.findByRole('heading', { name: 'Tending the Garden' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Get Started' }))

    expect(screen.getByText('onComplete()')).toBeInTheDocument()
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: 'Tending the Garden' }),
      ).not.toBeInTheDocument()
    })
    expect(localStorage.getItem(SETTINGS_HAS_SEEN_ONBOARDING)).toBeNull()
    expect(update).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Open onboarding/ }))
    expect(
      await screen.findByRole('heading', { name: 'Why Tinfoil Chat' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Private, by Design.' })
    expect(
      screen.getByRole('button', { name: 'Toggle privacy' }),
    ).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(
      await screen.findByRole('heading', { name: 'Tending the Garden' }),
    ).toBeInTheDocument()
  })

  it('enables privacy when Continue is pressed without toggling', async () => {
    const onComplete = vi.fn()
    render(<OnboardingView onComplete={onComplete} persistCompletion={false} />)

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(
      await screen.findByRole('heading', { name: 'Private, by Design.' }),
    ).toBeInTheDocument()

    const privacySwitch = screen.getByRole('button', {
      name: 'Toggle privacy',
    })
    expect(privacySwitch).toHaveAttribute('aria-pressed', 'false')

    const continueBtn = screen.getByRole('button', { name: 'Continue' })
    fireEvent.click(continueBtn)
    expect(onComplete).not.toHaveBeenCalled()
    expect(privacySwitch).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Tending the Garden' })
    expect(onComplete).not.toHaveBeenCalled()
    const getStarted = screen.getByRole('button', { name: 'Get Started' })
    fireEvent.click(getStarted)
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('does not enable privacy automatically', async () => {
    render(<OnboardingView onComplete={vi.fn()} persistCompletion={false} />)

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Private, by Design.' })

    const privacySwitch = screen.getByRole('button', {
      name: 'Toggle privacy',
    })
    expect(privacySwitch).toHaveAttribute('aria-pressed', 'false')
  })

  it('logs metadata failures without blocking completion', async () => {
    const error = new Error('Clerk unavailable')
    const update = vi.fn().mockRejectedValue(error)
    mocks.useUser.mockReturnValue({
      user: { unsafeMetadata: {}, update },
    })
    const onComplete = vi.fn()
    render(<OnboardingView onComplete={onComplete} />)

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Private, by Design.' })

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Tending the Garden' })
    fireEvent.click(screen.getByRole('button', { name: 'Get Started' }))

    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(SETTINGS_HAS_SEEN_ONBOARDING)).toBe('true')
    await waitFor(() => {
      expect(mocks.logError).toHaveBeenCalledWith(
        'Could not persist onboarding completion',
        error,
        {
          component: 'OnboardingView',
          action: 'markCompleted',
        },
      )
    })
  })
})
