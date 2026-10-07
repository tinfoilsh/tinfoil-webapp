import { DataFlowDiagram } from '@/components/chat/DataFlowDiagram'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('DataFlowDiagram', () => {
  afterEach(() => vi.restoreAllMocks())

  it('keeps node labels visible while hiding their decorative icons', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 640, 480),
    )
    render(<DataFlowDiagram />)

    for (const label of [
      'Attestation Proof',
      'Tinfoil Server',
      'Secure Enclave',
      'Tinfoil Chat App',
    ]) {
      const text = screen.getByText(label)
      expect(text).toBeVisible()
      expect(text.parentElement?.querySelector('svg')).toHaveAttribute(
        'aria-hidden',
        'true',
      )
    }
  })
})
