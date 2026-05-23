/**
 * Renderer for the inline computer-use consent prompt — the assistant-styled
 * chat message that asks the user to review and approve the agent's proposed
 * sandbox manifest. Replaces the old modal consent surface.
 *
 * Drives `session.approve()` / `session.cancel()` via the
 * `ComputerUseConsentContext` (chat-interface provides it). Without a
 * provider this renders as a read-only history record of the prompt, which
 * is what persisted/reloaded chats look like.
 */

import { ManifestEditor } from '@/components/chat/ComputerUseManifestEditor'
import { OSBadge } from '@/components/chat/ComputerUseSessionMessage'
import { useComputerUseConsentContext } from '@/components/chat/computer-use-context'
import type { MessageRenderer } from './types'

export const ComputerUseConsentRenderer: MessageRenderer = {
  id: 'computer-use-consent',
  canRender: (message) =>
    message.computerUseProposedManifest !== undefined ||
    message.computerUseConsentStatus !== undefined,
  render: ({ message }) => <ConsentBlock message={message} />,
}

function ConsentBlock({ message }: { message: import('../types').Message }) {
  const ctx = useComputerUseConsentContext()
  const status = message.computerUseConsentStatus
  const proposed = message.computerUseProposedManifest
  const approved = message.computerUseManifest
  const reason = message.computerUseTaskReason ?? ''

  // Pending + a live session: render the editor wired to the active session.
  // Pending without a live session (e.g. after reload mid-prompt): degrade
  // to a read-only "the agent was asking" record, since we can't drive the
  // approve/cancel without the hook.
  const live = ctx && status === 'pending' && proposed
  return (
    <div className="relative mx-auto mb-6 flex w-full max-w-3xl flex-col items-start">
      <div className="w-full px-4 py-2">
        <div className="overflow-hidden rounded-2xl border border-border-subtle bg-surface-chat-background">
          <Header
            label={
              status === 'approved'
                ? 'Sandbox approved'
                : status === 'cancelled'
                  ? 'Sandbox declined'
                  : 'Permission needed'
            }
            tone={
              status === 'approved'
                ? 'positive'
                : status === 'cancelled'
                  ? 'negative'
                  : 'pending'
            }
            proposedOS={proposed?.session.os ?? approved?.session.os}
          />
          <div className="space-y-3 px-3 py-3">
            {live ? (
              <ManifestEditor
                reason={reason}
                images={ctx.images}
                initial={proposed!}
                onApprove={ctx.approve}
                onCancel={ctx.cancel}
              />
            ) : (
              <ReadOnlyConsent status={status} reason={reason} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ReadOnlyConsent({
  status,
  reason,
}: {
  status: import('../types').Message['computerUseConsentStatus']
  reason: string
}) {
  // Approved state intentionally omits the sandbox-config summary — the
  // session-record message (committed by chat-interface after the run)
  // carries that, and showing it twice in a row read as duplicate UI.
  // Cancelled is the only state where the consent message stands alone,
  // so it gets a brief explanation line.
  return (
    <>
      {reason && (
        <p className="rounded-lg bg-surface-chat-background px-3 py-2 text-sm text-content-primary">
          {reason}
        </p>
      )}
      {status === 'cancelled' && (
        <p className="text-xs text-content-secondary">
          You declined this sandbox — nothing was started.
        </p>
      )}
      {status === 'approved' && (
        <p className="text-xs text-content-secondary">
          You approved the sandbox. The session’s configuration and trail are in
          the next message.
        </p>
      )}
    </>
  )
}

function Header({
  label,
  tone,
  proposedOS,
}: {
  label: string
  tone: 'pending' | 'positive' | 'negative'
  proposedOS?: import('@/services/computer-use').GuestOS
}) {
  const toneCls = {
    pending: 'text-amber-600 dark:text-amber-400',
    positive: 'text-green-600 dark:text-green-400',
    negative: 'text-red-500',
  }[tone]
  return (
    <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
      <span className="flex items-center gap-2 text-xs font-medium text-content-secondary">
        <span className="text-content-primary">Computer use</span>
        <span className={toneCls}>· {label}</span>
        {proposedOS && <OSBadge os={proposedOS} />}
      </span>
    </div>
  )
}
