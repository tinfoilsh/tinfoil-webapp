import { logError } from '@/utils/error-handling'
import { SecureClient } from 'tinfoil'
import { AnonymousCredentialCache } from './anonymous-credential'
import { ChatCredentialCache } from './chat-credential'
import {
  actionOf,
  ERROR_ACTIONS,
  ERROR_CODES,
  INFERENCE_KEY_HEADER,
  ROUTES,
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
// fails, and the next one verifies the enclave again with a new client.
const ATTESTATION_TIMEOUT_MS = 20_000
// A live run's chat token that could not be minted again, for a reason that
// names no time to ask again, is asked for again after this long.
const RUN_RENEWAL_RETRY_MS = 30_000
type GetToken = (options?: { skipCache?: boolean }) => Promise<string | null>
type Transport = Pick<
  SecureClient,
  'ready' | 'fetch' | 'getVerificationDocument'
>

export class HarnessClient {
  private readonly origin: string
  private readonly anonymous = new AnonymousCredentialCache()
  private readonly chat = new ChatCredentialCache((rateLimit) =>
    this.onRateLimit?.(rateLimit),
  )
  private secure: Transport
  private readonly lifetime = new AbortController()
  // The run streams this page reads, and the renewal of the chat token their
  // model calls use.
  private openRuns = 0
  private runRenewal?: ReturnType<typeof setTimeout>
  // Told the quota the control plane reports as this account's chat access
  // is minted or refused.
  onRateLimit?: (rateLimit: RateLimit) => void

  dispose() {
    this.lifetime.abort()
    clearTimeout(this.runRenewal)
    this.anonymous.dispose()
    this.chat.dispose()
  }

  constructor(
    url: string,
    private readonly getToken: GetToken,
    private readonly createTransport: () => Transport = () =>
      new SecureClient({ enclaveURL: url, configRepo: harnessRepo }),
  ) {
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
    this.secure = createTransport()
  }

  async ready() {
    const secure = this.secure
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        secure.ready(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            if (this.secure === secure) this.secure = this.createTransport()
            reject(
              new HarnessError({
                code: ERROR_CODES.connection,
                action: ERROR_ACTIONS.retry,
                message:
                  'The chat service could not be verified in time. Check your connection and try again.',
              }),
            )
          }, ATTESTATION_TIMEOUT_MS)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  get verification() {
    return this.secure.getVerificationDocument()
  }

  // Mints the account's chat access again, as when its subscription changed
  // or its hourly cap may have lifted.
  async renewCredential(signal?: AbortSignal) {
    const token = await this.getToken()
    if (!token) return
    await this.chat.renew(token, signal)
  }

  // A run's model calls can outlast the chat token it started with. While a
  // run stream is open, the token is minted again as it enters its renewal
  // window and presented to the harness, which gives a run whose token
  // expired the newest one the account presented.
  private scheduleRunRenewal() {
    clearTimeout(this.runRenewal)
    this.runRenewal = undefined
    const at = this.openRuns > 0 ? this.chat.renewsAt() : undefined
    if (at === undefined || this.lifetime.signal.aborted) return
    const delay = at - Date.now()
    this.runRenewal = setTimeout(
      () => void this.renewForRuns(),
      delay > 0 ? delay : RUN_RENEWAL_RETRY_MS,
    )
  }

  private async renewForRuns() {
    this.runRenewal = undefined
    try {
      // Another request may have renewed and presented it since.
      if ((this.chat.renewsAt() ?? Infinity) <= Date.now()) {
        const response = await this.request(
          ROUTES.session,
          '{}',
          this.lifetime.signal,
        )
        await response.body?.cancel()
      }
    } catch (cause) {
      if (!this.lifetime.signal.aborted)
        logError('Failed to renew chat access for a running reply', cause, {
          component: 'HarnessClient',
          action: 'renewForRuns',
        })
    } finally {
      this.scheduleRunRenewal()
    }
  }

  private async request(
    path: HarnessRoute,
    body: string | FormData,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (!/^\/v1\/(?:[a-z-]+\/)*[a-z-]+$/.test(path)) {
      throw new HarnessError({
        code: ERROR_CODES.badRequest,
        action: ERROR_ACTIONS.stop,
        message: 'Invalid chat service path.',
      })
    }
    signal?.throwIfAborted()
    await this.ready()
    let token = await this.getToken()
    const anonymous = !token
    if (anonymous) {
      token = await this.anonymous.get(signal)
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
      const response = await this.secure.fetch(this.origin + path, {
        method: 'POST',
        headers,
        body,
        signal,
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
      })
      if (response.ok) return response
      // A refusal without the harness's error envelope names no action.
      let detail: HarnessErrorBody = {
        code: ERROR_CODES.upstreamRefused,
        action: actionOf(
          undefined,
          ERROR_CODES.upstreamRefused,
          response.status,
        ),
        message: 'The chat service could not complete the request.',
      }
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
        typeof value.error.message === 'string'
      )
        detail = {
          ...(value.error as HarnessErrorBody),
          action: actionOf(
            'action' in value.error ? value.error.action : undefined,
            value.error.code,
            response.status,
          ),
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
    return (
      await this.request(path, JSON.stringify(input), signal)
    ).json() as Promise<T>
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
    input: Turn | FollowInput,
    signal?: AbortSignal,
  ): AsyncGenerator<Frame> {
    const response = await this.request(path, JSON.stringify(input), signal)
    if (
      !response.headers
        .get('Content-Type')
        ?.toLowerCase()
        .startsWith('text/event-stream') ||
      !response.body
    ) {
      throw new HarnessError({
        code: ERROR_CODES.invalidStream,
        action: ERROR_ACTIONS.retry,
        message: 'The chat service did not return an event stream.',
      })
    }
    if (++this.openRuns === 1) this.scheduleRunRenewal()
    try {
      yield* readEvents(response.body)
    } finally {
      if (--this.openRuns === 0) this.scheduleRunRenewal()
    }
  }
}
