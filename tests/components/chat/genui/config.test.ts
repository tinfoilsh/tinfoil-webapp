/**
 * These tests exercise the runtime config setter/getter and the widget
 * filtering predicate directly, without importing `./registry.ts`. The
 * registry transitively pulls in `zod-to-json-schema`, which vitest's
 * resolver can't see (the package is vendored inside the `openai` SDK).
 * The webapp build resolves it correctly via Next.js; this is a test
 * infrastructure limitation that pre-dates these changes.
 */
import { getGenUIConfig, setGenUIConfig } from '@/components/chat/genui/config'
import { resolveEnabledWidgets } from '@/components/chat/genui/enabled-widgets'
import { buildGenUIToolSchemas } from '@/components/chat/genui/registry'
import { buildGenUIPromptHint } from '@/components/chat/genui/system-prompt'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  setGenUIConfig(null)
})

function expectEnabledWidgets(names: string[]) {
  expect(resolveEnabledWidgets().map((widget) => widget.name)).toEqual(names)
  expect(buildGenUIToolSchemas().map((tool) => tool.function.name)).toEqual(
    names,
  )
  const hint = buildGenUIPromptHint()
  if (names.length === 0) {
    expect(hint).toBeNull()
  } else {
    expect(
      hint
        ?.split('\n')
        .slice(1)
        .map((line) => line.split(':')[0]),
    ).toEqual(names.map((name) => `- ${name}`))
  }
}

describe('GenUI runtime config', () => {
  it('returns null until a config is set', async () => {
    vi.resetModules()
    const freshConfig = await import('@/components/chat/genui/config')
    expect(freshConfig.getGenUIConfig()).toBeNull()
  })

  it('stores and returns the provided config', () => {
    setGenUIConfig({ header: 'h', enabledWidgets: ['render_stat_cards'] })
    expect(getGenUIConfig()).toEqual({
      header: 'h',
      enabledWidgets: ['render_stat_cards'],
    })
  })

  it('clears the config when set to null', () => {
    setGenUIConfig({ header: 'h', enabledWidgets: [] })
    setGenUIConfig(null)
    expect(getGenUIConfig()).toBeNull()
  })
})

describe('widget allowlist filter', () => {
  it('exposes no widgets when no config is set', () => {
    expectEnabledWidgets([])
  })

  it('restricts widgets to the controlplane allowlist', () => {
    setGenUIConfig({
      header: 'h',
      enabledWidgets: ['render_stat_cards', 'render_timeline'],
    })
    expectEnabledWidgets(['render_stat_cards', 'render_timeline'])
  })

  it('ignores widget names the webapp does not register', () => {
    setGenUIConfig({
      header: 'h',
      enabledWidgets: ['render_stat_cards', 'render_future_widget'],
    })
    expectEnabledWidgets(['render_stat_cards'])
  })

  it('returns nothing with an empty allowlist', () => {
    setGenUIConfig({ header: 'h', enabledWidgets: ['render_stat_cards'] })
    expectEnabledWidgets(['render_stat_cards'])
    setGenUIConfig({ header: 'h', enabledWidgets: [] })
    expectEnabledWidgets([])
  })
})
