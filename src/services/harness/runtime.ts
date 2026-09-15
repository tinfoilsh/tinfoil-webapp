import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import { encryptionService } from '@/services/encryption/encryption-service'
import type { Project } from '@/types/project'
import { HarnessClient } from './client'
import { OptimisticStore } from './optimistic-store'
import { HarnessError } from './sse'
import type { Session } from './types'

export type Profile = Record<string, any>
type View = {
  session?: Session
  profile: Profile
  error?: string
  keyReady: boolean
}
const empty: View = { profile: {}, keyReady: false }
let view: View = empty
const listeners = new Set<() => void>()
let active: HarnessAPI | undefined
export const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const getView = () => view
export const getServerView = () => empty
export function publish(patch: Partial<View>) {
  view = { ...view, ...patch }
  for (const listener of listeners) listener()
}

export class HarnessAPI {
  readonly lifetime = new AbortController()
  private contentLifetime = new AbortController()
  private profileVersion = 0
  private profileState = new OptimisticStore<Profile>({}, (profile) =>
    publish({ profile }),
  )
  readonly projects = new OptimisticStore<Project[]>([])
  invalidateKey() {
    this.contentLifetime.abort()
    this.contentLifetime = new AbortController()
    this.profileVersion++
    this.profileState.reset({})
    this.projects.reset([])
    publish({ profile: {}, keyReady: false })
  }
  constructor(
    readonly client: HarnessClient,
    readonly userId: string | null,
  ) {}
  key() {
    this.lifetime.signal.throwIfAborted()
    if (!this.userId) return undefined
    if (localStorage.getItem(AUTH_ACTIVE_USER_ID) !== this.userId)
      throw new HarnessError({
        code: 'KEY_REQUIRED',
        message: 'Wait for your account to finish unlocking.',
      })
    const bytes = encryptionService.getCurrentKeyBytes()
    if (!bytes)
      throw new HarnessError({
        code: 'KEY_REQUIRED',
        message: 'Unlock your encryption key in Settings to continue.',
      })
    try {
      return btoa(String.fromCharCode(...bytes))
    } finally {
      bytes.fill(0)
    }
  }
  async post<T = any>(
    path: string,
    input: Record<string, unknown> = {},
    signal?: AbortSignal,
    withKey = true,
  ): Promise<T> {
    const requestSignal = this.signal(signal, withKey)
    const result = await this.client.post<T>(
      path,
      { ...(withKey ? { key: this.key() } : {}), ...input },
      requestSignal,
    )
    requestSignal.throwIfAborted()
    return result
  }
  signal(signal?: AbortSignal, withKey = true) {
    return AbortSignal.any([
      this.lifetime.signal,
      ...(withKey ? [this.contentLifetime.signal] : []),
      ...(signal ? [signal] : []),
    ])
  }
  async upload<T = any>(
    path: string,
    file: File,
    fields: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const key = this.key()
    const requestSignal = this.signal(signal)
    const result = await this.client.upload<T>(
      path,
      file,
      { ...(key ? { key } : {}), ...fields },
      requestSignal,
    )
    requestSignal.throwIfAborted()
    return result
  }
  async download(
    path: string,
    input: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) {
    const requestSignal = this.signal(signal)
    const result = await this.client.download(
      path,
      { key: this.key(), ...input },
      requestSignal,
    )
    requestSignal.throwIfAborted()
    return result
  }

  async refresh() {
    const session = await this.post<Session>(
      '/v1/session',
      {},
      undefined,
      false,
    )
    if (
      session.user.anonymous &&
      !session.rateLimit.kind &&
      this.client.anonymousRateLimit
    )
      session.rateLimit = this.client.anonymousRateLimit
    publish({ session, error: undefined })
    await this.refreshProfile()
    return session
  }
  async refreshProfile() {
    const version = ++this.profileVersion
    if (!this.userId) {
      publish({ keyReady: true })
      return
    }
    try {
      await this.profileState.read(
        () => this.post<Profile>('/v1/profile/get'),
        this.signal(),
      )
      if (version === this.profileVersion)
        publish({ keyReady: true, error: undefined })
    } catch (cause) {
      this.lifetime.signal.throwIfAborted()
      if (version !== this.profileVersion) return
      publish({
        profile: {},
        keyReady: false,
        error:
          cause instanceof Error
            ? cause.message
            : 'Unable to unlock your chats.',
      })
    }
  }
  updateProfile(
    change: Profile | ((current: Profile) => Profile),
  ): Promise<Profile> {
    const signal = this.signal()
    if (signal.aborted) return Promise.reject(signal.reason)
    if (this.profileState.getSnapshot() !== view.profile)
      this.profileState.set(() => view.profile)
    const patch = (profile: Profile) =>
      typeof change === 'function' ? change(profile) : change
    return this.profileState.mutate(
      (profile) => ({ ...profile, ...patch(profile) }),
      (profile) =>
        this.userId
          ? this.post<Profile>(
              '/v1/profile/update',
              { patch: patch(profile) },
              signal,
            )
          : Promise.resolve({ ...profile, ...patch(profile) }),
      signal,
      (_profile, saved) => saved,
    )
  }
}
export function activateAPI(api: HarnessAPI) {
  active?.lifetime.abort()
  active?.client.dispose?.()
  active = api
  view = empty
  publish({})
  return () => {
    api.lifetime.abort()
    api.client.dispose?.()
    if (active === api) {
      active = undefined
      view = empty
      publish({})
    }
  }
}
export function harnessAPI(): HarnessAPI {
  if (!active)
    throw new HarnessError({
      code: 'UNAUTHENTICATED',
      message: 'Wait for your session to load.',
    })
  return active
}
export function reportHarnessError(error: unknown) {
  if (error instanceof DOMException && error.name === 'AbortError') return
  publish({
    error:
      error instanceof Error
        ? error.message
        : 'The chat service could not complete the request.',
  })
}

export function resetHarnessAPI() {
  active?.lifetime.abort()
  active?.client.dispose?.()
  active = undefined
  view = empty
  publish({})
}
