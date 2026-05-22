/**
 * Tests for the post-pair, pre-image setup-sandbox banner. Covers:
 *   - idle (no job): shows "Set up your sandbox" + Start button
 *   - pulling: shows label + progress bar + percentage when known
 *   - pulling without percent: indeterminate bar (no % rendered)
 *   - provisioning: indeterminate bar (no percent source)
 *   - done: brief success label, no bar
 *   - error: error message + Retry button
 *   - dismiss: sessionStorage flag, hides on next render
 */
import { ComputerUseSetupSandboxBanner } from '@/components/chat/ComputerUseSetupSandboxBanner'
import type { BrokerSetupJob } from '@/services/computer-use'
import { fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('ComputerUseSetupSandboxBanner', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })
  afterEach(() => {
    window.sessionStorage.clear()
  })

  it('renders nothing when show=false', () => {
    const { container } = render(
      <ComputerUseSetupSandboxBanner
        show={false}
        onStart={() => {}}
        isDarkMode={false}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('idle: shows "Set up your sandbox" with a Start button', () => {
    const onStart = vi.fn()
    const { getByText, getByRole } = render(
      <ComputerUseSetupSandboxBanner
        show
        onStart={onStart}
        isDarkMode={false}
      />,
    )
    expect(getByText(/Set up your sandbox/)).toBeDefined()
    fireEvent.click(getByRole('button', { name: 'Start' }))
    expect(onStart).toHaveBeenCalledOnce()
  })

  it('pulling with a known fraction: shows percent + label', () => {
    const job: BrokerSetupJob = {
      state: 'pulling',
      image: 'tinfoil-default',
      progress: 0.43,
      message: 'Layer 3 of 6',
    }
    const { getByText } = render(
      <ComputerUseSetupSandboxBanner
        show
        job={job}
        onStart={() => {}}
        isDarkMode={false}
      />,
    )
    expect(getByText('Pulling base image…')).toBeDefined()
    expect(getByText('43%')).toBeDefined()
    expect(getByText('Layer 3 of 6')).toBeDefined()
  })

  it('pulling without a fraction: no percent rendered (indeterminate)', () => {
    const job: BrokerSetupJob = {
      state: 'pulling',
      image: 'tinfoil-default',
      message: 'Resolving manifest…',
    }
    const { queryByText } = render(
      <ComputerUseSetupSandboxBanner
        show
        job={job}
        onStart={() => {}}
        isDarkMode={false}
      />,
    )
    // No `NN%` text on indeterminate.
    expect(queryByText(/^\d{1,3}%$/)).toBeNull()
  })

  it('provisioning: shows the provisioning label and no percent', () => {
    const job: BrokerSetupJob = {
      state: 'provisioning',
      image: 'tinfoil-default',
      message: 'Installing guest agent',
    }
    const { getByText, queryByText } = render(
      <ComputerUseSetupSandboxBanner
        show
        job={job}
        onStart={() => {}}
        isDarkMode={false}
      />,
    )
    expect(getByText('Provisioning sandbox…')).toBeDefined()
    expect(queryByText(/^\d{1,3}%$/)).toBeNull()
  })

  it('done: brief success label, no Start button', () => {
    const job: BrokerSetupJob = {
      state: 'done',
      image: 'tinfoil-default',
      message: 'Image ready',
    }
    const { getByText, queryByRole } = render(
      <ComputerUseSetupSandboxBanner
        show
        job={job}
        onStart={() => {}}
        isDarkMode={false}
      />,
    )
    expect(getByText('Sandbox ready!')).toBeDefined()
    expect(queryByRole('button', { name: 'Start' })).toBeNull()
  })

  it('error: shows the error + a Retry button', () => {
    const onStart = vi.fn()
    const job: BrokerSetupJob = {
      state: 'error',
      image: 'tinfoil-default',
      error: 'disk full',
    }
    const { getByText, getByRole } = render(
      <ComputerUseSetupSandboxBanner
        show
        job={job}
        onStart={onStart}
        isDarkMode={false}
      />,
    )
    expect(getByText('Setup failed')).toBeDefined()
    expect(getByText('disk full')).toBeDefined()
    fireEvent.click(getByRole('button', { name: 'Retry' }))
    expect(onStart).toHaveBeenCalledOnce()
  })

  it('dismiss hides the banner and persists the choice for the session', () => {
    const { getByRole, queryByText, rerender } = render(
      <ComputerUseSetupSandboxBanner
        show
        onStart={() => {}}
        isDarkMode={false}
      />,
    )
    expect(queryByText(/Set up your sandbox/)).toBeTruthy()
    fireEvent.click(getByRole('button', { name: 'Dismiss' }))
    expect(queryByText(/Set up your sandbox/)).toBeNull()
    // Re-render shouldn't bring it back — dismiss is sticky for the page.
    rerender(
      <ComputerUseSetupSandboxBanner
        show
        onStart={() => {}}
        isDarkMode={false}
      />,
    )
    expect(queryByText(/Set up your sandbox/)).toBeNull()
  })
})
