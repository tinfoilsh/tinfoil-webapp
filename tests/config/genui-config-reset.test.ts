import { getGenUIConfig, setGenUIConfig } from '@/components/chat/genui/config'
import {
  getAIModels,
  getCachedAIModels,
  getCachedSystemPromptAndRules,
  getSystemPromptAndRules,
} from '@/config/models'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  setGenUIConfig(null)
  localStorage.clear()
  vi.unstubAllGlobals()
})

const validResponse = {
  systemPrompt: 'Server prompt',
  rules: 'Server rules',
  genUI: { header: 'use widgets sparingly', enabledWidgets: ['render_chart'] },
}

function okResponse(body: unknown) {
  return { ok: true, json: vi.fn().mockResolvedValue(body) }
}

describe('getSystemPromptAndRules', () => {
  it('applies the genUI block from a valid response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(validResponse)))

    await expect(getSystemPromptAndRules()).resolves.toEqual({
      systemPrompt: 'Server prompt',
      rules: 'Server rules',
    })
    expect(getGenUIConfig()).toEqual(validResponse.genUI)
  })

  it('rejects a response without a genUI block', async () => {
    setGenUIConfig({ header: 'stale', enabledWidgets: ['render_chart'] })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          okResponse({ systemPrompt: 'p', rules: 'r', genUI: undefined }),
        ),
    )

    await expect(getSystemPromptAndRules()).resolves.toBeNull()
    expect(getGenUIConfig()).toEqual({
      header: 'stale',
      enabledWidgets: ['render_chart'],
    })
  })

  it.each([
    { header: 42, enabledWidgets: ['render_chart'] },
    { header: 'h', enabledWidgets: 'oops' },
  ])('rejects a response with a malformed genUI block: %j', async (genUI) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(validResponse)))
    await getSystemPromptAndRules()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          systemPrompt: 'p',
          rules: 'r',
          genUI,
        }),
      ),
    )

    await expect(getSystemPromptAndRules()).resolves.toBeNull()
    expect(getGenUIConfig()).toEqual(validResponse.genUI)
    expect(getCachedSystemPromptAndRules()).toEqual({
      systemPrompt: 'Server prompt',
      rules: 'Server rules',
    })
  })

  it('rejects widget lists containing non-string entries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          systemPrompt: 'p',
          rules: 'r',
          genUI: { header: 'h', enabledWidgets: ['render_chart', 7, null] },
        }),
      ),
    )

    await expect(getSystemPromptAndRules()).resolves.toBeNull()
  })

  it('seeds the cache from a successful response without serving it as a fallback', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse(validResponse))
      .mockRejectedValueOnce(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)

    await getSystemPromptAndRules()
    setGenUIConfig(null)

    expect(getCachedSystemPromptAndRules()).toEqual({
      systemPrompt: 'Server prompt',
      rules: 'Server rules',
    })
    expect(getGenUIConfig()).toEqual(validResponse.genUI)

    await expect(getSystemPromptAndRules()).resolves.toBeNull()
  })
})

describe('getAIModels', () => {
  it('returns null after a request failure even when cached', async () => {
    const model = {
      modelName: 'gpt-oss-120b',
      image: 'openai.png',
      name: 'GPT-OSS 120B',
      nameShort: 'GPT-OSS',
      description: 'Test model',
      type: 'chat',
      chat: true,
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse([model]))
      .mockRejectedValueOnce(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)

    const fetchedModels = await getAIModels()
    expect(fetchedModels).toContainEqual(model)
    expect(getCachedAIModels()).toEqual(fetchedModels)
    await expect(getAIModels()).resolves.toBeNull()
  })
})
