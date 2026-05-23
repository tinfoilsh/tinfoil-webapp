/**
 * Tests for ComputerUseConsentRenderer — the inline assistant-styled message
 * that asks the user to approve a proposed manifest. Replaces the old modal
 * consent. Lives in the chat scroll so it reads as the agent's "I'd like
 * permission" turn at the chronological position of `computer_begin`.
 */
import { ComputerUseConsentContext } from '@/components/chat/computer-use-context'
import { ComputerUseConsentRenderer } from '@/components/chat/renderers/ComputerUseConsentRenderer'
import type { Message } from '@/components/chat/types'
import type { BaseModel } from '@/config/models'
import type { BrokerImage, CapabilityManifest } from '@/services/computer-use'
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const model = { modelName: 'kimi-k2-6' } as unknown as BaseModel

const macImage: BrokerImage = { name: 'tahoe', os: 'mac', ready: true }

function msg(over: Partial<Message>): Message {
  return {
    role: 'assistant',
    content: '',
    timestamp: new Date('2026-05-22T00:00:00Z'),
    ...over,
  }
}

const proposed: CapabilityManifest = {
  version: 1,
  session: { os: 'mac', image: 'tahoe', clone: true },
}

describe('ComputerUseConsentRenderer.canRender', () => {
  it('claims messages with a proposed manifest', () => {
    expect(
      ComputerUseConsentRenderer.canRender(
        msg({ computerUseProposedManifest: proposed }),
        model,
      ),
    ).toBe(true)
  })

  it('claims messages with a consent status (post-approval/cancel record)', () => {
    expect(
      ComputerUseConsentRenderer.canRender(
        msg({ computerUseConsentStatus: 'approved' }),
        model,
      ),
    ).toBe(true)
  })

  it('does not claim a regular assistant message', () => {
    expect(
      ComputerUseConsentRenderer.canRender(msg({ content: 'hi' }), model),
    ).toBe(false)
  })
})

function renderWithContext(
  message: Message,
  ctx: {
    approve: (m: CapabilityManifest) => void
    cancel: () => void
    images: BrokerImage[]
  } | null = null,
) {
  return render(
    <ComputerUseConsentContext.Provider value={ctx}>
      {ComputerUseConsentRenderer.render({
        message,
        messageIndex: 0,
        model,
        isDarkMode: false,
      })}
    </ComputerUseConsentContext.Provider>,
  )
}

describe('ComputerUseConsentRenderer.render', () => {
  it('pending + live context: renders the editor with the model reason', () => {
    const { getByText } = renderWithContext(
      msg({
        computerUseConsentStatus: 'pending',
        computerUseProposedManifest: proposed,
        computerUseTaskReason: 'research X',
      }),
      { approve: vi.fn(), cancel: vi.fn(), images: [macImage] },
    )
    expect(getByText(/Permission needed/)).toBeDefined()
    expect(getByText('research X')).toBeDefined()
    // The approve button exists.
    expect(getByText(/Approve/)).toBeDefined()
  })

  it('pending + live context: Approve calls ctx.approve with a manifest', () => {
    const approve = vi.fn()
    const { getByText } = renderWithContext(
      msg({
        computerUseConsentStatus: 'pending',
        computerUseProposedManifest: proposed,
        computerUseTaskReason: 'do stuff',
      }),
      { approve, cancel: vi.fn(), images: [macImage] },
    )
    fireEvent.click(getByText(/Approve & run/))
    expect(approve).toHaveBeenCalledOnce()
    const call = approve.mock.calls[0][0] as CapabilityManifest
    expect(call.session.image).toBe('tahoe')
  })

  it('pending + live context: Cancel calls ctx.cancel', () => {
    const cancel = vi.fn()
    const { getByText } = renderWithContext(
      msg({
        computerUseConsentStatus: 'pending',
        computerUseProposedManifest: proposed,
        computerUseTaskReason: 'do stuff',
      }),
      { approve: vi.fn(), cancel, images: [macImage] },
    )
    fireEvent.click(getByText('Cancel'))
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('approved: shows a minimal approval record (no duplicated config)', () => {
    const { getByText, queryByText } = renderWithContext(
      msg({
        computerUseConsentStatus: 'approved',
        computerUseTaskReason: 'research X',
        computerUseManifest: proposed,
      }),
      { approve: vi.fn(), cancel: vi.fn(), images: [macImage] },
    )
    expect(getByText(/Sandbox approved/)).toBeDefined()
    expect(getByText('research X')).toBeDefined()
    // The approve button is gone (editor isn't rendered).
    expect(queryByText(/Approve & run/)).toBeNull()
    // Regression: the SandboxConfigSummary (rendered inside the session
    // record below) used to appear here too — same content, twice. It
    // should be absent from the approved-consent message now.
    expect(queryByText(/Sandbox config/)).toBeNull()
    expect(queryByText(/Image$/)).toBeNull()
  })

  it('cancelled: shows the declined record', () => {
    const { getByText, queryByText } = renderWithContext(
      msg({
        computerUseConsentStatus: 'cancelled',
        computerUseTaskReason: 'research X',
      }),
      { approve: vi.fn(), cancel: vi.fn(), images: [macImage] },
    )
    expect(getByText(/Sandbox declined/)).toBeDefined()
    expect(queryByText(/Approve & run/)).toBeNull()
  })

  it('pending without a context provider: degrades to read-only (reload case)', () => {
    const { getByText, queryByText } = renderWithContext(
      msg({
        computerUseConsentStatus: 'pending',
        computerUseProposedManifest: proposed,
        computerUseTaskReason: 'frozen mid-prompt',
      }),
      null,
    )
    expect(getByText(/Permission needed/)).toBeDefined()
    // No editor controls when there's no live session to drive.
    expect(queryByText(/Approve & run/)).toBeNull()
  })
})
