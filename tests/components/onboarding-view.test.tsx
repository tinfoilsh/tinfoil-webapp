import { OnboardingView } from '@/components/onboarding/onboarding-view'
import { SETTINGS_HAS_SEEN_ONBOARDING } from '@/constants/storage-keys'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  useUser: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('@clerk/nextjs', () => ({
  useUser: mocks.useUser,
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
