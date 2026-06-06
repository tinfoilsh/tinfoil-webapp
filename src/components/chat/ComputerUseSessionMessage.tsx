/**
 * History-resident render of a finished computer-use session.
 *
 * Renders the same shell as the live thread (toolbar + body) but with the
 * VM in a stopped/errored state. Tool calls and per-frame chatter are NOT
 * surfaced here — the toolbar's Agent activity popover is the canonical
 * audit-trail surface. The body holds the VM's final screenshot (so the
 * operator sees what it looked like at the moment it stopped), a one-line
 * stop-reason hint, and a final error banner when the run ended abnormally.
 */

'use client'

import {
  dataUrl,
  firstImagePart,
  type CapabilityManifest,
  type LoopEvent,
  type LoopStopReason,
} from '@/services/computer-use'
import { useState } from 'react'
import { type SessionError } from './ComputerUseSessionPopovers'
import { ComputerUseSessionToolbar } from './ComputerUseSessionToolbar'

export { OSBadge } from './ComputerUseOSBadge'

/**
 * Collect every error the loop surfaced (or the terminal fatal error) so the
 * toolbar's bug popover can list them. The toolbar auto-opens the popover the
 * first time a fresh error appears.
 */
export function collectErrors(
  frames: LoopEvent[],
  fatal?: string,
): SessionError[] {
  const out: SessionError[] = []
  for (const f of frames) {
    if (f.type === 'action_error') {
      out.push({
        id: `act:${f.callId}`,
        source: 'action_error',
        message: f.message,
        op: f.action.op,
      })
    } else if (f.type === 'unsupported') {
      out.push({
        id: `uns:${f.callId}`,
        source: 'unsupported',
        message: f.reason,
      })
    }
  }
  if (fatal) {
    out.push({ id: 'fatal', source: 'fatal', message: fatal })
  }
  return out
}

/**
 * The most-recent screenshot in the frame trail, as a data URL — the VM's
 * final visible state. Walked backwards from the newest frame; `begin` and
 * image-bearing `action_result`s are the only screenshot sources. Lets the
 * static card show what the VM looked like at the moment it stopped instead
 * of a bare "Session ended" line.
 */
function lastScreenshot(frames: LoopEvent[]): string | undefined {
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i]
    const result =
      f.type === 'begin'
        ? f.screenshot
        : f.type === 'action_result'
          ? f.result
          : undefined
    if (!result) continue
    const img = firstImagePart(result)
    if (img) return dataUrl(img.data, img.mimeType)
  }
  return undefined
}

/** The loop's terminal stop reason, if the run emitted a `stopped` event. */
function stopReason(frames: LoopEvent[]): LoopStopReason | undefined {
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i]
    if (f.type === 'stopped') return f.reason
  }
  return undefined
}

/** Human phrase for the non-error stop reasons surfaced on the static card. */
function stopReasonLabel(reason: LoopStopReason | undefined): string {
  switch (reason) {
    case 'model_finished':
      return 'the agent finished'
    case 'max_steps':
      return 'it reached the step limit'
    case 'handoff':
      return 'it was handed to you'
    default:
      // 'aborted' never reaches here (abort emits no stopped event) and
      // 'error' takes the error branch; undefined means the operator
      // stopped the run before the loop reported a reason.
      return 'you stopped it'
  }
}

/**
 * Static history card. The body just nudges the user toward the toolbar
 * popovers; everything that happened is recorded there.
 */
export function ComputerUseSessionCard({
  frames,
  error,
  manifest,
  onRemove,
}: {
  frames: LoopEvent[]
  error?: string
  manifest?: CapabilityManifest
  onRemove?: () => void
}) {
  const isError = Boolean(error)
  const [collapsed, setCollapsed] = useState(false)
  const errors = collectErrors(frames, error)
  const shot = lastScreenshot(frames)
  const reason = stopReason(frames)
  return (
    <div className="relative mx-auto mb-6 flex w-full max-w-3xl flex-col items-start">
      <div className="w-full px-4 py-2">
        <div className="overflow-hidden rounded-2xl border border-border-subtle bg-surface-chat-background">
          <ComputerUseSessionToolbar
            imageName={manifest?.session.image}
            imageOS={manifest?.session.os}
            vmStatus={isError ? 'error' : 'stopped'}
            errors={errors}
            frames={frames}
            manifest={manifest}
            onClose={onRemove}
            onMinimize={() => setCollapsed((c) => !c)}
          />
          {!collapsed && (
            <div className="space-y-3 px-3 py-3">
              {shot && (
                <img
                  src={shot}
                  alt="Final sandbox screenshot"
                  className="block w-full rounded-lg border border-border-subtle"
                />
              )}
              <div className="text-xs text-content-secondary">
                {isError ? (
                  <p className="text-red-500">Session ended with an error.</p>
                ) : (
                  <p>
                    Session ended — {stopReasonLabel(reason)}. Open the activity
                    icon for the full action log; the terminal icon for any exec
                    output.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
