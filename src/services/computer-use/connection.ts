/**
 * Ties the stored pairing credential to a ready-to-use driver connection.
 *
 * Lifecycle (architecture → "Auth/token lifecycle"):
 *  1. Pair once per browser → store the refresh credential.
 *  2. Per use: exchange it for short-lived access JWTs (the {@link DriverConnection}
 *     auto-refreshes), used on the consequential endpoints.
 *  3. On a revoked credential, clear it and re-pair.
 */

import { createDriverConnection, type DriverConnection } from './access-token'
import {
  clearRefreshCredential,
  getRefreshCredential,
  setRefreshCredential,
} from './credential-store'
import type { DriverClient, DriverClientOptions } from './driver-client'
import { runPairing, type RunPairingOptions } from './pairing'

export interface ConnectionOptions {
  baseUrl?: string
  fetchImpl?: DriverClientOptions['fetchImpl']
}

/**
 * Build a token-managed connection from the stored refresh credential, or
 * `null` if this browser hasn't paired yet.
 */
export function getStoredConnection(
  opts: ConnectionOptions = {},
): DriverConnection | null {
  const refreshCredential = getRefreshCredential()
  if (!refreshCredential) return null
  return createDriverConnection({
    refreshCredential,
    ...opts,
    // Auto-rotate: a rejected credential is cleared from storage wherever the
    // 401 occurs, so the next session re-pairs instead of reusing a dead one.
    onRefreshRejected: clearRefreshCredential,
  })
}

/**
 * Run the pairing handshake (UI surfaces the code via `onCode`/`onState`), store
 * the resulting refresh credential, and return a ready connection. Throws on
 * deny/timeout/unreachable — the caller leaves the user un-paired.
 */
export async function pairAndConnect(
  client: DriverClient,
  opts: RunPairingOptions & ConnectionOptions = {},
): Promise<DriverConnection> {
  const { refreshCredential } = await runPairing(client, opts)
  setRefreshCredential(refreshCredential)
  return createDriverConnection({
    refreshCredential,
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
    onRefreshRejected: clearRefreshCredential,
  })
}

/** Drop the stored credential (revoked / user unpaired). */
export function forgetPairing(): void {
  clearRefreshCredential()
}
