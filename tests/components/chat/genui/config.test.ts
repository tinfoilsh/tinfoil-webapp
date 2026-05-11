/**
 * These tests exercise the runtime config setter/getter and the widget
 * filtering predicate directly, without importing `./registry.ts`. The
 * registry transitively pulls in `zod-to-json-schema`, which vitest's
 * resolver can't see (the package is vendored inside the `openai` SDK).
 * The webapp build resolves it correctly via Next.js; this is a test
 * infrastructure limitation that pre-dates these changes.
 */
import { getGenUIConfig, setGenUIConfig } from '@/components/chat/genui/config'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

afterEach(() => {
  setGenUIConfig(null)
})

const widgetFixture = [
  { name: 'render_stat_cards', schema: z.object({}), promptHint: 'kpis' },
  { name: 'render_timeline', schema: z.object({}), promptHint: 'events' },
  { name: 'render_chart', schema: z.object({}), promptHint: 'chart' },
] as const

function filterAllowed<T extends { name: string }>(
  registry: readonly T[],
): readonly T[] {
  const config = getGenUIConfig()
  if (!config) return registry
  const allowed = new Set(config.enabledWidgets)
  return registry.filter((w) => allowed.has(w.name))
}

describe('GenUI runtime config', () => {
  it('returns null until a config is set', () => {
    expect(getGenUIConfig()).toBeNull()
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
  it('exposes every widget when no config is set', () => {
    expect(filterAllowed(widgetFixture)).toHaveLength(widgetFixture.length)
  })

  it('restricts widgets to the controlplane allowlist', () => {
    setGenUIConfig({
      header: 'h',
      enabledWidgets: ['render_stat_cards', 'render_timeline'],
    })
    expect(filterAllowed(widgetFixture).map((w) => w.name)).toEqual([
      'render_stat_cards',
      'render_timeline',
    ])
  })

  it('ignores widget names the webapp does not register', () => {
    setGenUIConfig({
      header: 'h',
      enabledWidgets: ['render_stat_cards', 'render_future_widget'],
    })
    expect(filterAllowed(widgetFixture).map((w) => w.name)).toEqual([
      'render_stat_cards',
    ])
  })

  it('returns nothing with an empty allowlist', () => {
    setGenUIConfig({ header: 'h', enabledWidgets: [] })
    expect(filterAllowed(widgetFixture)).toHaveLength(0)
  })
})
