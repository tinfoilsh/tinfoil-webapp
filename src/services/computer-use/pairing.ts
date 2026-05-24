/**
 * One-time, human-confirmed pairing flow (architecture → "Pairing & driver
 * trust"). The chat displays a short code and POSTs it to the driver, which
 * surfaces an Approve/Deny request in the system tray showing the same code.
 * The user confirms the tray code matches the chat, approves, and the browser
 * receives the long-lived refresh credential exactly once.
 *
 * Pairing happens once per browser; the refresh credential is reused silently
 * for new chats. Re-pair only on cleared storage / new browser / revocation.
 */

import type { DriverClient } from './driver-client'
import { DriverError, type PairState } from './types'

/** Unambiguous code alphabet — no 0/O/1/I/L to keep the tray↔chat match easy. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/** Generate a short pairing code the UI displays and the tray echoes. */
export function generatePairingCode(length = 4): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let code = ''
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  }
  return code
}

export class PairingDeniedError extends Error {
  constructor() {
    super('pairing was denied in the tray')
    this.name = 'PairingDeniedError'
  }
}

export class PairingTimeoutError extends Error {
  constructor() {
    super('pairing timed out waiting for tray approval')
    this.name = 'PairingTimeoutError'
  }
}

export interface RunPairingOptions {
  /** The displayed code; generated if omitted. Exposed so the UI can show it. */
  code?: string
  /** Poll cadence while the user decides. Default 1s. */
  pollIntervalMs?: number
  /** Give up after this long. Default 2 minutes (matches the driver TTL). */
  timeoutMs?: number
  signal?: AbortSignal
  /** Called with the code as soon as it's known, so the UI can render it. */
  onCode?: (code: string) => void
  /** Called on each poll so the UI can reflect pending/denied/approved. */
  onState?: (state: PairState) => void
}

export interface PairingResult {
  /** The opaque, revocable refresh credential. Treat as a secret. */
  refreshCredential: string
  /** The code the user confirmed. */
  code: string
}

/**
 * Run the full pairing handshake and resolve with the refresh credential.
 * Rejects with {@link PairingDeniedError} / {@link PairingTimeoutError} or a
 * {@link DriverError} if the driver is unreachable.
 */
export async function runPairing(
  client: DriverClient,
  opts: RunPairingOptions = {},
): Promise<PairingResult> {
  const code = opts.code ?? generatePairingCode()
  const pollIntervalMs = opts.pollIntervalMs ?? 1000
  const timeoutMs = opts.timeoutMs ?? 120_000
  opts.onCode?.(code)

  const { pairing_id } = await client.pair(code, opts.signal)

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    const status = await client.pairStatus(pairing_id, opts.signal)
    opts.onState?.(status.state)

    switch (status.state) {
      case 'approved':
        if (!status.refresh_credential) {
          // Approved but the credential was already consumed by an earlier read
          // — treat as a failed handshake rather than silently returning empty.
          throw new DriverError(
            'pairing approved but refresh credential was already consumed',
            409,
          )
        }
        return { refreshCredential: status.refresh_credential, code }
      case 'denied':
        throw new PairingDeniedError()
      case 'consumed':
        throw new DriverError(
          'pairing already consumed (re-pair to obtain a new credential)',
          409,
        )
      case 'pending':
        break
    }
    await sleep(pollIntervalMs, opts.signal)
  }
  throw new PairingTimeoutError()
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}
