import {
  buildGenUIToolSchemas,
  GENUI_WIDGETS,
  GENUI_WIDGETS_BY_NAME,
} from '@/components/chat/genui/registry'
import { describe, expect, it } from 'vitest'

describe('GenUI registry', () => {
  it('has unique render_* tool names', () => {
    const names = GENUI_WIDGETS.map((w) => w.name)
    expect(names).toEqual(Array.from(new Set(names)))
    for (const name of names) {
      expect(name).toMatch(/^render_[a-z_]+$/)
    }
  })

  it('GENUI_WIDGETS_BY_NAME covers every widget', () => {
    for (const widget of GENUI_WIDGETS) {
      expect(GENUI_WIDGETS_BY_NAME[widget.name]).toBe(widget)
    }
  })

  it('builds OpenAI tool schemas for every widget', () => {
    const schemas = buildGenUIToolSchemas()
    expect(schemas).toHaveLength(GENUI_WIDGETS.length)
    for (const entry of schemas) {
      expect(entry.type).toBe('function')
      expect(typeof entry.function.name).toBe('string')
      expect(typeof entry.function.description).toBe('string')
      expect(entry.function.parameters).toBeTruthy()
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
    }
  })

  it('accepts valid fixtures through each widget schema', () => {
    // Smoke-test — parses must succeed with a minimal valid payload.
    const fixtures: Record<string, unknown> = {
      render_info_card: { title: 'Hello' },
      render_data_table: {
        columns: ['A', 'B'],
        rows: [{ A: 1, B: 'x' }],
      },
      render_stat_cards: { stats: [{ label: 'Users', value: 10 }] },
      render_steps: { steps: [{ title: 'Do it' }] },
      render_callout: { content: 'note' },
      render_key_value_list: { items: [{ label: 'L', value: 'V' }] },
      render_timeline: { events: [{ date: '2024', title: 'E' }] },
      render_comparison_table: {
        items: ['A', 'B'],
        features: [{ label: 'Feat', values: [true, false] }],
      },
      render_task_plan: { tasks: [{ title: 'Task' }] },
      render_bar_chart: { data: [{ label: 'A', value: 1 }] },
      render_line_chart: { data: [{ x: 'Jan', y: 1 }] },
      render_pie_chart: { data: [{ name: 'A', value: 1 }] },
      render_progress_bar: { label: 'L', value: 50 },
      render_gauge: { label: 'Speed', value: 60 },
    }
    for (const widget of GENUI_WIDGETS) {
      const fixture = fixtures[widget.name]
      if (fixture === undefined) continue
      const parsed = widget.schema.safeParse(fixture)
      expect(parsed.success).toBe(true)
    }
  })
})
