/**
 * Orchestration hook for one in-chat computer-use session — the state machine
 * that ties the pieces together:
 *
 *   idle → (pair if needed) → consent (review manifest) → running (agentic loop,
 *   streaming frames) → done | handoff | error
 *
 * It keeps the deep chat-messaging pipeline untouched: the chat triggers
 * `start(task)` when computer-use is enabled, and this hook drives everything
 * against the driver + the attested inference client, exposing observable state
 * the session UI renders. Dependencies are injectable so the machine is
 * unit-testable without the network, a VM, or the enclave.
 */

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DriverConnection } from './access-token'
import { readyImages } from './availability'
import type { StreamChat } from './chat-protocol'
import {
  forgetPairing,
  getStoredConnection,
  pairAndConnect,
} from './connection'
import { DriverClient } from './driver-client'
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
import type { CapabilityManifest, DriverImage, PairState } from './types'
import { DriverError } from './types'

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
  /** Live session ID, captured from the first `begin` event the loop emits. */
  sessionId?: string
  /** User-toggled dispatch pause. Buffered tool calls wait until resumed. */
  paused?: boolean
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
  images: DriverImage[]
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
  getConnection?: () => DriverConnection | null
  pair?: (opts: {
    onCode: (code: string) => void
    onState: (state: PairState) => void
    signal?: AbortSignal
  }) => Promise<DriverConnection>
  fetchStatusImages?: (conn: DriverConnection) => Promise<DriverImage[]>
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
  images: DriverImage[],
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
  images: DriverImage[],
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
  // Mirror the latest state into a ref so callbacks (cancel) can read the
  // current sessionId without re-keying on the freshest closure each
  // render. The sync runs in a layout effect — i.e. synchronously after
  // the commit, before any user-triggered handler can fire — so any
  // observer that reads `stateRef.current` sees the just-committed state.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])
  const connRef = useRef<DriverConnection | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // When the loop pauses on a capability request, the resolver of the await'd
  // promise lives here. Cleared on every resolve so a stale resolver from a
  // prior request can't be re-fired.
  const capabilityResolverRef = useRef<
    ((decision: CapabilityApproval) => void) | null
  >(null)
  // Mirrors `state.paused` for synchronous access from the dispatch barrier
  // (a React state read would race the latest setState).
  const pausedRef = useRef(false)
  const resumeWaitersRef = useRef<Array<() => void>>([])

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
        const client = new DriverClient({ baseUrl })
        return pairAndConnect(client, { ...opts, baseUrl })
      }),
    [deps.pair, baseUrl],
  )
  const fetchStatusImages = useMemo(
    () =>
      deps.fetchStatusImages ??
      (async (conn: DriverConnection) =>
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
        // Validate a stored credential before relying on it: if the driver was
        // restarted/reinstalled or the pairing was revoked, `/token` returns 401
        // — drop the stale credential and re-pair rather than failing mid-run.
        // (A merely-unreachable driver is NOT an auth error, so we don't clear.)
        if (conn && typeof conn.tokens?.getAccessToken === 'function') {
          try {
            await conn.tokens.getAccessToken(ac.signal)
          } catch (err) {
            if (err instanceof DriverError && err.isAuthError) {
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
        patch({ phase: 'error', error: 'no driver connection' })
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
          driver: conn.client,
          tokens: conn.tokens,
          streamChat: makeStreamChat(modelName),
          modelName,
          // Chat/audit keep the full PNG; the model gets a reduced JPEG.
          reduceImage: makeReduceImage(),
          signal: ac.signal,
          onEvent: (event) => {
            // Capture the live session id off the first `begin` event so user
            // ad-hoc actions (e.g. terminal exec) can target it.
            if (event.type === 'begin') {
              setState((s) => ({
                ...s,
                sessionId: event.session,
                frames: [...s.frames, event],
              }))
              return
            }
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
          waitForUnpaused: async (sig) => {
            if (!pausedRef.current) return
            await new Promise<void>((resolve, reject) => {
              resumeWaitersRef.current.push(resolve)
              if (sig) {
                const onAbort = () => {
                  // Pull the resolver off the queue so cancel() doesn't try
                  // to fire a settled promise later.
                  resumeWaitersRef.current = resumeWaitersRef.current.filter(
                    (r) => r !== resolve,
                  )
                  reject(new DOMException('Aborted', 'AbortError'))
                }
                sig.addEventListener('abort', onAbort, { once: true })
              }
            })
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

  /**
   * Mint a fresh access JWT against the live session's connection. The live
   * view needs this because the WS upgrade carries the token in a query
   * param (the browser can't set Authorization on an upgrade). Resolves
   * `null` if the session never paired or has been torn down.
   */
  const getAccessToken = useCallback(
    async (signal?: AbortSignal): Promise<string | null> => {
      const conn = connRef.current
      if (!conn?.tokens) return null
      try {
        return await conn.tokens.getAccessToken(signal)
      } catch {
        return null
      }
    },
    [],
  )

  /** Hold pending dispatches behind the pause barrier. Idempotent. */
  const pause = useCallback(() => {
    if (pausedRef.current) return
    pausedRef.current = true
    setState((s) => ({ ...s, paused: true }))
  }, [])

  /** Release the pause barrier; queued dispatches continue. Idempotent. */
  const resume = useCallback(() => {
    if (!pausedRef.current) return
    pausedRef.current = false
    setState((s) => ({ ...s, paused: false }))
    const waiters = resumeWaitersRef.current
    resumeWaitersRef.current = []
    for (const w of waiters) w()
  }, [])

  /**
   * Dispatch a user-typed shell command against the live session's `exec`
   * primitive. The terminal embed uses this to let the operator interleave
   * their own commands with the agent's, hitting the same channel as the
   * agent. Resolves to the raw text the guest returned (stdout/stderr
   * combined, as cua-driver formats it) or an error if no session is live.
   */
  const dispatchExec = useCallback(
    async (cmd: string): Promise<string> => {
      const conn = connRef.current
      const sessionId = state.sessionId
      if (!conn || !sessionId) {
        throw new Error('no live session')
      }
      const result = await conn.client.action(sessionId, {
        op: 'exec',
        payload: { cmd },
      })
      // cua-driver returns either a perception result (content blocks) or an
      // exec result with stdout/stderr/exit_code. Surface the latter cleanly;
      // the perception branch is only here for forward-compat.
      if (result && typeof result === 'object' && 'exit_code' in result) {
        const { stdout, stderr, exit_code } = result as {
          stdout?: string
          stderr?: string
          exit_code: number
        }
        const out = [stdout, stderr].filter((s) => s && s.length > 0).join('')
        return out || `exit ${exit_code}`
      }
      return JSON.stringify(result)
    },
    [state.sessionId],
  )

  /**
   * Cancel the session (abort any in-flight work) and reset.
   *
   * The loop no longer ends the VM on its own when the model finishes —
   * the operator owns lifecycle now. So `cancel()` is what actually
   * tears the session down: it issues `/end` against the driver in the
   * background (fire-and-forget so the call returns immediately) and
   * the idle reaper is the backstop if the request fails.
   */
  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    const conn = connRef.current
    const sessionId = stateRef.current.sessionId
    connRef.current = null
    if (conn && sessionId) {
      void conn.client.end(sessionId).catch(() => {
        /* idle reaper is the backstop */
      })
    }
    if (capabilityResolverRef.current) {
      capabilityResolverRef.current({ approved: false, reason: 'cancelled' })
    }
    pausedRef.current = false
    resumeWaitersRef.current = []
    setState(INITIAL)
  }, [])

  /**
   * Eagerly establish a refresh credential with the driver — runs the pairing
   * flow on its own, without a task or consent. Used by the "Connect" banner
   * and the unpaired-toggle click so users can prove the local driver is
   * reachable before they bother phrasing a computer-use request.
   *
   * Returns `true` on a fresh or already-valid pairing, `false` on failure
   * (the user can read the surfaced error from `state.error`).
   *
   * Distinct from `start()`: that opens a full session (pair → consent →
   * loop); `connect()` returns to `idle` once paired, leaving the next
   * `start()` to find the credential and skip pairing.
   */
  const connect = useCallback(async (): Promise<boolean> => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    // Drop into pairing phase so ComputerUseSessionDialog surfaces the code
    // modal automatically — same UI primitive used by start().
    setState({ ...INITIAL, phase: 'pairing' })
    try {
      let conn = getConnection()
      // If a stored credential exists, validate it cheaply before declaring
      // success. A stale/revoked one forces a re-pair.
      if (conn && typeof conn.tokens?.getAccessToken === 'function') {
        try {
          await conn.tokens.getAccessToken(ac.signal)
        } catch (err) {
          if (err instanceof DriverError && err.isAuthError) {
            forgetPairing()
            conn = null
          } else {
            throw err
          }
        }
      }
      if (!conn) {
        conn = await pair({
          onCode: (code) => patch({ pairingCode: code }),
          onState: (pairingState) => patch({ pairingState }),
          signal: ac.signal,
        })
      }
      connRef.current = conn
      // Back to idle — the next start() will reuse the credential.
      setState(INITIAL)
      return true
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return false
      patch({
        phase: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }, [getConnection, pair, patch])

  return {
    state,
    start,
    approve,
    approveCapability,
    denyCapability,
    cancel,
    connect,
    dispatchExec,
    pause,
    resume,
    getAccessToken,
  }
}
