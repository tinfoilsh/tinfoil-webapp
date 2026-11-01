import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import { encryptionService } from '@/services/encryption/encryption-service'
import { isCloudSyncEnabled } from '@/utils/cloud-sync-settings'
import { HarnessClient } from './client'
import { loadLocalProfile, saveLocalProfile } from './local-profile'
import { HarnessError } from './sse'
import type { RateLimit, Session, TokenBudget } from './types'

export type Profile = Record<string, any>
type View = {
  session?: Session
  profile: Profile
  error?: string
  // The content key is unlocked for the harness's stored chats. A signed-out
  // visitor needs no key.
  keyReady: boolean
  // The settings of the current storage mode have loaded.
  profileReady: boolean
  // The account's quota as the session and its runs last reported it.
  rateLimit?: RateLimit
}
const empty: View = { profile: {}, keyReady: false, profileReady: false }
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

// Tokens a run spent, as its final event reports them.
export interface RunSpend {
  prompt: number
  completion: number
}

function spentBudget(
  previous: TokenBudget | undefined,
  reported: TokenBudget | undefined,
  spent: number,
): TokenBudget | undefined {
  const base = reported ?? previous
  if (!base) return undefined
  const used = Math.max(base.used, previous?.used ?? 0) + spent
  const remaining = Math.min(base.remaining, previous?.remaining ?? Infinity)
  return {
    max: base.max,
    used,
    remaining: Math.max(0, remaining - spent),
  }
}

// The harness reports the budgets its last credential exchange saw, which
// lag the tokens spent since, so within one quota window a report never
// moves usage back, and a run's spend counts until a later exchange does.
// A new window (another kind or reset time) starts from its report.
function mergeRateLimit(
  current: RateLimit | undefined,
  next: RateLimit | undefined,
  spend?: RunSpend,
): RateLimit | undefined {
  const reported = next?.kind ? next : undefined
  const sameWindow =
    !!current &&
    (!reported ||
      (current.kind === reported.kind &&
        current.resetsAt === reported.resetsAt))
  const base = reported ?? current
  if (!base) return undefined
  const previous = sameWindow ? current : undefined
  const remaining =
    typeof base.remaining === 'number'
      ? Math.min(base.remaining, previous?.remaining ?? Infinity)
      : undefined
  const inputTokens = spentBudget(
    previous?.inputTokens,
    reported?.inputTokens ?? (reported ? undefined : current?.inputTokens),
    spend?.prompt ?? 0,
  )
  const outputTokens = spentBudget(
    previous?.outputTokens,
    reported?.outputTokens ?? (reported ? undefined : current?.outputTokens),
    spend?.completion ?? 0,
  )
  return {
    kind: base.kind,
    ...(typeof base.maxRequests === 'number'
      ? { maxRequests: base.maxRequests }
      : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(base.resetsAt ? { resetsAt: base.resetsAt } : {}),
    ...(inputTokens ? { inputTokens } : {}),
    ...(outputTokens ? { outputTokens } : {}),
  }
}

// Main moved the custom default prompt into the prompt library: an enabled
// one becomes a saved prompt, under the id the iOS app also uses, that new
// chats start with unless another default was chosen. The old setting is
// turned off either way.
export const MIGRATED_CUSTOM_PROMPT_PRESET_ID = 'user:migrated-custom-prompt'

function legacyCustomPromptPatch(
  profile: Profile,
  now = Date.now(),
): Profile | null {
  if (profile.isUsingCustomPrompt !== true) return null
  const prompt =
    typeof profile.customSystemPrompt === 'string'
      ? profile.customSystemPrompt
      : ''
  const patch: Profile = { isUsingCustomPrompt: false, customSystemPrompt: '' }
  const hasContent =
    prompt
      .replace(/^<system>\s*\n?/, '')
      .replace(/\n?<\/system>\s*$/, '')
      .trim().length > 0
  if (!hasContent || profile.defaultPromptPresetId) return patch
  const presets: Record<string, unknown>[] = Array.isArray(
    profile.customPromptPresets,
  )
    ? profile.customPromptPresets
    : []
  if (
    !presets.some((preset) => preset?.id === MIGRATED_CUSTOM_PROMPT_PRESET_ID)
  )
    patch.customPromptPresets = [
      ...presets,
      {
        id: MIGRATED_CUSTOM_PROMPT_PRESET_ID,
        name: 'My default prompt',
        description: 'Migrated from the custom default prompt setting',
        systemPrompt: prompt,
        createdAt: now,
        updatedAt: now,
      },
    ]
  patch.defaultPromptPresetId = MIGRATED_CUSTOM_PROMPT_PRESET_ID
  return patch
}

export class HarnessAPI {
  readonly lifetime = new AbortController()
  private contentLifetime = new AbortController()
  private profileVersion = 0
  private profileWrites: Promise<unknown> = Promise.resolve()
  private profileSource: 'cloud' | 'local' | null = null
  invalidateKey() {
    this.contentLifetime.abort()
    this.contentLifetime = new AbortController()
    this.profileVersion++
    publish({ profile: {}, keyReady: false, profileReady: false })
  }
  // The harness stores this account's chats and settings. Without cloud
  // sync, and for a signed-out visitor, both stay in the browser.
  get cloud() {
    return !!this.userId && isCloudSyncEnabled()
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
    withKey = true,
  ): Promise<T> {
    const key = withKey ? this.key() : undefined
    const requestSignal = this.signal(signal, withKey)
    const result = await this.client.upload<T>(
      path,
      file,
      { ...(key ? { key } : {}), ...fields },
      requestSignal,
    )
    requestSignal.throwIfAborted()
    return result
  }
  // A keyless request whose response body streams, such as speech.
  async stream(
    path: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const requestSignal = this.signal(signal, false)
    const response = await this.client.stream(path, input, requestSignal)
    requestSignal.throwIfAborted()
    return response
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

  // Records the quota a session or run reported, and a finished run's
  // spend, for this account only.
  reportRateLimit(limit: RateLimit | undefined, spend?: RunSpend) {
    if (active !== this || this.lifetime.signal.aborted) return
    const rateLimit = mergeRateLimit(view.rateLimit, limit, spend)
    if (
      rateLimit &&
      JSON.stringify(rateLimit) !== JSON.stringify(view.rateLimit)
    )
      publish({ rateLimit })
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
      !session.rateLimit?.kind &&
      this.client.anonymousRateLimit
    )
      session.rateLimit = this.client.anonymousRateLimit
    publish({ session, error: undefined })
    this.reportRateLimit(session.rateLimit)
    await this.refreshProfile()
    return session
  }
  // Moves a profile still using the custom default prompt to the prompt
  // library, where the harness keeps the default prompt.
  private adoptLegacyCustomPrompt(profile: Profile) {
    if (!legacyCustomPromptPatch(profile)) return
    void this.updateProfile(
      (current) => legacyCustomPromptPatch(current) ?? {},
    ).catch(reportHarnessError)
  }
  async refreshProfile() {
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
      this.adoptLegacyCustomPrompt(profile)
      return
    }
    try {
      const profile = await this.post<Profile>('/v1/profile/get')
      if (version === this.profileVersion) {
        this.profileSource = 'cloud'
        publish({
          profile,
          keyReady: true,
          profileReady: true,
          error: undefined,
        })
        this.adoptLegacyCustomPrompt(profile)
      }
    } catch (cause) {
      this.lifetime.signal.throwIfAborted()
      if (version !== this.profileVersion) return
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
  storageModeChanged() {
    if (!this.cloud && this.profileSource === 'cloud' && view.profileReady)
      saveLocalProfile(view.profile, true)
    this.invalidateKey()
    return this.refreshProfile()
  }
  updateProfile(
    change: Profile | ((current: Profile) => Profile),
  ): Promise<Profile> {
    const cloud = this.cloud
    const signal = this.signal(undefined, cloud)
    const update = this.profileWrites
      .catch(() => {})
      .then(async () => {
        signal.throwIfAborted()
        const version = ++this.profileVersion
        const patch =
          typeof change === 'function' ? change(view.profile) : change
        const profile = cloud
          ? await this.post<Profile>('/v1/profile/update', { patch }, signal)
          : saveLocalProfile(patch)
        signal.throwIfAborted()
        if (version === this.profileVersion) publish({ profile })
        return profile
      })
    this.profileWrites = update
    return update
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
