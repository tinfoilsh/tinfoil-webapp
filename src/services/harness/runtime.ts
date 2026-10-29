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
import {
  clearCloudProfileCache,
  readCloudProfileCache,
  writeCloudProfileCache,
} from './cloud-profile-cache'
import { prepareUpload } from './composer'
import {
  clearLocalProfileChanges,
  loadLocalProfile,
  localProfileChanges,
  saveLocalProfile,
} from './local-profile'
import {
  ERROR_ACTIONS,
  ERROR_CODES,
  ROUTES,
  type HarnessRoute,
} from './protocol'
import { HarnessError } from './sse'
import type { Json, RateLimit, Session, TokenBudget } from './types'

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
  keyLocked: boolean
  // The harness stores this account's chats and settings. Without cloud
  // sync, and for a signed-out visitor, both stay in the browser.
  cloud: boolean
  // The settings of the current storage mode have loaded.
  profileReady: boolean
  // The account's quota as the session and its runs last reported it.
  rateLimit?: RateLimit
}

const CHANGE_POLL_MS = 20_000
// The kinds of quota this client shows.
const RATE_LIMIT_KINDS: ReadonlySet<unknown> = new Set(['free_daily', 'hourly'])
interface ChangeTokens {
  chats: string
  profile: string
  projects: string
}
const empty: View = {
  profile: {},
  keyReady: false,
  keyLocked: false,
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
  // The profile as last stored, and the changes still being saved, which the
  // view shows over it in the order they were made.
  private storedProfile: Profile = {}
  private unsavedProfile: Profile[] = []
  private changeTokens: ChangeTokens | undefined

  private showProfile(stored: Profile, fields: Partial<View> = {}) {
    this.storedProfile = stored
    publish({
      ...fields,
      profile: Object.assign({}, stored, ...this.unsavedProfile),
    })
  }

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
    this.showProfile(this.keptProfile(), {
      keyReady: false,
      keyLocked: false,
      profileReady: false,
    })
  }
  // The storage mode, which only a change of the cloud sync setting moves.
  private cloudSync = isCloudSyncEnabled()
  get cloud() {
    return !!this.userId && this.cloudSync
  }
  // The cloud profile this device kept, shown until the harness's loads and
  // while the key is refused.
  keptProfile(): Profile {
    return this.cloud ? readCloudProfileCache(this.userId) : {}
  }
  constructor(
    readonly client: HarnessClient,
    readonly userId: string | null,
  ) {
    // A successful mint can explicitly clear the previous quota. A keyless
    // harness report carries no such authority.
    client.onRateLimit = (rateLimit) => {
      if (active === this && !this.lifetime.signal.aborted)
        publish({ rateLimit })
    }
  }
  key() {
    this.lifetime.signal.throwIfAborted()
    if (!this.userId) return undefined
    if (localStorage.getItem(AUTH_ACTIVE_USER_ID) !== this.userId)
      throw new HarnessError({
        code: ERROR_CODES.keyRequired,
        action: ERROR_ACTIONS.retry,
        message: 'Wait for your account to finish unlocking.',
      })
    const bytes = encryptionService.getCurrentKeyBytes()
    if (!bytes)
      throw new HarnessError({
        code: ERROR_CODES.keyRequired,
        action: ERROR_ACTIONS.unlock,
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

  // Shows the quota a session, a run, a refusal or the account's chat access
  // reported, for this account only. The harness reports none for a
  // subscriber, whose quota came with its chat access. A quota of a kind this
  // client does not know replaces the one shown with none.
  reportRateLimit(rateLimit: RateLimit | undefined) {
    if (active !== this || this.lifetime.signal.aborted || !rateLimit?.kind)
      return
    const shown = RATE_LIMIT_KINDS.has(rateLimit.kind) ? rateLimit : undefined
    if (JSON.stringify(shown) !== JSON.stringify(view.rateLimit))
      publish({ rateLimit: shown })
  }

  // A run's spend comes off the hourly budget the account's chat access
  // reported, until the access is minted again with the control plane's
  // count.
  reportUsage(usage: Json | undefined) {
    const limit = view.rateLimit
    if (active !== this || limit?.kind !== 'hourly' || !usage) return
    const spend = (budget: TokenBudget | undefined, tokens: unknown) =>
      budget && typeof tokens === 'number' && tokens > 0
        ? {
            max: budget.max,
            used: budget.used + tokens,
            remaining: Math.max(0, budget.remaining - tokens),
          }
        : budget
    const tokens = usage as Record<string, unknown>
    publish({
      rateLimit: {
        ...limit,
        inputTokens: spend(limit.inputTokens, tokens.prompt_tokens),
        outputTokens: spend(limit.outputTokens, tokens.completion_tokens),
      },
    })
  }

  async refresh({ credentials = false }: { credentials?: boolean } = {}) {
    // A refusal reaches the view as the quota it reports, and the requests
    // that need chat access.
    if (credentials)
      await this.client.renewCredential(this.lifetime.signal).catch((cause) => {
        this.lifetime.signal.throwIfAborted()
        logError('Failed to renew chat access', cause, {
          component: 'HarnessAPI',
          action: 'refresh',
        })
      })
    const session = await this.post<Session>(
      ROUTES.session,
      {},
      {
        keyless: true,
      },
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
      if (version === this.profileVersion) this.showProfile(saved)
    }
    localStorage.setItem(USER_PREFS_LOCAL_PROFILE_UPGRADED, 'true')
  }
  async refreshProfile({ background = false }: { background?: boolean } = {}) {
    const version = ++this.profileVersion
    if (!this.cloud) {
      this.profileSource = 'local'
      const profile = loadLocalProfile()
      this.showProfile(profile, {
        keyReady: !this.userId,
        keyLocked: false,
        profileReady: true,
        error: undefined,
      })
      await this.upgradeLocalProfile(profile, version).catch(reportHarnessError)
      return
    }
    if (!background) publish({ keyLocked: false, error: undefined })
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
        this.showProfile(profile, {
          keyReady: true,
          keyLocked: false,
          profileReady: true,
          error: undefined,
        })
        writeCloudProfileCache(this.userId, profile)
      }
    } catch (cause) {
      this.lifetime.signal.throwIfAborted()
      if (version !== this.profileVersion) return
      if (background) throw cause
      this.showProfile(this.keptProfile(), {
        keyReady: false,
        keyLocked:
          cause instanceof HarnessError &&
          (cause.code === ERROR_CODES.keyRequired ||
            cause.code === ERROR_CODES.keyMismatch),
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
    if (!this.cloud) {
      localStorage.removeItem(USER_PREFS_PENDING_PROFILE_MERGE)
      clearCloudProfileCache(this.userId)
    }
    this.invalidateKey()
    return this.refreshProfile()
  }
  // A change shows at once. Once saved the view shows the profile the
  // harness stored under any later changes still being saved; a refused
  // change is taken back.
  updateProfile(
    change: Profile | ((current: Profile) => Profile),
  ): Promise<Profile> {
    const cloud = this.cloud
    const signal = this.signal({ keyless: !cloud })
    const shown = typeof change === 'function' ? change(view.profile) : change
    if (!signal.aborted) {
      if (!this.unsavedProfile.length) this.storedProfile = view.profile
      this.unsavedProfile.push(shown)
      this.showProfile(this.storedProfile)
    }
    const settle = () => {
      this.unsavedProfile = this.unsavedProfile.filter(
        (unsaved) => unsaved !== shown,
      )
    }
    const update = this.profileWrites
      .catch(() => {})
      .then(async () => {
        signal.throwIfAborted()
        const version = ++this.profileVersion
        const patch =
          typeof change === 'function' ? change(this.storedProfile) : change
        const profile = cloud
          ? await this.post<Profile>(
              ROUTES.profileUpdate,
              { patch },
              { signal },
            )
          : saveLocalProfile(patch)
        signal.throwIfAborted()
        settle()
        // A profile read since this change began answers for it later.
        this.showProfile(
          version === this.profileVersion
            ? profile
            : { ...this.storedProfile, ...patch },
        )
        if (cloud) writeCloudProfileCache(this.userId, this.storedProfile)
        return profile
      })
      .catch((cause) => {
        settle()
        if (!this.lifetime.signal.aborted) this.showProfile(this.storedProfile)
        throw cause
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
  publish({ cloud: api.cloud, profile: api.keptProfile() })
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
      action: ERROR_ACTIONS.retry,
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
