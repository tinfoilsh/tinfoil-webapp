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
import { readyImages } from './availability'
import { BrokerClient } from './broker-client'
import type { StreamChat } from './chat-protocol'
import {
  forgetPairing,
  getStoredConnection,
  pairAndConnect,
} from './connection'
import {
  createCanvasImageReducer,
  getComputerUseImageQuality,
} from './image-reduce'
import { createTinfoilStreamChat } from './inference'
import {
  runComputerUseLoop,
  type CapabilityApproval,
  type ImageReducer,
  type LoopEvent,
  type LoopResult,
} from './loop-controller'
import type { BrokerImage, CapabilityManifest, PairState } from './types'
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
  /**
   * Ready images (with their OS) for the consent UI's image picker. The OS
   * is needed so the dialog can display the derived `session.os` read-only
   * and so the loop can fill in `session.os` from the chosen image rather
   * than from a model-supplied value.
   */
  images: BrokerImage[]
  /** Loop events accumulated for the live view + audit trail. */
  frames: LoopEvent[]
  finalText?: string
  error?: string
  /**
   * Pending capability-escalation ask from the model. Set while the loop is
   * waiting for the user to click Approve or Deny. The UI renders this as an
   * inline prompt with the requested egress domains.
   */
  capabilityRequest?: { egress: string[] }
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
  fetchStatusImages?: (conn: BrokerConnection) => Promise<BrokerImage[]>
  runLoop?: typeof runComputerUseLoop
  makeStreamChat?: (modelName: string) => StreamChat
  /** Build the model-facing screenshot reducer (default: canvas JPEG @ quality setting). */
  makeReduceImage?: () => ImageReducer
}

const INITIAL: ComputerUseSessionState = {
  phase: 'idle',
  task: '',
  images: [],
  frames: [],
}

/** Default proposed manifest: the first ready image, sealed (default-deny). */
function proposeManifest(
  images: BrokerImage[],
): CapabilityManifest | undefined {
  const first = images[0]
  if (!first) return undefined
  return {
    version: 1,
    session: { os: first.os, image: first.name, clone: true },
  }
}

/**
 * Override `session.os` with the chosen image's OS. The model doesn't pick
 * `os` (see manifest-schema.ts); if a stale or malformed manifest still has
 * one, it gets replaced — the image is the source of truth.
 */
function applyImageOS(
  manifest: CapabilityManifest,
  images: BrokerImage[],
): CapabilityManifest {
  const found = images.find((i) => i.name === manifest.session.image)
  if (!found) return manifest
  return {
    ...manifest,
    session: { ...manifest.session, os: found.os },
  }
}

export function useComputerUseSession(
  modelName: string,
  deps: ComputerUseSessionDeps = {},
) {
  const [state, setState] = useState<ComputerUseSessionState>(INITIAL)
  const connRef = useRef<BrokerConnection | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // When the loop pauses on a capability request, the resolver of the await'd
  // promise lives here. Cleared on every resolve so a stale resolver from a
  // prior request can't be re-fired.
  const capabilityResolverRef = useRef<
    ((decision: CapabilityApproval) => void) | null
  >(null)

  const runLoop = deps.runLoop ?? runComputerUseLoop
  const makeStreamChat = deps.makeStreamChat ?? createTinfoilStreamChat
  // Wrap the default factory in useMemo so the inner `approve`/`runLoop`
  // useCallback can depend on a stable identity — otherwise the Compiler-
  // aware lint flags the inline ?? fallback as creating a new factory each
  // render, defeating downstream memoization.
  const makeReduceImage = useMemo<
    NonNullable<ComputerUseSessionDeps['makeReduceImage']>
  >(
    () =>
      deps.makeReduceImage ??
      (() =>
        createCanvasImageReducer({ quality: getComputerUseImageQuality() })),
    [deps.makeReduceImage],
  )
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
        readyImages(await conn.client.getStatus())),
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
        // Build the candidate manifest, then force `session.os` to match the
        // chosen image — defense against a model that emitted `os` against
        // the old schema, or any stale/edited proposal that disagrees with
        // the image's actual OS.
        const base = proposedManifest ?? proposeManifest(images)
        const manifest = base ? applyImageOS(base, images) : undefined
        patch({ phase: 'consent', images, manifest })
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
      // Belt-and-suspenders: re-apply image OS after consent in case the
      // user changed the image mid-edit.
      const sealed = applyImageOS(manifest, state.images)
      patch({ phase: 'running', manifest: sealed, frames: [] })

      try {
        const result: LoopResult = await runLoop({
          task: state.task,
          manifest: sealed,
          broker: conn.client,
          tokens: conn.tokens,
          streamChat: makeStreamChat(modelName),
          modelName,
          // Chat/audit keep the full PNG; the model gets a reduced JPEG.
          reduceImage: makeReduceImage(),
          signal: ac.signal,
          onEvent: (event) => {
            // Mirror successful escalations into the displayed manifest so the
            // config widget reflects what the session is actually running with.
            if (
              event.type === 'capability_result' &&
              event.approved &&
              event.egress
            ) {
              setState((s) =>
                s.manifest
                  ? {
                      ...s,
                      frames: [...s.frames, event],
                      manifest: {
                        ...s.manifest,
                        network: {
                          ...s.manifest.network,
                          egress: event.egress,
                        },
                      },
                    }
                  : { ...s, frames: [...s.frames, event] },
              )
              return
            }
            setState((s) => ({ ...s, frames: [...s.frames, event] }))
          },
          // Promise-based pause: the loop awaits this; the UI fulfills it via
          // approveCapability / denyCapability.
          requestCapabilityApproval: (req) =>
            new Promise<CapabilityApproval>((resolve) => {
              capabilityResolverRef.current = (decision) => {
                capabilityResolverRef.current = null
                resolve(decision)
              }
              setState((s) => ({
                ...s,
                capabilityRequest: { egress: req.egress },
              }))
            }),
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
    [
      state.task,
      state.images,
      runLoop,
      makeStreamChat,
      makeReduceImage,
      modelName,
      patch,
    ],
  )

  /**
   * Approve a pending capability request. If `egress` is provided, it overrides
   * the list the model asked for (so the user can edit before approving).
   * No-op when there's no pending request.
   */
  const approveCapability = useCallback(
    (egress?: string[]) => {
      const resolver = capabilityResolverRef.current
      const pending = state.capabilityRequest
      if (!resolver || !pending) return
      resolver({ approved: true, egress: egress ?? pending.egress })
      setState((s) => ({ ...s, capabilityRequest: undefined }))
    },
    [state.capabilityRequest],
  )

  /** Deny a pending capability request. The loop continues, telling the model. */
  const denyCapability = useCallback((reason?: string) => {
    const resolver = capabilityResolverRef.current
    if (!resolver) return
    resolver({ approved: false, reason })
    setState((s) => ({ ...s, capabilityRequest: undefined }))
  }, [])

  /** Cancel the session (abort any in-flight work) and reset. */
  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    connRef.current = null
    // Resolve any in-flight capability request as denied so the loop's awaited
    // promise unblocks and the finally-block can tear the session down.
    if (capabilityResolverRef.current) {
      capabilityResolverRef.current({ approved: false, reason: 'cancelled' })
    }
    setState(INITIAL)
  }, [])

  return { state, start, approve, approveCapability, denyCapability, cancel }
}
