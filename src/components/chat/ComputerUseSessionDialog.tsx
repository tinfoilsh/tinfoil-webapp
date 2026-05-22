/**
 * Modal for the *pairing* step of a computer-use session — the one step that
 * genuinely needs focused user attention (compare the code shown here to the
 * code in the system tray's pairing prompt). Consent moved out of the modal
 * and into the chat itself: see `ComputerUseConsentRenderer`.
 */

'use client'

import { type useComputerUseSession } from '@/services/computer-use'

type SessionApi = ReturnType<typeof useComputerUseSession>

export function ComputerUseSessionDialog({ session }: { session: SessionApi }) {
  const { state, cancel } = session
  // Only the pairing step uses the modal now. Consent renders inline in chat
  // (ComputerUseConsentRenderer) so it reads as the agent asking for
  // permission, not a context-stealing prompt.
  if (state.phase !== 'pairing') return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border-subtle bg-surface-chat shadow-xl">
        <header className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
          <h2 className="text-sm font-semibold text-content-primary">
            Computer use
          </h2>
          <button
            type="button"
            onClick={cancel}
            className="rounded-md px-2 py-1 text-xs text-content-secondary hover:bg-surface-chat-background hover:text-content-primary"
          >
            Cancel
          </button>
        </header>

        <div className="overflow-y-auto px-5 py-4">
          <PairingBody code={state.pairingCode} />
        </div>
      </div>
    </div>
  )
}

function PairingBody({ code }: { code?: string }) {
  return (
    <div className="space-y-3 text-center">
      <p className="text-sm text-content-secondary">
        Approve this connection in the Tinfoil menu-bar icon. Confirm the code
        matches:
      </p>
      <div className="font-mono text-3xl font-bold tracking-widest text-content-primary">
        {code ?? '····'}
      </div>
      <p className="text-xs text-content-muted">Waiting for approval…</p>
    </div>
  )
}
