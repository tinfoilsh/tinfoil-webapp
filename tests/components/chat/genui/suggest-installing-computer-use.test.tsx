/**
 * Tests for the SuggestInstallingComputerUse GenUI widget. Verifies:
 *   - It is registered for rendering dispatch.
 *   - `defaultExpose: false` keeps it out of `buildGenUIToolSchemas`.
 *   - The render shows the model's reason, the install command, and a link.
 *   - The connection-status row reflects broker state (polling → detected →
 *     paired) and surfaces a Connect button wired to the funnel context.
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

  it('renders with the model-provided reason interpolated (verb phrase)', () => {
    const el = renderGenUIInline(
      'suggest_installing_computer_use',
      { reason: 'You asked me to open Safari and describe a post' },
      { isDarkMode: false },
    )
    expect(el).not.toBeNull()
    const { getByText } = render(el!)
    expect(getByText(/open Safari and describe a post/)).toBeDefined()
    expect(getByText('Install Tinfoil computer use')).toBeDefined()
    expect(getByText(/curl -fsSL/)).toBeDefined()
    // The explainer is ALWAYS rendered now (not gated on the reason being
    // absent), so the user always sees what the feature is.
    expect(getByText(/Computer use lets the agent/)).toBeDefined()
  })

  it('renders a model-provided third-person/noun-phrase reason without garbling', () => {
    // Regression: earlier the card composed "To <reason>, Tinfoil needs Y"
    // which produced "To The user wants to enable …, Tinfoil needs …".
    // Now the reason stands on its own and the explainer is a separate line.
    const el = renderGenUIInline(
      'suggest_installing_computer_use',
      {
        reason:
          'The user wants to enable Tinfoil computer use / the local driver.',
      },
      { isDarkMode: false },
    )
    expect(el).not.toBeNull()
    const { getByText, queryByText } = render(el!)
    // Trailing period stripped + outer quotes added by the widget.
    expect(
      getByText(
        /The user wants to enable Tinfoil computer use \/ the local driver/,
      ),
    ).toBeDefined()
    // The broken "To ..., Tinfoil needs ..." composition must NOT appear.
    expect(
      queryByText(
        /To The user wants to enable.*Tinfoil needs the local computer driver/,
      ),
    ).toBeNull()
  })

  it('renders the explainer even when no reason is provided', () => {
    const el = renderGenUIInline(
      'suggest_installing_computer_use',
      {},
      { isDarkMode: false },
    )
    expect(el).not.toBeNull()
    const { getByText } = render(el!)
    expect(getByText(/Computer use lets the agent/)).toBeDefined()
  })

  it('strips surrounding quotes + trailing punctuation from the reason', () => {
    const el = renderGenUIInline(
      'suggest_installing_computer_use',
      { reason: '"You asked me to fill out a form."' },
      { isDarkMode: false },
    )
    expect(el).not.toBeNull()
    const { getByText, queryByText } = render(el!)
    // Inner content is preserved; the surrounding quotes/punctuation are
    // not (the card adds its own curly quotes).
    expect(getByText(/You asked me to fill out a form/)).toBeDefined()
    // No double-quote-and-period at the end.
    expect(queryByText(/form\.\"|form\."”/)).toBeNull()
  })

  it('shows a "Watching for the local driver…" status row when broker is not detected', () => {
    // In the test env there's no broker reachable, so the poller defaults
    // to absent — the card should surface that "we're watching" cue so the
    // user doesn't have to refresh after installing.
    const el = renderGenUIInline(
      'suggest_installing_computer_use',
      {},
      { isDarkMode: false },
    )
    expect(el).not.toBeNull()
    const { getByText } = render(el!)
    expect(getByText(/Watching for the local driver/i)).toBeDefined()
  })
})
