import { SecureClient } from 'tinfoil'
import { AnonymousCredentialCache } from './anonymous-credential'
import { HarnessError, readEvents } from './sse'
import type { Frame, HarnessErrorBody, Session, Turn } from './types'

const harnessRepo = 'tinfoilsh/confidential-tinfoil-harness'
type GetToken = (options?: { skipCache?: boolean }) => Promise<string | null>
type Transport = Pick<
  SecureClient,
  'ready' | 'fetch' | 'getVerificationDocument'
>

export class HarnessClient {
  private readonly origin: string
  private readonly anonymous = new AnonymousCredentialCache()

  get anonymousRateLimit() {
    return this.anonymous.rateLimit
  }

  dispose() {
    this.anonymous.dispose()
  }

  constructor(
    url: string,
    private readonly getToken: GetToken,
    private readonly secure: Transport = new SecureClient({
      enclaveURL: url,
      configRepo: harnessRepo,
    }),
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
        code: 'CONFIGURATION',
        message: 'Configure an HTTPS origin for the chat service.',
      })
    }
    this.origin = parsed.origin
  }

  async ready() {
    await this.secure.ready()
  }
  get verification() {
    return this.secure.getVerificationDocument()
  }

  private async request(
    path: string,
    body: string | FormData,
    signal?: AbortSignal,
    lastEventId?: number,
  ): Promise<Response> {
    if (!/^\/v1\/(?:[a-z-]+\/)*[a-z-]+$/.test(path)) {
      throw new HarnessError({
        code: 'BAD_REQUEST',
        message: 'Invalid chat service path.',
      })
    }
    if (
      lastEventId !== undefined &&
      (!Number.isSafeInteger(lastEventId) || lastEventId < 0)
    ) {
      throw new HarnessError({
        code: 'BAD_REQUEST',
        message: 'Invalid run cursor.',
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
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted()
      const headers = new Headers()
      if (typeof body === 'string')
        headers.set('Content-Type', 'application/json')
      if (token) headers.set('Authorization', `Bearer ${token}`)
      if (lastEventId !== undefined)
        headers.set('Last-Event-ID', String(lastEventId))
      const response = await this.secure.fetch(this.origin + path, {
        method: 'POST',
        headers,
        body,
        signal,
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
      })
      if (response.status === 401 && token && attempt === 0) {
        await response.body?.cancel()
        if (anonymous) {
          this.anonymous.reject(token)
          token = await this.anonymous.get(signal)
          if (await this.getToken())
            throw new DOMException('Account changed', 'AbortError')
        } else token = await this.getToken({ skipCache: true })
        if (!token)
          throw new HarnessError(
            { code: 'UNAUTHENTICATED', message: 'Sign in again to continue.' },
            401,
          )
        continue
      }
      if (!response.ok) {
        let detail: HarnessErrorBody = {
          code: 'UPSTREAM_REFUSED',
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
          detail = value.error as HarnessErrorBody
        if (anonymous && detail.code === 'QUOTA_EXHAUSTED')
          this.anonymous.exhausted()
        throw new HarnessError(detail, response.status)
      }
      return response
    }
    throw new HarnessError(
      { code: 'UNAUTHENTICATED', message: 'Sign in again to continue.' },
      401,
    )
  }

  async post<T>(
    path: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    return (
      await this.request(path, JSON.stringify(input), signal)
    ).json() as Promise<T>
  }
  session(signal?: AbortSignal) {
    return this.post<Session>('/v1/session', {}, signal)
  }
  async upload<T>(
    path: string,
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
    path: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<Blob> {
    return (await this.request(path, JSON.stringify(input), signal)).blob()
  }
  async *events(
    path: '/v1/threads/turn' | '/v1/threads/follow',
    input: Turn | { key?: string; threadId: string; runId: string },
    signal?: AbortSignal,
    lastEventId?: number,
  ): AsyncGenerator<Frame> {
    const response = await this.request(
      path,
      JSON.stringify(input),
      signal,
      lastEventId,
    )
    if (
      !response.headers
        .get('Content-Type')
        ?.toLowerCase()
        .startsWith('text/event-stream') ||
      !response.body
    ) {
      throw new HarnessError({
        code: 'INVALID_STREAM',
        message: 'The chat service did not return an event stream.',
      })
    }
    for await (const frame of readEvents(response.body)) {
      // Refresh issuance metadata after a run. A started run is never
      // replayed automatically when a downstream credential expires.
      if (
        frame.event.type === 'RUN_ERROR' &&
        frame.event.code === 'QUOTA_EXHAUSTED'
      )
        this.anonymous.exhausted()
      if (
        frame.event.type === 'RUN_FINISHED' ||
        frame.event.type === 'RUN_ERROR'
      )
        this.anonymous.invalidate()
      yield frame
    }
  }
}
