/**
 * Orchestration hook for one in-chat computer-use session — the state machine
 * that ties the pieces together:
 *
 *   idle → (pair if needed) → consent (review manifest) → running (agentic loop,
 *   streaming frames) → done | handoff | error
 *
 * It keeps the deep chat-messaging pipeline untouched: the chat triggers
 * `start(task)` when computer-use is enabled, and this hook drives everything
 * against the broker + the attested inference client, exposing observable state
 * the session UI renders. Dependencies are injectable so the machine is
 * unit-testable without the network, a VM, or the enclave.
 */

'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import type { BrokerConnection } from './access-token'
import { readyImageNames } from './availability'
import { BrokerClient } from './broker-client'
import type { StreamChat } from './chat-protocol'
import {
  forgetPairing,
  getStoredConnection,
  pairAndConnect,
} from './connection'
import { createTinfoilStreamChat } from './inference'
import {
  runComputerUseLoop,
  type LoopEvent,
  type LoopResult,
} from './loop-controller'
import type { CapabilityManifest, GuestOS, PairState } from './types'
import { BrokerError } from './types'

export type SessionPhase =
  | 'idle'
  | 'pairing'
  | 'consent'
  | 'running'
  | 'handoff'
  | 'done'
  | 'error'

export interface ComputerUseSessionState {
  phase: SessionPhase
  task: string
  /** The model's own summary of why it opened the sandbox (for consent). */
  reason?: string
  /** Pairing code to display while the user approves in the tray. */
  pairingCode?: string
  pairingState?: PairState
  /** Proposed/approved manifest under review at the consent step. */
  manifest?: CapabilityManifest
  /** Ready images, for the consent UI's image picker. */
  images: string[]
  /** Loop events accumulated for the live view + audit trail. */
  frames: LoopEvent[]
  finalText?: string
  error?: string
}

/** Injectable seams (real implementations by default). */
export interface ComputerUseSessionDeps {
  baseUrl?: string
  getConnection?: () => BrokerConnection | null
  pair?: (opts: {
    onCode: (code: string) => void
    onState: (state: PairState) => void
    signal?: AbortSignal
  }) => Promise<BrokerConnection>
  fetchStatusImages?: (conn: BrokerConnection) => Promise<string[]>
  runLoop?: typeof runComputerUseLoop
  makeStreamChat?: (modelName: string) => StreamChat
}

const INITIAL: ComputerUseSessionState = {
  phase: 'idle',
  task: '',
  images: [],
  frames: [],
}

/** Default proposed manifest: the first ready image, sealed (default-deny). */
function proposeManifest(images: string[]): CapabilityManifest | undefined {
  const image = images[0]
  if (!image) return undefined
  // OS can't be derived from the name; default mac (MVP host) — the consent UI
  // lets the user confirm/adjust before approving.
  return { version: 1, session: { os: 'mac' as GuestOS, image, clone: true } }
}

export function useComputerUseSession(
  modelName: string,
  deps: ComputerUseSessionDeps = {},
) {
  const [state, setState] = useState<ComputerUseSessionState>(INITIAL)
  const connRef = useRef<BrokerConnection | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const runLoop = deps.runLoop ?? runComputerUseLoop
  const makeStreamChat = deps.makeStreamChat ?? createTinfoilStreamChat
  const baseUrl = deps.baseUrl

  const getConnection = useMemo(
    () => deps.getConnection ?? (() => getStoredConnection({ baseUrl })),
    [deps.getConnection, baseUrl],
  )
  const pair = useMemo<NonNullable<ComputerUseSessionDeps['pair']>>(
    () =>
      deps.pair ??
      ((opts) => {
        const client = new BrokerClient({ baseUrl })
        return pairAndConnect(client, { ...opts, baseUrl })
      }),
    [deps.pair, baseUrl],
  )
  const fetchStatusImages = useMemo(
    () =>
      deps.fetchStatusImages ??
      (async (conn: BrokerConnection) =>
        readyImageNames(await conn.client.getStatus())),
    [deps.fetchStatusImages],
  )

  const patch = useCallback((p: Partial<ComputerUseSessionState>) => {
    setState((s) => ({ ...s, ...p }))
  }, [])

  /**
   * Begin a session for `task`: connect/pair, then move to consent. When the
   * model initiated this (via `computer_begin`), `proposedManifest` is its
   * requested manifest; the consent UI seeds from it and lets the user edit.
   */
  const start = useCallback(
    async (
      task: string,
      proposedManifest?: CapabilityManifest,
      reason?: string,
    ) => {
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac
      setState({ ...INITIAL, task, reason })

      try {
        let conn = getConnection()
        // Validate a stored credential before relying on it: if the broker was
        // restarted/reinstalled or the pairing was revoked, `/token` returns 401
        // — drop the stale credential and re-pair rather than failing mid-run.
        // (A merely-unreachable broker is NOT an auth error, so we don't clear.)
        if (conn && typeof conn.tokens?.getAccessToken === 'function') {
          try {
            await conn.tokens.getAccessToken(ac.signal)
          } catch (err) {
            if (err instanceof BrokerError && err.isAuthError) {
              forgetPairing()
              conn = null
            } else {
              throw err
            }
          }
        }
        if (!conn) {
          patch({ phase: 'pairing' })
          conn = await pair({
            onCode: (code) => patch({ pairingCode: code }),
            onState: (pairingState) => patch({ pairingState }),
            signal: ac.signal,
          })
        }
        connRef.current = conn

        const images = await fetchStatusImages(conn)
        patch({
          phase: 'consent',
          images,
          manifest: proposedManifest ?? proposeManifest(images),
        })
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        patch({
          phase: 'error',
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [getConnection, pair, fetchStatusImages, patch],
  )

  /** Approve the (possibly edited) manifest and run the agentic loop. */
  const approve = useCallback(
    async (manifest: CapabilityManifest) => {
      const conn = connRef.current
      if (!conn) {
        patch({ phase: 'error', error: 'no broker connection' })
        return
      }
      const ac = abortRef.current ?? new AbortController()
      patch({ phase: 'running', manifest, frames: [] })

      try {
        const result: LoopResult = await runLoop({
          task: state.task,
          manifest,
          broker: conn.client,
          tokens: conn.tokens,
          streamChat: makeStreamChat(modelName),
          modelName,
          signal: ac.signal,
          onEvent: (event) =>
            setState((s) => ({ ...s, frames: [...s.frames, event] })),
        })
        patch({
          phase: result.reason === 'handoff' ? 'handoff' : 'done',
          finalText: result.finalText,
        })
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        patch({
          phase: 'error',
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [state.task, runLoop, makeStreamChat, modelName, patch],
  )

  /** Cancel the session (abort any in-flight work) and reset. */
  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    connRef.current = null
    setState(INITIAL)
  }, [])

  return { state, start, approve, cancel }
}
