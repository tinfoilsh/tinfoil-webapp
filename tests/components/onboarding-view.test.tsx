import { OnboardingView } from '@/components/onboarding/onboarding-view'
import { SETTINGS_HAS_SEEN_ONBOARDING } from '@/constants/storage-keys'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  useUser: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('@clerk/react', () => ({
  useUser: mocks.useUser,
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

  it('shows safeguards and completes without persisting when persistence is off', async () => {
    const update = vi.fn()
    mocks.useUser.mockReturnValue({
      user: { unsafeMetadata: {}, update },
    })
    const onComplete = vi.fn()
    render(<OnboardingView onComplete={onComplete} persistCompletion={false} />)

    await advanceToSafeguards()
    fireEvent.click(screen.getByRole('button', { name: 'Get Started' }))

    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(SETTINGS_HAS_SEEN_ONBOARDING)).toBeNull()
    expect(update).not.toHaveBeenCalled()
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

  it('finishes onboarding and updates the account when local storage throws', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    mocks.useUser.mockReturnValue({
      user: { unsafeMetadata: { existing: true }, update },
    })
    const onComplete = vi.fn()
    render(<OnboardingView onComplete={onComplete} />)
    await advanceToSafeguards()

    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage unavailable', 'SecurityError')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Get Started' }))

    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(SETTINGS_HAS_SEEN_ONBOARDING)).toBeNull()
    expect(update).toHaveBeenCalledWith({
      unsafeMetadata: { existing: true, has_completed_onboarding: true },
    })
  })

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
