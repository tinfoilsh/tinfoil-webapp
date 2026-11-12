import { EnclaveHTTPClient } from 'tinfoil'
import { AnonymousCredentialCache } from './anonymous-credential'
import { ChatCredentialCache } from './chat-credential'
import { DEFAULT_CONTROLPLANE_URL } from './config'
import {
  actionOf,
  ERROR_ACTIONS,
  ERROR_CODES,
  HARNESS_INSTANCE_HEADER,
  INFERENCE_KEY_HEADER,
  invalidResponse,
  LAST_EVENT_ID_HEADER,
  RESPONSE_NONCE_HEADER,
  ROUTES,
  unanswered,
  unconfirmed,
  unsealedRefusal,
  unverified,
  type HarnessRoute,
  type RunRoute,
} from './protocol'
import { HarnessError, readEvents } from './sse'
import type {
  FollowInput,
  Frame,
  HarnessErrorBody,
  RateLimit,
  Turn,
} from './types'

const harnessRepo = 'tinfoilsh/confidential-tinfoil-harness'
// An attestation that has not finished by then is abandoned: the request
// fails, and the next one verifies the enclave again.
const ATTESTATION_TIMEOUT_MS = 20_000
// A request a chat route answers at once is abandoned when no answer has
// arrived by then, so a connection that stalled fails it rather than
// holding it. It also has the time its body takes to send at this many
// bytes a millisecond, as over a slow connection.
export const REQUEST_TIMEOUT_MS = 30_000
const SLOW_UPLOAD_BYTES_PER_MS = 32
export type GetToken = (options?: {
  skipCache?: boolean
}) => Promise<string | null>
type Transport = Pick<EnclaveHTTPClient, 'fetch' | 'ensureVerified'>
// Verifies the chat service's enclave and connects to it. The signal ends a
// verification that was abandoned.
export type Connect = (signal: AbortSignal) => Promise<Transport>
export type Verification = Awaited<ReturnType<Transport['ensureVerified']>>

// A follow as this client makes it: the body the protocol names, and the
// last event of the run it applied, which it sends as Last-Event-ID.
export type FollowRequest = FollowInput & { lastEventId?: number }

// What a request says in its headers beyond who is asking, and the chat
// whose run it starts or is about.
interface RouteHeaders {
  instance?: string
  lastEventId?: number
  threadId?: string
}

const threadOf = (input: unknown): string | undefined => {
  if (!input || typeof input !== 'object') return
  const { threadId } = input as { threadId?: unknown }
  return typeof threadId === 'string' ? threadId : undefined
}

// The routes about a chat's run, which go to the instance holding it.
const RUN_ROUTES: ReadonlySet<HarnessRoute> = new Set([
  ROUTES.follow,
  ROUTES.cancel,
  ROUTES.queueSend,
  ROUTES.queueRemove,
  ROUTES.browserResult,
])

// Non-streaming routes that must answer by a deadline. A search whose index
// is not ready answers so; the harness rebuilds it in the background.
const PROMPT_ROUTES: ReadonlySet<HarnessRoute> = new Set([
  ROUTES.remoteImage,
  ROUTES.changes,
  ROUTES.list,
  ROUTES.search,
  ROUTES.get,
  ROUTES.update,
  ROUTES.delete,
  ROUTES.messageDelete,
  ROUTES.messageUpdate,
  ROUTES.messageAnswer,
  ROUTES.browserResult,
])

// Sends a request that must be answered by a deadline. One that is not
// fails as unanswered, unless the caller ended it first, even while a step
// that takes no signal, such as reading the account's token, holds it.
async function withDeadline<T>(
  ms: number,
  signal: AbortSignal | undefined,
  send: (signal: AbortSignal) => Promise<T>,
  failure: () => HarnessErrorBody = unanswered,
): Promise<T> {
  const deadline = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      deadline.abort()
      reject(new HarnessError(failure()))
    }, ms)
  })
  try {
    return await Promise.race([
      send(
        signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
      ),
      expired,
    ])
  } catch (cause) {
    if (deadline.signal.aborted && !signal?.aborted)
      throw new HarnessError(failure())
    throw cause
  } finally {
    clearTimeout(timer)
  }
}

export class HarnessClient {
  private readonly origin: string
  // The host of the chat service's enclave.
  readonly enclave: string
  private readonly anonymous: AnonymousCredentialCache
  private readonly chat: ChatCredentialCache
  private secure?: Promise<Transport>
  private readonly lifetime = new AbortController()
  // Told the quota the control plane reports as this account's chat access
  // is minted or refused.
  onRateLimit?: (rateLimit: RateLimit) => void
  // The instance holding each chat's latest run, by chat, which requests
  // about the chat's runs are routed to.
  private readonly instances = new Map<string, string>()
  // The free key each signed-out chat's latest turn was sent with, by chat.
  // The harness keeps a signed-out caller's runs under the key, so requests
  // about the chat's runs present it even once another key replaced it, as
  // at the end of the key's day.
  private readonly runKeys = new Map<string, string>()

  dispose() {
    this.lifetime.abort()
    this.anonymous.dispose()
    this.chat.dispose()
  }

  constructor(
    url: string,
    private readonly getToken: GetToken,
    private readonly connect: Connect = (signal) =>
      EnclaveHTTPClient.create(new URL(url).host, harnessRepo, { signal }),
    controlplaneURL = DEFAULT_CONTROLPLANE_URL,
  ) {
    this.anonymous = new AnonymousCredentialCache(controlplaneURL)
    this.chat = new ChatCredentialCache(
      (limit) => this.onRateLimit?.(limit),
      controlplaneURL,
    )
    const parsed = new URL(url)
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new HarnessError({
        code: ERROR_CODES.configuration,
        action: ERROR_ACTIONS.stop,
        message: 'Configure an HTTPS origin for the chat service.',
      })
    }
    this.origin = parsed.origin
    this.enclave = parsed.host
  }

  // The attested connection to the chat service, which exists once its
  // enclave is verified. One that could not be made is forgotten, so the
  // next request verifies the enclave again.
  private connection(): Promise<Transport> {
    if (this.secure) return this.secure
    const secure = withDeadline(
      ATTESTATION_TIMEOUT_MS,
      undefined,
      this.connect,
      unverified,
    )
    this.secure = secure
    secure.catch(() => {
      if (this.secure === secure) this.secure = undefined
    })
    return secure
  }

  // The connection once the verification of its enclave is valid, and what
  // that verification proved. One that has expired is made again.
  private async attested() {
    const secure = await this.connection()
    const verification = await withDeadline(
      ATTESTATION_TIMEOUT_MS,
      undefined,
      (signal) => secure.ensureVerified({ signal }),
      unverified,
    )
    return { secure, verification }
  }

  async verify(): Promise<Verification> {
    return (await this.attested()).verification
  }

  // Mints the account's chat access again, as when its subscription changed
  // or its hourly cap may have lifted.
  async renewCredential(signal?: AbortSignal) {
    const token = await this.getToken()
    if (!token) return
    await this.chat.renew(token, signal)
  }

  private async request(
    path: HarnessRoute,
    body: string | FormData,
    signal?: AbortSignal,
    { instance, lastEventId, threadId }: RouteHeaders = {},
  ): Promise<Response> {
    if (!/^\/v1\/(?:[a-z-]+\/)*[a-z-]+$/.test(path)) {
      throw new HarnessError({
        code: ERROR_CODES.badRequest,
        action: ERROR_ACTIONS.stop,
        message: 'Invalid chat service path.',
      })
    }
    signal?.throwIfAborted()
    const { secure } = await this.attested()
    let token = await this.getToken()
    const anonymous = !token
    if (anonymous) {
      token =
        (threadId && RUN_ROUTES.has(path) && this.runKeys.get(threadId)) ||
        (await this.anonymous.get(signal))
      // The provider's getter rejects calls after an account change.
      if (await this.getToken())
        throw new DOMException('Account changed', 'AbortError')
    }
    // A signed-in request carries the account's chat access. A request that
    // needs none still goes when the control plane refused it, as at an
    // hourly cap; one that needs it fails with that refusal.
    let credential: string | undefined
    let refusal: unknown
    const mint = async () => {
      credential = refusal = undefined
      try {
        credential = await this.chat.get(token!, signal)
      } catch (cause) {
        if (signal?.aborted) throw cause
        refusal = cause
      }
    }
    if (!anonymous) await mint()
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted()
      const headers = new Headers()
      if (typeof navigator !== 'undefined') {
        const locales = navigator.languages?.length
          ? navigator.languages
          : [navigator.language]
        headers.set('Accept-Language', locales.join(','))
      }
      if (typeof body === 'string')
        headers.set('Content-Type', 'application/json')
      if (token) headers.set('Authorization', `Bearer ${token}`)
      if (credential) headers.set(INFERENCE_KEY_HEADER, credential)
      if (instance) headers.set(HARNESS_INSTANCE_HEADER, instance)
      if (lastEventId !== undefined)
        headers.set(LAST_EVENT_ID_HEADER, String(lastEventId))
      const response = await secure.fetch(this.origin + path, {
        method: 'POST',
        headers,
        body,
        signal,
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
      })
      if (response.ok) {
        if (anonymous && threadId && path === ROUTES.turn)
          this.runKeys.set(threadId, token!)
        return response
      }
      if (!response.headers.has(RESPONSE_NONCE_HEADER))
        throw new HarnessError(unsealedRefusal())
      // A refusal without the harness's error envelope, or one that names
      // no action, is not one the protocol allows.
      let detail = invalidResponse()
      const value: unknown = await response.json().catch(() => null)
      if (
        value &&
        typeof value === 'object' &&
        'error' in value &&
        value.error &&
        typeof value.error === 'object' &&
        'code' in value.error &&
        typeof value.error.code === 'string' &&
        'message' in value.error &&
        typeof value.error.message === 'string' &&
        'action' in value.error &&
        typeof value.error.action === 'string'
      )
        detail = {
          ...(value.error as HarnessErrorBody),
          action: actionOf(value.error.action),
        }
      const needsCredential = detail.code === ERROR_CODES.credentialRequired
      if (
        detail.action === ERROR_ACTIONS.reauthenticate &&
        token &&
        attempt === 0
      ) {
        if (anonymous) {
          this.anonymous.reject(token)
          token = await this.anonymous.get(signal)
          if (await this.getToken())
            throw new DOMException('Account changed', 'AbortError')
        } else {
          token = await this.getToken({ skipCache: true })
          // Access the harness refused is minted again; a refusal the
          // control plane gave is kept until it says to retry.
          if (token) {
            if (credential && needsCredential) this.chat.reset()
            await mint()
          }
        }
        if (!token)
          throw new HarnessError(
            {
              code: ERROR_CODES.unauthenticated,
              action: ERROR_ACTIONS.reauthenticate,
              message: 'Sign in again to continue.',
            },
            401,
          )
        continue
      }
      if (needsCredential && refusal) throw refusal
      // Refused again with what the account just renewed: it is signed in.
      if (detail.action === ERROR_ACTIONS.reauthenticate && !anonymous)
        throw new HarnessError(unconfirmed())
      throw new HarnessError(detail, response.status)
    }
    throw new HarnessError(
      {
        code: ERROR_CODES.unauthenticated,
        action: ERROR_ACTIONS.reauthenticate,
        message: 'Sign in again to continue.',
      },
      401,
    )
  }

  async post<T>(
    path: HarnessRoute,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const body = JSON.stringify(input)
    const send = async (signal?: AbortSignal) => {
      const response = await this.request(path, body, signal, {
        instance: this.instanceFor(path, input),
        threadId: threadOf(input),
      })
      try {
        return (await response.json()) as T
      } catch (cause) {
        // An answer that is not JSON is not one the protocol allows. One that
        // stopped arriving is a lost connection, and fails as it is.
        if (cause instanceof SyntaxError)
          throw new HarnessError(invalidResponse(), response.status)
        throw cause
      }
    }
    return PROMPT_ROUTES.has(path)
      ? withDeadline(
          REQUEST_TIMEOUT_MS +
            Math.floor(
              new TextEncoder().encode(body).byteLength /
                SLOW_UPLOAD_BYTES_PER_MS,
            ),
          signal,
          send,
        )
      : send(signal)
  }
  // Routes requests about a chat's run to the instance a hint names, for a
  // run this client did not see start.
  locate(threadId: string, instance: string) {
    this.instances.set(threadId, instance)
  }
  // The instance a request about a chat's run goes to, once the chat's run
  // named it.
  private instanceFor(path: HarnessRoute, input: unknown): string | undefined {
    const threadId = threadOf(input)
    return RUN_ROUTES.has(path) && threadId
      ? this.instances.get(threadId)
      : undefined
  }
  async upload<T>(
    path: HarnessRoute,
    file: File,
    fields: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T> {
    const form = new FormData()
    for (const [name, value] of Object.entries(fields)) form.set(name, value)
    form.set('file', file)
    return (await this.request(path, form, signal)).json() as Promise<T>
  }
  async download(
    path: HarnessRoute,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<Blob> {
    return (await this.request(path, JSON.stringify(input), signal)).blob()
  }
  // A multipart request whose response body the caller reads as it arrives,
  // such as an archive.
  async multipart(
    path: HarnessRoute,
    form: FormData,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.request(path, form, signal)
  }
  // A response whose body the caller reads as it arrives, such as read-aloud
  // audio. Aborting the signal ends the body; the caller cancels it when it
  // stops reading early.
  async stream(
    path: HarnessRoute,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.request(path, JSON.stringify(input), signal)
  }
  // A run's events. Following a run replays it from its first frame.
  async *events(
    path: RunRoute,
    input: Turn | FollowRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<Frame> {
    let body: Turn | FollowInput = input
    let lastEventId: number | undefined
    if ('lastEventId' in input) ({ lastEventId, ...body } = input)
    const response = await this.request(path, JSON.stringify(body), signal, {
      instance: this.instanceFor(path, input),
      lastEventId,
      threadId: threadOf(input),
    })
    if (
      !response.headers
        .get('Content-Type')
        ?.toLowerCase()
        .startsWith('text/event-stream') ||
      !response.body
    ) {
      throw new HarnessError({
        code: ERROR_CODES.invalidStream,
        action: ERROR_ACTIONS.stop,
        message: 'The chat service did not return an event stream.',
      })
    }
    for await (const frame of readEvents(response.body)) {
      if (frame.event.type === 'RUN_STARTED')
        this.instances.set(frame.event.threadId, frame.event.instance)
      yield frame
    }
  }
}
