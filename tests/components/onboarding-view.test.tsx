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

async function advanceToPrivacy() {
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await screen.findByRole('heading', { name: 'Private, by Design.' })
}

async function advanceToSafeguards() {
  await advanceToPrivacy()
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await screen.findByRole('heading', { name: 'Tending the Garden' })
}

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

  it('emphasizes the opening sentence', () => {
    render(<OnboardingView onComplete={vi.fn()} />)

    expect(
      screen.getByText('Tinfoil Chat was built as a sanctuary for thought.')
        .tagName,
    ).toBe('STRONG')
    expect(
      screen.getByText('Tinfoil Chat was built as a sanctuary for thought.'),
    ).toHaveClass('text-content-primary')
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

    await advanceToPrivacy()
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
    expect(document.querySelector('svg.text-tinfoil-accent-blue')).toHaveClass(
      'dark:text-white',
    )
    const safeguardsParagraphs = [
      'Privacy-preserving safeguards review AI responses for safety.',
      'Safeguards run inside secure enclaves at inference time, keeping your conversations private and notifying you in case of a flag.',
      'Tinfoil never sees conversation content or nature of the flag raised.',
    ].map((text) => screen.getByText(text).closest('p'))
    for (const paragraph of safeguardsParagraphs) {
      expect(paragraph).toBeInTheDocument()
    }
    expect(new Set(safeguardsParagraphs).size).toBe(3)
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

    await advanceToSafeguards()
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
    await advanceToPrivacy()
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

    await advanceToPrivacy()

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

    await advanceToPrivacy()

    const privacySwitch = screen.getByRole('button', {
      name: 'Toggle privacy',
    })
    expect(privacySwitch).toHaveAttribute('aria-pressed', 'false')
  })

  it.each(['SecurityError', 'QuotaExceededError'])(
    'finishes onboarding and updates the account when local storage throws %s',
    async (errorName) => {
      const error = new DOMException('Storage unavailable', errorName)
      const update = vi.fn().mockResolvedValue(undefined)
      mocks.useUser.mockReturnValue({
        user: { unsafeMetadata: { existing: true }, update },
      })
      const onComplete = vi.fn()
      render(<OnboardingView onComplete={onComplete} />)
      await advanceToSafeguards()

      vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
        throw error
      })
      fireEvent.click(screen.getByRole('button', { name: 'Get Started' }))

      expect(onComplete).toHaveBeenCalledTimes(1)
      expect(localStorage.getItem(SETTINGS_HAS_SEEN_ONBOARDING)).toBeNull()
      expect(mocks.logError).toHaveBeenCalledWith(
        'Could not persist local onboarding completion',
        error,
        {
          component: 'OnboardingView',
          action: 'markCompleted',
        },
      )
      expect(update).toHaveBeenCalledWith({
        unsafeMetadata: { existing: true, has_completed_onboarding: true },
      })
    },
  )

  it('logs metadata failures without blocking completion', async () => {
    const error = new Error('Clerk unavailable')
    const update = vi.fn().mockRejectedValue(error)
    mocks.useUser.mockReturnValue({
      user: { unsafeMetadata: {}, update },
    })
    const onComplete = vi.fn()
    render(<OnboardingView onComplete={onComplete} />)

    await advanceToSafeguards()
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
