import { setGenUIConfig } from '@/components/chat/genui/config'
import {
  buildGenUIToolSchemas,
  GENUI_WIDGETS,
  GENUI_WIDGETS_BY_NAME,
} from '@/components/chat/genui/registry'
import { isValidElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const fixtures: Record<
  string,
  { valid: unknown; invalid: unknown; required: string[] }
> = {
  render_stat_cards: {
    valid: { stats: [{ label: 'Users', value: 10 }] },
    invalid: { stats: [] },
    required: ['stats'],
  },
  render_timeline: {
    valid: { events: [{ date: '2024', title: 'E' }] },
    invalid: { events: [] },
    required: ['events'],
  },
  render_chart: {
    valid: { type: 'bar', data: [{ label: 'A', value: 1 }] },
    invalid: { type: 'donut', data: [{ label: 'A', value: 1 }] },
    required: ['type', 'data'],
  },
  render_image: {
    valid: { images: [{ url: 'https://example.com/a.png' }] },
    invalid: { images: [] },
    required: ['images'],
  },
  render_link_preview: {
    valid: { url: 'https://example.com', title: 'Ex' },
    invalid: { url: 123, title: 'Ex' },
    required: ['url', 'title'],
  },
  render_artifact_preview: {
    valid: { source: { type: 'markdown', markdown: '# Hello' } },
    invalid: { source: { type: 'markdown', markdown: 123 } },
    required: ['source'],
  },
  render_clock: {
    valid: { mode: 'timer', durationSeconds: 300 },
    invalid: { mode: 'timer', durationSeconds: -1 },
    required: [],
  },
  render_recipe_card: {
    valid: { title: 'Pasta' },
    invalid: { title: '' },
    required: ['title'],
  },
  render_message_compose: {
    valid: { variants: [{ label: 'Formal', body: 'Hello.' }] },
    invalid: { variants: [] },
    required: ['variants'],
  },
  render_sports_data: {
    valid: { kind: 'fixture', home: { name: 'A' }, away: { name: 'B' } },
    invalid: { kind: 'unknown' },
    required: ['kind'],
  },
  render_map: {
    valid: {
      locations: [{ name: 'Apple Park', latitude: 37.33, longitude: -122.01 }],
    },
    invalid: { locations: [] },
    required: ['locations'],
  },
}
const expectedNames = Object.keys(fixtures).sort()

beforeEach(() => {
  expect(GENUI_WIDGETS.length).toBeGreaterThan(0)
  expect(GENUI_WIDGETS.map((widget) => widget.name).sort()).toEqual(
    expectedNames,
  )
  setGenUIConfig({
    header: 'h',
    enabledWidgets: expectedNames,
  })
})

afterEach(() => {
  setGenUIConfig(null)
})

describe('GenUI registry', () => {
  it('builds no tool schemas without controlplane config', () => {
    setGenUIConfig(null)
    expect(buildGenUIToolSchemas()).toHaveLength(0)
  })

  it('has unique render_* tool names', () => {
    const names = GENUI_WIDGETS.map((w) => w.name)
    expect(names).toEqual(Array.from(new Set(names)))
    for (const name of names) {
      expect(name).toMatch(/^render_[a-z_]+$/)
    }
  })

  it('GENUI_WIDGETS_BY_NAME covers every widget', () => {
    expect(Object.keys(GENUI_WIDGETS_BY_NAME).sort()).toEqual(expectedNames)
    for (const widget of GENUI_WIDGETS) {
      expect(GENUI_WIDGETS_BY_NAME[widget.name]).toBe(widget)
    }
  })

  it('builds OpenAI tool schemas for every widget', () => {
    const schemas = buildGenUIToolSchemas()
    expect(schemas.map((entry) => entry.function.name).sort()).toEqual(
      expectedNames,
    )
    for (const entry of schemas) {
      const widget = GENUI_WIDGETS_BY_NAME[entry.function.name]
      const parameters = entry.function.parameters
      const required = fixtures[entry.function.name].required
      expect(entry.type).toBe('function')
      expect(entry.function.description).toBe(widget.description)
      expect(entry.function.description.length).toBeGreaterThan(0)
      expect(parameters).toMatchObject({
        type: 'object',
        properties: Object.fromEntries(
          required.map((key) => [key, expect.any(Object)]),
        ),
      })
      expect(
        [...((parameters.required as string[] | undefined) ?? [])].sort(),
      ).toEqual([...required].sort())
    }
  })

  it('documents exact artifact HTML and Markdown source shapes', () => {
    const artifact = buildGenUIToolSchemas().find(
      (entry) => entry.function.name === 'render_artifact_preview',
    )
    const schemaText = JSON.stringify(artifact?.function.parameters)

    expect(schemaText).toContain('{\\"type\\":\\"html\\",\\"html\\":\\"...\\"}')
    expect(schemaText).toContain(
      '{\\"type\\":\\"markdown\\",\\"markdown\\":\\"...\\"}',
    )
    expect(
      GENUI_WIDGETS_BY_NAME.render_artifact_preview.schema.safeParse({
        source: { type: 'markdown', markdown: 123 },
      }).success,
    ).toBe(false)
  })

  it('opts every GenUI tool into router-side auto-continuation', () => {
    const schemas = buildGenUIToolSchemas()
    expect(schemas.map((entry) => entry.function.name).sort()).toEqual(
      expectedNames,
    )
    for (const entry of schemas) {
      const fn = entry.function as Record<string, unknown>
      expect(fn['x-tinfoil-tool-auto-continue']).toBe(true)
      expect(fn['x-tinfoil-display-only']).toBeUndefined()
    }
  })

  it('every widget either renders inline or in the input area (or both)', () => {
    for (const widget of GENUI_WIDGETS) {
      const hasInline = typeof widget.render === 'function'
      const hasInput = typeof widget.renderInputArea === 'function'
      expect(hasInline || hasInput).toBe(true)
      if (widget.surface === 'input') {
        expect(hasInput).toBe(true)
      }
      if (widget.render) {
        const args = widget.schema.parse(fixtures[widget.name].valid)
        expect(isValidElement(widget.render(args, {}))).toBe(true)
      }
    }
  })

  it('accepts valid fixtures and rejects invalid fixtures through each widget schema', () => {
    // Smoke-test — parses must succeed with a minimal valid payload.
    for (const widget of GENUI_WIDGETS) {
      const fixture = fixtures[widget.name]
      const parsed = widget.schema.safeParse(fixture.valid)
      expect(parsed.success).toBe(true)
      expect(widget.schema.safeParse(fixture.invalid).success).toBe(false)
    }
  })
})
