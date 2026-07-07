import { setGenUIConfig } from '@/components/chat/genui/config'
import { API_BASE_URL, IS_DEV } from '@/config'
import { DEV_SIMULATOR_MODEL } from '@/utils/dev-simulator'
import { logError } from '@/utils/error-handling'

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
  {
    modelName: 'kimi-k2-6',
    image: 'moonshot.png',
    name: 'Kimi K2.6',
    nameShort: 'Kimi K2.6',
    description: 'Moonshot Kimi K2.6',
    type: 'chat',
    chat: true,
    multimodal: true,
  },
  {
    modelName: 'gpt-oss-120b',
    image: 'openai.png',
    name: 'GPT-OSS 120B',
    nameShort: 'GPT-OSS',
    description: 'OpenAI GPT-OSS 120B',
    type: 'chat',
    chat: true,
  },
]

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
}

export type AutoTier = 'smart' | 'fast'

// Base model type with all possible properties
export type BaseModel = {
  modelName: string
  image: string
  name: string
  nameShort: string
  description: string
  details?: string
  parameters?: string
  contextWindow?: string
  recommendedUse?: string
  supportedLanguages?: string
  type: 'chat' | 'code' | 'embedding' | 'audio' | 'tts' | 'document' | 'title'
  chat?: boolean
  paid?: boolean
  multimodal?: boolean
  toolCalling?: boolean
  /** Open set of model tags, including Auto routing tiers ("smart", "fast"). */
  attributes?: string[]
  /** True for the synthetic Auto picker entries; never a real backend model. */
  isAuto?: boolean
  /** Routing tier an Auto entry resolves; only set when isAuto is true. */
  tier?: AutoTier
  reasoningConfig?: ReasoningConfig
  endpoint?: string
  /** Extra fields merged into the chat completion request body */
  requestParams?: Record<string, unknown>
}

/** Selectable picker ids for the two Auto routing options. */
export const AUTO_SMART_ID = 'auto-smart'
export const AUTO_FAST_ID = 'auto-fast'

/**
 * Wire value placed in the request `model` field when an Auto option is
 * selected. The router treats this as a sentinel and reads the candidate list
 * from the `auto_model_options` body blob.
 */
export const AUTO_REQUEST_MODEL = 'auto'

/** Router-only body field carrying the ordered Auto candidate list. */
export const AUTO_MODEL_OPTIONS_FIELD = 'auto_model_options'

const isAutoId = (modelName: string): boolean =>
  modelName === AUTO_SMART_ID || modelName === AUTO_FAST_ID

const isChatModel = (m: BaseModel): boolean =>
  (m.type === 'chat' || m.type === 'code') && m.chat === true

/** Real chat models belonging to the given Auto tier, in priority order. */
const tierModels = (models: BaseModel[], tier: AutoTier): BaseModel[] =>
  models.filter(
    (m) =>
      isChatModel(m) &&
      Array.isArray(m.attributes) &&
      m.attributes.includes(tier),
  )

/**
 * Builds the synthetic Auto picker entries, one per tier that has at least one
 * member. These are display-only and are never sent to a backend; selection is
 * resolved to a concrete model list via resolveModelSelection.
 */
export const getAutoModels = (models: BaseModel[]): BaseModel[] => {
  const entries: BaseModel[] = []
  const add = (tier: AutoTier, modelName: string, name: string): void => {
    const members = tierModels(models, tier)
    if (members.length === 0) return
    entries.push({
      modelName,
      image: '',
      name,
      nameShort: name,
      description:
        tier === 'smart'
          ? 'Automatically routes to the best available high-capability model'
          : 'Automatically routes to the best available fast model',
      type: 'chat',
      chat: true,
      isAuto: true,
      tier,
      multimodal: members.some((m) => m.multimodal === true),
    })
  }
  add('smart', AUTO_SMART_ID, 'Auto · Smart')
  add('fast', AUTO_FAST_ID, 'Auto · Fast')
  return entries
}

/**
 * Default picker selection: Auto · Fast when its tier has members, otherwise
 * the first available model (e.g. local dev where models carry no tier
 * attributes). Empty string when no models have loaded yet.
 */
export const getDefaultModelId = (models: BaseModel[]): string => {
  if (tierModels(models, 'fast').length > 0) return AUTO_FAST_ID
  return models[0]?.modelName ?? ''
}

export const isModelNameAvailable = (
  modelName: string,
  models: BaseModel[],
): boolean => {
  if (isAutoId(modelName)) {
    const tier: AutoTier = modelName === AUTO_SMART_ID ? 'smart' : 'fast'
    return tierModels(models, tier).length > 0
  }
  return models.some((m) => m.modelName === modelName)
}

/**
 * Resolves a selected picker id to a concrete model for display: the matching
 * Auto entry when an Auto id is selected, otherwise the real model.
 */
export const findSelectableModel = (
  modelName: string,
  models: BaseModel[],
): BaseModel | undefined => {
  if (isAutoId(modelName)) {
    return getAutoModels(models).find((m) => m.modelName === modelName)
  }
  return models.find((m) => m.modelName === modelName)
}

export type ResolvedModelSelection = {
  /** Representative model used to build the request body and the UI. */
  model: BaseModel | undefined
  /**
   * Ordered Auto candidates (only set when an Auto option is selected). The
   * first entry is the representative model.
   */
  autoCandidates?: BaseModel[]
}

/**
 * Resolves the selected picker id (real model or Auto sentinel) into the model
 * used to build the request plus, for Auto, the ordered candidate list. For
 * Auto each preferred capability (multimodal / tool calling) narrows the tier
 * pool only when at least one member satisfies it, so a satisfied preference is
 * never silently dropped. When no tier member supports a preference at all the
 * incapable models are kept, which keeps the request routable (degraded)
 * rather than mis-routing past a capable candidate.
 */
export const resolveModelSelection = (
  selectedModel: string,
  models: BaseModel[],
  opts?: { preferMultimodal?: boolean; preferToolCalling?: boolean },
): ResolvedModelSelection => {
  if (!isAutoId(selectedModel)) {
    return { model: models.find((m) => m.modelName === selectedModel) }
  }

  const tier: AutoTier = selectedModel === AUTO_SMART_ID ? 'smart' : 'fast'
  let candidates = tierModels(models, tier)

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

// Fetch models from the API
export const getAIModels = async (): Promise<BaseModel[]> => {
  const isLocalDev = isLocalDevelopment()

  // In dev mode on localhost, return hardcoded models instead of fetching
  if (IS_DEV && isLocalDev) {
    return [...DEV_MODELS, DEV_SIMULATOR_MODEL]
  }

  try {
    const response = await fetch(`${API_BASE_URL}/api/config/models`)

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

    return models
  } catch (error) {
    logError('Failed to fetch AI models', error, {
      component: 'getAIModels',
    })
    return []
  }
}

// Fetch system prompt and rules from the API
export const getSystemPromptAndRules = async (): Promise<{
  systemPrompt: string
  rules: string
}> => {
  try {
    const url = `${API_BASE_URL}/api/config/system-prompt`
    const response = await fetch(url)

    if (!response.ok) {
      throw new Error(`Failed to fetch system prompt: ${response.status}`)
    }

    const data = await response.json()
    applyGenUIConfigFromResponse(data?.genUI)
    return {
      systemPrompt: data.systemPrompt,
      rules: data.rules,
    }
  } catch (error) {
    logError('Failed to fetch system prompt', error, {
      component: 'getSystemPromptAndRules',
    })
    setGenUIConfig(null)
    // Return a basic fallback
    return {
      systemPrompt: 'You are an intelligent and helpful assistant named Tin.',
      rules: '',
    }
  }
}

/**
 * Validates the optional `genUI` block from the system-prompt response and
 * pushes it into the runtime config used by the GenUI prompt and tool
 * builders. Malformed or missing payloads clear the runtime config so the
 * bundled defaults take over, rather than leaving stale config from an
 * earlier successful fetch active.
 */
export function applyGenUIConfigFromResponse(raw: unknown): void {
  if (!raw || typeof raw !== 'object') {
    setGenUIConfig(null)
    return
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.header !== 'string' || !Array.isArray(obj.enabledWidgets)) {
    setGenUIConfig(null)
    return
  }
  const enabledWidgets = obj.enabledWidgets.filter(
    (w): w is string => typeof w === 'string',
  )
  setGenUIConfig({ header: obj.header, enabledWidgets })
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
