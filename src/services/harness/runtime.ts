import {
  AUTH_ACTIVE_USER_ID,
  SETTINGS_CLOUD_SYNC_ENABLED,
  USER_PREFS_LOCAL_PROFILE,
  USER_PREFS_LOCAL_PROFILE_UPGRADED,
  USER_PREFS_PENDING_PROFILE_MERGE,
} from '@/constants/storage-keys'
import { encryptionService } from '@/services/encryption/encryption-service'
import {
  CLOUD_SYNC_SETTING_CHANGED_EVENT,
  isCloudSyncEnabled,
} from '@/utils/cloud-sync-settings'
import { logError } from '@/utils/error-handling'
import { HarnessClient } from './client'
import { prepareUpload } from './composer'
import {
  clearLocalProfileChanges,
  loadLocalProfile,
  localProfileChanges,
  saveLocalProfile,
} from './local-profile'
import { ERROR_CODES, ROUTES, type HarnessRoute } from './protocol'
import { HarnessError } from './sse'
import type { RateLimit, Session } from './types'

export type Profile = Record<string, any>
type View = {
  chatRevision?: string
  projectRevision?: string
  session?: Session
  profile: Profile
  error?: string
  // The content key is unlocked for the harness's stored chats. A signed-out
  // visitor needs no key.
  keyReady: boolean
  // The harness stores this account's chats and settings. Without cloud
  // sync, and for a signed-out visitor, both stay in the browser.
  cloud: boolean
  // The settings of the current storage mode have loaded.
  profileReady: boolean
  // The account's quota as the session and its runs last reported it.
  rateLimit?: RateLimit
}

const CHANGE_POLL_MS = 20_000
interface ChangeTokens {
  chats: string
  profile: string
  projects: string
}
const empty: View = {
  profile: {},
  keyReady: false,
  profileReady: false,
  cloud: false,
}
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

export interface RequestOptions {
  signal?: AbortSignal
  // The route reads no content key, as for the session, the account's key
  // and chats on this device. It outlives a change of the content key.
  keyless?: boolean
}

export class HarnessAPI {
  readonly lifetime = new AbortController()
  private contentLifetime = new AbortController()
  private profileVersion = 0
  private profileWrites: Promise<unknown> = Promise.resolve()
  private profileSource: 'cloud' | 'local' | null = null
  private changeTokens: ChangeTokens | undefined

  watchChanges() {
    let pending = false
    const check = async () => {
      if (
        pending ||
        !this.cloud ||
        !view.keyReady ||
        document.visibilityState === 'hidden'
      )
        return
      pending = true
      try {
        const tokens = await this.post<ChangeTokens>(
          ROUTES.changes,
          {},
          { keyless: true },
        )
        if (!this.cloud) return
        if (tokens.profile !== this.changeTokens?.profile) {
          await this.profileWrites.catch(() => {})
          await this.refreshProfile({ background: true })
        }
        this.lifetime.signal.throwIfAborted()
        if (!this.cloud) return
        this.changeTokens = tokens
        if (
          tokens.chats !== view.chatRevision ||
          tokens.projects !== view.projectRevision
        ) {
          publish({
            chatRevision: tokens.chats,
            projectRevision: tokens.projects,
          })
        }
      } catch (cause) {
        if (!this.lifetime.signal.aborted)
          logError('Failed to refresh remote changes', cause, {
            component: 'HarnessAPI',
            action: 'watchChanges',
          })
      } finally {
        pending = false
      }
    }
    const refresh = () => {
      void check()
    }
    const timer = window.setInterval(refresh, CHANGE_POLL_MS)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }
  invalidateKey() {
    this.changeTokens = undefined
    this.contentLifetime.abort()
    this.contentLifetime = new AbortController()
    this.profileVersion++
    publish({ profile: {}, keyReady: false, profileReady: false })
  }
  // The storage mode, which only a change of the cloud sync setting moves.
  private cloudSync = isCloudSyncEnabled()
  get cloud() {
    return !!this.userId && this.cloudSync
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
        code: ERROR_CODES.keyRequired,
        message: 'Wait for your account to finish unlocking.',
      })
    const bytes = encryptionService.getCurrentKeyBytes()
    if (!bytes)
      throw new HarnessError({
        code: ERROR_CODES.keyRequired,
        message: 'Unlock your encryption key in Settings to continue.',
      })
    try {
      return btoa(String.fromCharCode(...bytes))
    } finally {
      bytes.fill(0)
    }
  }
  // The content key a request carries, unless the route reads none.
  private keyed(keyless: boolean): Record<string, string> {
    const key = keyless ? undefined : this.key()
    return key ? { key } : {}
  }
  async post<T>(
    path: HarnessRoute,
    input: object = {},
    { signal, keyless = false }: RequestOptions = {},
  ): Promise<T> {
    const requestSignal = this.signal({ signal, keyless })
    const result = await this.client.post<T>(
      path,
      { ...this.keyed(keyless), ...input },
      requestSignal,
    )
    requestSignal.throwIfAborted()
    return result
  }
  // Ends with this API, and with the content key unless the request reads
  // none.
  signal({ signal, keyless = false }: RequestOptions = {}) {
    return AbortSignal.any([
      this.lifetime.signal,
      ...(keyless ? [] : [this.contentLifetime.signal]),
      ...(signal ? [signal] : []),
    ])
  }
  async upload<T>(
    path: HarnessRoute,
    file: File,
    fields: Record<string, string> = {},
    { signal, keyless = false }: RequestOptions = {},
  ): Promise<T> {
    const key = this.keyed(keyless)
    const requestSignal = this.signal({ signal, keyless })
    const groups =
      path === ROUTES.attachmentUpload
        ? view.session?.composer.attachments
        : path === ROUTES.projectDocumentUpload
          ? view.session?.composer.projectDocuments
          : undefined
    if (groups) file = await prepareUpload(file, groups)
    requestSignal.throwIfAborted()
    const result = await this.client.upload<T>(
      path,
      file,
      { ...key, ...fields },
      requestSignal,
    )
    requestSignal.throwIfAborted()
    return result
  }
  // A request whose response body streams, such as speech.
  async stream(
    path: HarnessRoute,
    input: object,
    { signal, keyless = false }: RequestOptions = {},
  ): Promise<Response> {
    const requestSignal = this.signal({ signal, keyless })
    const response = await this.client.stream(
      path,
      { ...this.keyed(keyless), ...input },
      requestSignal,
    )
    requestSignal.throwIfAborted()
    return response
  }
  // A multipart request whose response body streams. Its parts carry the
  // content key themselves when the route reads one.
  async multipart(
    path: HarnessRoute,
    form: FormData,
    { signal, keyless = false }: RequestOptions = {},
  ): Promise<Response> {
    const requestSignal = this.signal({ signal, keyless })
    const response = await this.client.multipart(path, form, requestSignal)
    requestSignal.throwIfAborted()
    return response
  }
  async download(
    path: HarnessRoute,
    input: object = {},
    { signal, keyless = false }: RequestOptions = {},
  ) {
    const requestSignal = this.signal({ signal, keyless })
    const result = await this.client.download(
      path,
      { ...this.keyed(keyless), ...input },
      requestSignal,
    )
    requestSignal.throwIfAborted()
    return result
  }

  // Shows the quota a session, a run or a refusal reported, as the harness
  // counted it, for this account only.
  reportRateLimit(rateLimit: RateLimit | undefined) {
    if (active !== this || this.lifetime.signal.aborted || !rateLimit) return
    if (JSON.stringify(rateLimit) !== JSON.stringify(view.rateLimit))
      publish({ rateLimit })
  }

  async refresh({ credentials = false }: { credentials?: boolean } = {}) {
    const session = await this.post<Session>(
      ROUTES.session,
      credentials ? { refreshCredentials: true } : {},
      { keyless: true },
    )
    publish({ session, error: undefined })
    this.reportRateLimit(session.rateLimit)
    await this.refreshProfile()
    return session
  }
  // The harness upgrades a local profile from what older clients stored,
  // once. A profile changed while it was upgraded is upgraded on a later
  // load.
  private async upgradeLocalProfile(profile: Profile, version: number) {
    if (localStorage.getItem(USER_PREFS_LOCAL_PROFILE_UPGRADED) === 'true')
      return
    if (Object.keys(profile).length) {
      const sent = JSON.stringify(profile)
      const upgraded = await this.post<{ profile: Profile }>(
        ROUTES.profileUpgrade,
        { profile },
        { keyless: true },
      )
      if (JSON.stringify(loadLocalProfile()) !== sent) return
      const saved = saveLocalProfile(upgraded.profile, true)
      if (version === this.profileVersion) publish({ profile: saved })
    }
    localStorage.setItem(USER_PREFS_LOCAL_PROFILE_UPGRADED, 'true')
  }
  async refreshProfile({ background = false }: { background?: boolean } = {}) {
    const version = ++this.profileVersion
    if (!this.cloud) {
      this.profileSource = 'local'
      const profile = loadLocalProfile()
      publish({
        profile,
        keyReady: !this.userId,
        profileReady: true,
        error: undefined,
      })
      await this.upgradeLocalProfile(profile, version).catch(reportHarnessError)
      return
    }
    try {
      const local =
        localStorage.getItem(USER_PREFS_PENDING_PROFILE_MERGE) === this.userId
          ? loadLocalProfile()
          : undefined
      const profile = local
        ? await this.post<Profile>(ROUTES.profileMerge, {
            profile: local,
            changedFields: localProfileChanges(),
          })
        : await this.post<Profile>(ROUTES.profileGet)
      if (version === this.profileVersion) {
        if (local) {
          clearLocalProfileChanges()
          localStorage.removeItem(USER_PREFS_PENDING_PROFILE_MERGE)
        }
        this.profileSource = 'cloud'
        publish({
          profile,
          keyReady: true,
          profileReady: true,
          error: undefined,
        })
      }
    } catch (cause) {
      this.lifetime.signal.throwIfAborted()
      if (version !== this.profileVersion) return
      if (background) throw cause
      publish({
        profile: {},
        keyReady: false,
        profileReady: false,
        error:
          cause instanceof Error
            ? cause.message
            : 'Unable to unlock your chats.',
      })
    }
  }
  // Cloud sync was turned on or off. Turning it off keeps the settings the
  // harness held, as the previous client kept synced settings on the device.
  async storageModeChanged() {
    for (;;) {
      const writes = this.profileWrites
      await writes.catch(() => {})
      if (writes === this.profileWrites) break
    }
    this.lifetime.signal.throwIfAborted()
    this.changeTokens = undefined
    if (!this.cloud && this.userId && isCloudSyncEnabled()) {
      try {
        localStorage.setItem(USER_PREFS_PENDING_PROFILE_MERGE, this.userId)
      } catch (cause) {
        localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, 'false')
        throw cause
      }
    }
    this.cloudSync = isCloudSyncEnabled()
    publish({ cloud: this.cloud })
    if (!this.cloud && this.profileSource === 'cloud' && view.profileReady) {
      saveLocalProfile(view.profile, true)
      clearLocalProfileChanges()
      localStorage.setItem(USER_PREFS_LOCAL_PROFILE_UPGRADED, 'true')
    }
    if (!this.cloud) localStorage.removeItem(USER_PREFS_PENDING_PROFILE_MERGE)
    this.invalidateKey()
    return this.refreshProfile()
  }
  updateProfile(
    change: Profile | ((current: Profile) => Profile),
  ): Promise<Profile> {
    const cloud = this.cloud
    const signal = this.signal({ keyless: !cloud })
    const update = this.profileWrites
      .catch(() => {})
      .then(async () => {
        signal.throwIfAborted()
        const version = ++this.profileVersion
        const patch =
          typeof change === 'function' ? change(view.profile) : change
        const profile = cloud
          ? await this.post<Profile>(
              ROUTES.profileUpdate,
              { patch },
              { signal },
            )
          : saveLocalProfile(patch)
        signal.throwIfAborted()
        if (version === this.profileVersion) publish({ profile })
        return profile
      })
    this.profileWrites = update
    return update
  }
}
// The active API follows the cloud sync setting, in this tab and others,
// and the settings another tab saves on the device.
function followStorage(api: HarnessAPI) {
  const modeChanged = () => {
    void api.storageModeChanged().catch(reportHarnessError)
  }
  const storageChanged = (event: StorageEvent) => {
    if (event.key === SETTINGS_CLOUD_SYNC_ENABLED) modeChanged()
    else if (event.key === USER_PREFS_LOCAL_PROFILE && !api.cloud)
      void api.refreshProfile().catch(reportHarnessError)
  }
  window.addEventListener(CLOUD_SYNC_SETTING_CHANGED_EVENT, modeChanged)
  window.addEventListener('storage', storageChanged)
  return () => {
    window.removeEventListener(CLOUD_SYNC_SETTING_CHANGED_EVENT, modeChanged)
    window.removeEventListener('storage', storageChanged)
  }
}
let unfollow: (() => void) | undefined

function deactivate() {
  active?.lifetime.abort()
  active?.client.dispose?.()
  unfollow?.()
  unfollow = undefined
  active = undefined
  view = empty
}

export function activateAPI(api: HarnessAPI) {
  deactivate()
  active = api
  unfollow = followStorage(api)
  publish({ cloud: api.cloud })
  return () => {
    api.lifetime.abort()
    api.client.dispose?.()
    if (active === api) {
      deactivate()
      publish({})
    }
  }
}
export function harnessAPI(): HarnessAPI {
  if (!active)
    throw new HarnessError({
      code: ERROR_CODES.unauthenticated,
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
  deactivate()
  publish({})
}
