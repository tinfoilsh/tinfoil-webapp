import {
  setGenUIConfig,
  type GenUIConfig,
} from '@/components/chat/genui/config'
import { API_BASE_URL, IS_DEV } from '@/config'
import {
  CONFIG_CACHED_MODELS,
  CONFIG_CACHED_SYSTEM_PROMPT,
} from '@/constants/storage-keys'
import { DEV_SIMULATOR_MODEL } from '@/utils/dev-simulator'
import { logError } from '@/utils/error-handling'
import {
  getStrongerReasoningHistoryPolicy,
  normalizeReasoningHistoryPolicy,
  REASONING_HISTORY_POLICIES,
  type ReasoningHistoryPolicy,
} from '@/utils/reasoning-history'
import {
  getSmallestContextWindowTokens,
  resolveContextWindowTokens,
} from '@/utils/token-estimation'

const DEV_MODELS: BaseModel[] = [
  {
    modelName: 'gemma4-31b',
    image: 'google.webp',
    name: 'Gemma 4 31B',
    nameShort: 'Gemma 4',
    description: 'Google Gemma 4 31B',
    type: 'chat',
    chat: true,
    multimodal: true,
    chatConfig: {
      descriptionShort: 'Best for everyday tasks with images',
      reasoningConfig: {
        supportsToggle: true,
        defaultEnabled: true,
        params: {
          '/v1/chat/completions': {
            enable: { chat_template_kwargs: { enable_thinking: true } },
            disable: { chat_template_kwargs: { enable_thinking: false } },
          },
          '/v1/responses': {
            enable: { chat_template_kwargs: { enable_thinking: true } },
            disable: { chat_template_kwargs: { enable_thinking: false } },
          },
        },
      },
    },
  },
  {
    modelName: 'kimi-k2-6',
    image: 'moonshot.png',
    name: 'Kimi K2.6',
    nameShort: 'Kimi K2.6',
    description: 'Moonshot Kimi K2.6',
    type: 'chat',
    chat: true,
    multimodal: true,
    chatConfig: {
      descriptionShort: 'Best for coding and visual tasks',
    },
  },
  {
    modelName: 'gpt-oss-120b',
    image: 'openai.png',
    name: 'GPT-OSS 120B',
    nameShort: 'GPT-OSS',
    description: 'OpenAI GPT-OSS 120B',
    type: 'chat',
    chat: true,
    chatConfig: {
      descriptionShort: 'Best for quick reasoning tasks',
    },
  },
]

const modelDisplayNames = new Map<string, string>()

const rememberModelDisplayNames = (models: BaseModel[]): BaseModel[] => {
  for (const model of models) {
    modelDisplayNames.set(model.modelName, model.name)
  }
  // Synced chats may still carry a legacy Auto tier id; every Auto id shows
  // the same label.
  const autoModel = getAutoModel(models)
  if (autoModel) {
    for (const id of [AUTO_MODEL_ID, ...LEGACY_AUTO_MODEL_IDS]) {
      modelDisplayNames.set(id, autoModel.name)
    }
  }
  return models
}

export const getKnownModelDisplayName = (
  modelName: string,
): string | undefined => modelDisplayNames.get(modelName)

/**
 * Per-endpoint enable/disable parameter blocks for thinking mode.
 * Keyed by full endpoint path (e.g. "/v1/chat/completions", "/v1/responses").
 * Each block is shallow-merged into the request body when the toggle is in
 * the corresponding state.
 */
export type ReasoningEndpointParams = {
  enable?: Record<string, unknown>
  disable?: Record<string, unknown>
}

/**
 * Reasoning capability descriptor returned by the controlplane.
 *
 * - `supportsEffort: true` — model accepts a `reasoning_effort` (chat
 *   completions) or `reasoning.effort` (responses) parameter with low/medium/high.
 * - `supportsToggle: true` — thinking mode can be turned on or off per request
 *   via `params[endpoint].enable` / `params[endpoint].disable`.
 * - `defaultEnabled` — initial state of the toggle when `supportsToggle` is true.
 * - `reasoningHistoryPolicy` — controls whether prior assistant reasoning is
 *   returned for every assistant message, tool-call messages only, or never.
 *
 * The presence of a `reasoningConfig` object is itself the capability flag
 * — there is no separate boolean.
 */
export type ReasoningConfig = {
  supportsEffort?: boolean
  supportsToggle?: boolean
  defaultEnabled?: boolean
  /**
   * Optional translation table from the UI's effort vocabulary
   * (low | medium | high) to the model's actual accepted values. Used when
   * a model's chat template only accepts a non-standard set, e.g. DeepSeek V4
   * which accepts only "high" and "max". When unset, the UI value is
   * substituted verbatim (correct for OpenAI-style models like GPT-OSS).
   */
  effortMap?: Record<string, string>
  params?: Record<string, ReasoningEndpointParams>
  reasoningHistoryPolicy?: ReasoningHistoryPolicy
}

/**
 * Settings the chat clients read for a model. Present only on chat models; the
 * controlplane keeps everything a chat client needs under this block.
 */
export type ChatConfig = {
  /**
   * Token budget the chat archives history against. May be lower than the
   * model's raw capability advertised to API consumers.
   */
  contextWindowTokens?: number
  /** Open set of model tags (e.g. "smart", "fast") shown as picker hints. */
  attributes?: string[]
  /** Short "Best for x" blurb shown under the name in the model picker. */
  descriptionShort?: string
  reasoningConfig?: ReasoningConfig
}

// Base model type with all possible properties
export type BaseModel = {
  modelName: string
  image: string
  name: string
  nameShort: string
  description: string
  details?: string
  parameters?: string
  recommendedUse?: string
  supportedLanguages?: string
  type: 'chat' | 'code' | 'embedding' | 'audio' | 'tts' | 'document' | 'title'
  chat?: boolean
  paid?: boolean
  multimodal?: boolean
  toolCalling?: boolean
  experimental?: boolean
  deprecated?: boolean
  deprecationDate?: string
  chatConfig?: ChatConfig
  /** True for the synthetic Auto picker entry; never a real backend model. */
  isAuto?: boolean
  endpoint?: string
  /** Extra fields merged into the chat completion request body */
  requestParams?: Record<string, unknown>
}

/**
 * Picker id and wire value for Auto. The router treats `model: "auto"` as a
 * sentinel and picks a concrete model and reasoning effort from the requested
 * intelligence level.
 */
export const AUTO_MODEL_ID = 'auto'

/**
 * Router-only body field. Carries `{ intelligence: <0-100> }` so the router
 * knows how capable a model the user asked for.
 */
export const AUTO_MODEL_OPTIONS_FIELD = 'auto_model_options'

/**
 * Picker ids from the previous two-tier Auto design. Still present in saved
 * settings and synced chats; both map onto the single Auto entry.
 */
const LEGACY_AUTO_MODEL_IDS = ['auto-smart', 'auto-fast'] as const

/**
 * The positions of the Auto intelligence slider. Each maps to a level on the
 * router's normalized 0-100 scale, where 100 is the most capable model and
 * effort currently in the catalog.
 */
export const AUTO_INTELLIGENCE_LEVELS = [
  { id: 'instant', label: 'Instant', value: 0 },
  { id: 'low', label: 'Low', value: 20 },
  { id: 'medium', label: 'Med', value: 40 },
  { id: 'high', label: 'High', value: 60 },
  { id: 'extra', label: 'Extra', value: 80 },
  { id: 'max', label: 'Max', value: 100 },
] as const

export type AutoIntelligenceLevel = (typeof AUTO_INTELLIGENCE_LEVELS)[number]
export type AutoIntelligenceLevelId = AutoIntelligenceLevel['id']

export const DEFAULT_AUTO_INTELLIGENCE_LEVEL: AutoIntelligenceLevelId = 'high'

export const isAutoIntelligenceLevelId = (
  value: unknown,
): value is AutoIntelligenceLevelId =>
  AUTO_INTELLIGENCE_LEVELS.some((level) => level.id === value)

export const getAutoIntelligenceLevel = (
  id: AutoIntelligenceLevelId,
): AutoIntelligenceLevel =>
  AUTO_INTELLIGENCE_LEVELS.find((level) => level.id === id) ??
  AUTO_INTELLIGENCE_LEVELS[0]

/** Collapsed picker label for Auto at the given level, e.g. "Auto · High". */
export const getAutoDisplayName = (level: AutoIntelligenceLevelId): string =>
  `Auto · ${getAutoIntelligenceLevel(level).label}`

/**
 * Label for the collapsed model picker trigger: "Auto · <level>" when Auto is
 * selected, otherwise the model's name.
 */
export const getSelectedModelLabel = (
  selectedModel: string,
  models: BaseModel[],
  autoIntelligence: AutoIntelligenceLevelId,
): string | undefined => {
  const model = findSelectableModel(selectedModel, models)
  if (!model) return undefined
  return model.isAuto ? getAutoDisplayName(autoIntelligence) : model.name
}

export const isAutoModelId = (modelName: string): boolean =>
  modelName === AUTO_MODEL_ID ||
  (LEGACY_AUTO_MODEL_IDS as readonly string[]).includes(modelName)

const isChatModel = (m: BaseModel): boolean =>
  (m.type === 'chat' || m.type === 'code') && m.chat === true

/**
 * Real chat models the router may pick for Auto. The router only routes
 * across models with published intelligence scores, which today are the chat
 * models; the picker mirrors that so its Auto entry is offered exactly when
 * the router can serve it.
 */
const autoCandidateModels = (models: BaseModel[]): BaseModel[] =>
  models.filter(isChatModel)

/**
 * Builds the synthetic Auto picker entry when at least one chat model exists.
 * Display-only and never sent to a backend; the request path resolves it via
 * resolveModelSelection.
 */
export const getAutoModel = (models: BaseModel[]): BaseModel | undefined => {
  const members = autoCandidateModels(models)
  if (members.length === 0) return undefined
  const smallestMember = members.reduce((smallest, member) =>
    resolveContextWindowTokens(member) < resolveContextWindowTokens(smallest)
      ? member
      : smallest,
  )
  return {
    modelName: AUTO_MODEL_ID,
    image: '',
    name: 'Auto',
    nameShort: 'Auto',
    description:
      'Automatically routes to the best model for the chosen intelligence level',
    type: 'chat',
    chat: true,
    isAuto: true,
    multimodal: members.some((m) => m.multimodal === true),
    chatConfig: {
      contextWindowTokens: resolveContextWindowTokens(smallestMember),
    },
  }
}

/**
 * Default picker selection: Auto when any chat model exists, otherwise empty.
 * The model list also contains non-chat types (embedding, audio, title, ...)
 * which must never become the chat default.
 */
export const getDefaultModelId = (models: BaseModel[]): string =>
  getAutoModel(models) ? AUTO_MODEL_ID : ''

export const isModelNameAvailable = (
  modelName: string,
  models: BaseModel[],
): boolean => {
  if (isAutoModelId(modelName)) return getAutoModel(models) !== undefined
  return models.some((m) => m.modelName === modelName)
}

/**
 * Resolves a selected picker id to a concrete model for display: the Auto
 * entry for Auto (including legacy tier ids), otherwise the real model.
 */
export const findSelectableModel = (
  modelName: string,
  models: BaseModel[],
): BaseModel | undefined => {
  if (isAutoModelId(modelName)) return getAutoModel(models)
  return models.find((m) => m.modelName === modelName)
}

export type ResolvedModelSelection = {
  /** Representative model used to build the request body and the UI. */
  model: BaseModel | undefined
  /**
   * Every model the router may pick when Auto is selected (unset for a real
   * model). The router makes the actual choice; the client uses this pool only
   * for worst-case budgeting (smallest context window, strongest reasoning
   * history policy). The first entry is the representative model.
   */
  autoCandidates?: BaseModel[]
}

const getResolvedCandidates = (
  selection: ResolvedModelSelection,
): BaseModel[] =>
  selection.autoCandidates ?? (selection.model ? [selection.model] : [])

export const getReasoningHistoryPolicy = (
  selection: ResolvedModelSelection,
): ReasoningHistoryPolicy => {
  return getResolvedCandidates(selection).reduce<ReasoningHistoryPolicy>(
    (strongest, candidate) =>
      getStrongerReasoningHistoryPolicy(
        strongest,
        normalizeReasoningHistoryPolicy(
          candidate.chatConfig?.reasoningConfig?.reasoningHistoryPolicy,
        ),
      ),
    REASONING_HISTORY_POLICIES.none,
  )
}

export const getResolvedModelContextWindowTokens = (
  selection: ResolvedModelSelection,
): number | undefined => {
  return getSmallestContextWindowTokens(getResolvedCandidates(selection))
}

/**
 * Resolves the selected picker id (real model or Auto) into the model used to
 * build the request plus, for Auto, the pool of models the router may choose
 * from. Each preferred capability (multimodal / tool calling) narrows the pool
 * only when at least one member satisfies it, so the client's budgeting
 * reflects the models the router will realistically land on.
 */
export const resolveModelSelection = (
  selectedModel: string,
  models: BaseModel[],
  opts?: { preferMultimodal?: boolean; preferToolCalling?: boolean },
): ResolvedModelSelection => {
  if (!isAutoModelId(selectedModel)) {
    return { model: models.find((m) => m.modelName === selectedModel) }
  }

  let candidates = autoCandidateModels(models)

  if (opts?.preferMultimodal) {
    const capable = candidates.filter((m) => m.multimodal === true)
    if (capable.length > 0) candidates = capable
  }
  if (opts?.preferToolCalling) {
    const capable = candidates.filter((m) => m.toolCalling === true)
    if (capable.length > 0) candidates = capable
  }

  return { model: candidates[0], autoCandidates: candidates }
}

const isLocalDevelopment = (): boolean => {
  return (
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname.startsWith('192.168.') ||
      window.location.hostname.startsWith('10.'))
  )
}

// The cache only seeds the first render while the controlplane request is in
// flight. A successful response always overwrites it and a failed response
// blocks the app, so entries never serve as an offline fallback.
const CONFIG_CACHE_VERSION = 3
const CONFIG_REQUEST_TIMEOUT_MS = 10_000

type CachedConfig<T> = {
  version: number
  value: T
}

type SystemPromptAndRules = {
  systemPrompt: string
  rules: string
}

type SystemPromptResponse = SystemPromptAndRules & {
  genUI: GenUIConfig
}

function readCachedConfig<T>(
  key: string,
  validate: (value: unknown) => value is T,
): T | null {
  if (typeof window === 'undefined') return null
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '') as Partial<
      CachedConfig<unknown>
    >
    if (parsed.version !== CONFIG_CACHE_VERSION || !validate(parsed.value)) {
      return null
    }
    return parsed.value
  } catch {
    return null
  }
}

function writeCachedConfig<T>(key: string, value: T): void {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        version: CONFIG_CACHE_VERSION,
        value,
      } satisfies CachedConfig<T>),
    )
  } catch {
    // best-effort
  }
}

function isBaseModelArray(value: unknown): value is BaseModel[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (model) =>
        typeof model === 'object' &&
        model !== null &&
        typeof model.modelName === 'string' &&
        typeof model.name === 'string' &&
        typeof model.type === 'string',
    )
  )
}

function isGenUIConfig(value: unknown): value is GenUIConfig {
  const candidate = value as Record<string, unknown> | null
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.header === 'string' &&
    Array.isArray(candidate.enabledWidgets) &&
    candidate.enabledWidgets.every((w) => typeof w === 'string')
  )
}

function isSystemPromptResponse(value: unknown): value is SystemPromptResponse {
  const candidate = value as Record<string, unknown> | null
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.systemPrompt === 'string' &&
    typeof candidate.rules === 'string' &&
    isGenUIConfig(candidate.genUI)
  )
}

async function fetchConfig(url: string): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    CONFIG_REQUEST_TIMEOUT_MS,
  )
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

export function getCachedAIModels(): BaseModel[] | null {
  const models = readCachedConfig(CONFIG_CACHED_MODELS, isBaseModelArray)
  return models ? rememberModelDisplayNames(models) : null
}

export function getCachedSystemPromptAndRules(): SystemPromptAndRules | null {
  const cached = readCachedConfig(
    CONFIG_CACHED_SYSTEM_PROMPT,
    isSystemPromptResponse,
  )
  if (!cached) return null
  setGenUIConfig(cached.genUI)
  return {
    systemPrompt: cached.systemPrompt,
    rules: cached.rules,
  }
}

// Fetch models from the API. Returns null when the controlplane is
// unreachable so callers can block rather than proceed without config.
export const getAIModels = async (): Promise<BaseModel[] | null> => {
  const isLocalDev = isLocalDevelopment()

  // In dev mode on localhost, return hardcoded models instead of fetching
  if (IS_DEV && isLocalDev) {
    return rememberModelDisplayNames([...DEV_MODELS, DEV_SIMULATOR_MODEL])
  }

  try {
    const response = await fetchConfig(`${API_BASE_URL}/api/config/models`)

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`)
    }

    const allModels: BaseModel[] = await response.json()

    // Remove free chat models — they are handled server-side via
    // free-tier API keys and should never appear in the UI.
    const models = allModels.filter(
      (m) => !(m.paid === false && m.chat === true),
    )

    // Add Dev Simulator model when running locally
    if (isLocalDev) {
      models.unshift(DEV_SIMULATOR_MODEL)
    }

    const rememberedModels = rememberModelDisplayNames(models)
    writeCachedConfig(CONFIG_CACHED_MODELS, rememberedModels)
    return rememberedModels
  } catch (error) {
    logError('Failed to fetch AI models', error, {
      component: 'getAIModels',
    })
    return null
  }
}

// Fetch system prompt and rules from the API. Returns null when the
// controlplane is unreachable so callers can block rather than proceed
// without config.
export const getSystemPromptAndRules =
  async (): Promise<SystemPromptAndRules | null> => {
    try {
      const url = `${API_BASE_URL}/api/config/system-prompt`
      const response = await fetchConfig(url)

      if (!response.ok) {
        throw new Error(`Failed to fetch system prompt: ${response.status}`)
      }

      const data: unknown = await response.json()
      if (!isSystemPromptResponse(data)) {
        throw new Error('System prompt response is malformed')
      }
      const result: SystemPromptResponse = {
        systemPrompt: data.systemPrompt,
        rules: data.rules,
        genUI: data.genUI,
      }
      setGenUIConfig(result.genUI)
      writeCachedConfig(CONFIG_CACHED_SYSTEM_PROMPT, result)
      return { systemPrompt: result.systemPrompt, rules: result.rules }
    } catch (error) {
      logError('Failed to fetch system prompt', error, {
        component: 'getSystemPromptAndRules',
      })
      return null
    }
  }

// Fetch memory prompt from the API
export const getMemoryPrompt = async (): Promise<string> => {
  try {
    const url = `${API_BASE_URL}/api/config/memory-prompt`
    const response = await fetch(url)

    if (!response.ok) {
      throw new Error(`Failed to fetch memory prompt: ${response.status}`)
    }

    const data = await response.json()
    return data.memoryPrompt
  } catch (error) {
    logError('Failed to fetch memory prompt', error, {
      component: 'getMemoryPrompt',
    })
    return ''
  }
}
