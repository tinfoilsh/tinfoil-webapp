/**
 * Tests for the SuggestInstallingComputerUse GenUI widget. Verifies:
 *   - It is registered for rendering dispatch.
 *   - `defaultExpose: false` keeps it out of `buildGenUIToolSchemas`.
 *   - The render shows the model's reason, the install command, and a link.
 */
import {
  buildGenUIToolSchemas,
  GENUI_WIDGETS_BY_NAME,
} from '@/components/chat/genui/registry'
import { renderGenUIInline } from '@/components/chat/genui/render'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('suggest_installing_computer_use widget', () => {
  it('is registered for rendering', () => {
    const widget = GENUI_WIDGETS_BY_NAME['suggest_installing_computer_use']
    expect(widget).toBeDefined()
    expect(widget.render).toBeDefined()
  })

  it('is NOT exposed via buildGenUIToolSchemas (defaultExpose: false)', () => {
    const names = new Set(buildGenUIToolSchemas().map((s) => s.function.name))
    expect(names.has('suggest_installing_computer_use')).toBe(false)
  })

  it('renders with the model-provided reason interpolated', () => {
    const el = renderGenUIInline(
      'suggest_installing_computer_use',
      { reason: 'open Safari and describe a post' },
      { isDarkMode: false },
    )
    expect(el).not.toBeNull()
    const { getByText } = render(el!)
    expect(getByText(/open Safari and describe a post/)).toBeDefined()
    expect(getByText('Install Tinfoil computer use')).toBeDefined()
    expect(getByText(/curl -fsSL/)).toBeDefined()
  })

  it('renders a default explainer when no reason is provided', () => {
    const el = renderGenUIInline(
      'suggest_installing_computer_use',
      {},
      { isDarkMode: false },
    )
    expect(el).not.toBeNull()
    const { getByText } = render(el!)
    expect(getByText(/Computer use lets the agent/)).toBeDefined()
  })
})
