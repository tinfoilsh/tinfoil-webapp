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
  reasoningConfig?: ReasoningConfig
  endpoint?: string
  /** Extra fields merged into the chat completion request body */
  requestParams?: Record<string, unknown>
}

export const isModelNameAvailable = (
  modelName: string,
  models: BaseModel[],
): boolean => {
  return models.some((m) => m.modelName === modelName)
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
