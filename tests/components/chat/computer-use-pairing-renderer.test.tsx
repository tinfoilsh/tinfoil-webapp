/**
 * Tests for the inline pairing-handshake message renderer (`ComputerUse-
 * PairingRenderer`) that replaces the modal pairing UI. The card carries
 * the code while the user verifies it against the tray, and is mutated to
 * a terminal status when the handshake resolves.
 */
import { ComputerUseFunnelContext } from '@/components/chat/computer-use-funnel-context'
import { ComputerUsePairingRenderer } from '@/components/chat/renderers/ComputerUsePairingRenderer'
import type { Message } from '@/components/chat/types'
import type { BaseModel } from '@/config/models'
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const model = { modelName: 'kimi-k2-6' } as unknown as BaseModel

function msg(over: Partial<Message>): Message {
  return {
    role: 'assistant',
    content: '',
    timestamp: new Date('2026-05-22T00:00:00Z'),
    ...over,
  }
}

function renderWithCtx(
  message: Message,
  ctx: {
    cancelPairing?: () => void
    connect?: () => Promise<boolean>
    removeMessage?: (i: number) => void
  } | null = null,
) {
  const value = ctx
    ? {
        cancelPairing: ctx.cancelPairing ?? (() => {}),
        connect: ctx.connect ?? (async () => false),
        removeMessage: ctx.removeMessage ?? (() => {}),
      }
    : null
  return render(
    <ComputerUseFunnelContext.Provider value={value}>
      {ComputerUsePairingRenderer.render({
        message,
        messageIndex: 0,
        model,
        isDarkMode: false,
      })}
    </ComputerUseFunnelContext.Provider>,
  )
}

describe('ComputerUsePairingRenderer.canRender', () => {
  it('claims messages with a pairing code', () => {
    expect(
      ComputerUsePairingRenderer.canRender(
        msg({ computerUsePairingCode: 'AB12' }),
        model,
      ),
    ).toBe(true)
  })

  it('claims messages with a pairing status (terminal record)', () => {
    expect(
      ComputerUsePairingRenderer.canRender(
        msg({ computerUsePairingStatus: 'approved' }),
        model,
      ),
    ).toBe(true)
  })

  it('does not claim a regular assistant message', () => {
    expect(
      ComputerUsePairingRenderer.canRender(msg({ content: 'hi' }), model),
    ).toBe(false)
  })
})

describe('ComputerUsePairingRenderer.render — pending', () => {
  it('shows the code prominently and a Cancel button', () => {
    const cancelPairing = vi.fn()
    const { getByText, getByRole } = renderWithCtx(
      msg({
        computerUsePairingCode: 'AB12',
        computerUsePairingStatus: 'pending',
      }),
      { cancelPairing },
    )
    expect(getByText('AB12')).toBeDefined()
    expect(getByText(/Waiting for tray approval/i)).toBeDefined()
    fireEvent.click(getByRole('button', { name: 'Cancel pairing' }))
    expect(cancelPairing).toHaveBeenCalledOnce()
  })

  it('shows a placeholder when the code has not arrived yet', () => {
    const { getByText } = renderWithCtx(
      msg({ computerUsePairingStatus: 'pending' }),
      { cancelPairing: () => {} },
    )
    expect(getByText('····')).toBeDefined()
  })

  it('renders read-only (no Cancel) without a funnel context', () => {
    const { queryByRole } = renderWithCtx(
      msg({
        computerUsePairingCode: 'AB12',
        computerUsePairingStatus: 'pending',
      }),
      null,
    )
    expect(queryByRole('button', { name: 'Cancel pairing' })).toBeNull()
  })
})

describe('ComputerUsePairingRenderer.render — terminal', () => {
  it('approved: terminal record with the code', () => {
    const { getAllByText, queryByText, queryByRole } = renderWithCtx(
      msg({
        computerUsePairingCode: 'AB12',
        computerUsePairingStatus: 'approved',
      }),
      { cancelPairing: () => {} },
    )
    // Status appears in both the header chip and the body sentence; assert
    // at least one occurrence rather than exactly-one to keep this flexible.
    expect(getAllByText(/Approved in tray/i).length).toBeGreaterThan(0)
    expect(queryByText(/AB12/)).toBeTruthy()
    // No Cancel button on a terminal record.
    expect(queryByRole('button', { name: 'Cancel pairing' })).toBeNull()
  })

  it('denied: terminal record with explanatory label', () => {
    const { getAllByText } = renderWithCtx(
      msg({
        computerUsePairingCode: 'AB12',
        computerUsePairingStatus: 'denied',
      }),
      { cancelPairing: () => {} },
    )
    expect(getAllByText(/Declined in tray/i).length).toBeGreaterThan(0)
  })

  it('cancelled: terminal record', () => {
    const { getAllByText } = renderWithCtx(
      msg({
        computerUsePairingCode: 'AB12',
        computerUsePairingStatus: 'cancelled',
      }),
      { cancelPairing: () => {} },
    )
    expect(getAllByText(/Pairing cancelled/i).length).toBeGreaterThan(0)
  })
})
