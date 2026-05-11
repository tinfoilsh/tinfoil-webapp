import { getGenUIConfig, setGenUIConfig } from '@/components/chat/genui/config'
import {
  applyGenUIConfigFromResponse,
  getSystemPromptAndRules,
} from '@/config/models'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  setGenUIConfig(null)
  vi.unstubAllGlobals()
})

describe('applyGenUIConfigFromResponse', () => {
  it('applies a valid payload to the runtime config', () => {
    applyGenUIConfigFromResponse({
      header: 'use widgets sparingly',
      enabledWidgets: ['render_stat_cards', 'render_chart'],
    })
    expect(getGenUIConfig()).toEqual({
      header: 'use widgets sparingly',
      enabledWidgets: ['render_stat_cards', 'render_chart'],
    })
  })

  it('clears stale config when the payload is missing entirely', () => {
    setGenUIConfig({ header: 'stale', enabledWidgets: ['render_chart'] })
    applyGenUIConfigFromResponse(undefined)
    expect(getGenUIConfig()).toBeNull()
  })

  it('clears stale config when the payload is malformed', () => {
    setGenUIConfig({ header: 'stale', enabledWidgets: ['render_chart'] })
    applyGenUIConfigFromResponse({ header: 42, enabledWidgets: 'oops' })
    expect(getGenUIConfig()).toBeNull()
  })

  it('drops non-string widget names while keeping valid ones', () => {
    applyGenUIConfigFromResponse({
      header: 'h',
      enabledWidgets: ['render_stat_cards', 7, null, 'render_chart'],
    })
    expect(getGenUIConfig()).toEqual({
      header: 'h',
      enabledWidgets: ['render_stat_cards', 'render_chart'],
    })
  })

  it('clears stale config when the system prompt request falls back', async () => {
    setGenUIConfig({ header: 'stale', enabledWidgets: ['render_chart'] })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    const result = await getSystemPromptAndRules()

    expect(result).toEqual({
      systemPrompt: 'You are an intelligent and helpful assistant named Tin.',
      rules: '',
    })
    expect(getGenUIConfig()).toBeNull()
  })
})
