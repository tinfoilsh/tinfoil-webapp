import { ModelSelector } from '@/components/chat/model-selector'
import { ModelSelectorTriggerLabel } from '@/components/chat/model-selector-trigger-label'
import type { BaseModel } from '@/config/models'
import { publish } from '@/services/harness/runtime'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testSession } from '../../harness-fixture'

const MODEL: BaseModel = {
  id: 'gpt-oss-120b',
  icon: 'openai.png',
  label: 'GPT-OSS 120B',
  shortLabel: 'GPT-OSS',
  description: 'Reasoning model',
  badges: [],
  reasoning: null,
  deprecated: false,
}
const EXPERIMENTAL = {
  kind: 'experimental' as const,
  label: 'Experimental',
  tooltip: 'Support and availability are not guaranteed.',
}
const DEPRECATED = {
  kind: 'deprecated' as const,
  label: 'Deprecated',
  tooltip: 'This model will be taken offline on 2026-10-01.',
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('model lifecycle tags', () => {
  it.each([
    { badges: [], experimental: false, deprecated: false },
    { badges: [EXPERIMENTAL], experimental: true, deprecated: false },
    { badges: [DEPRECATED], experimental: false, deprecated: true },
    {
      badges: [EXPERIMENTAL, DEPRECATED],
      experimental: true,
      deprecated: true,
    },
  ])(
    'renders the badges $badges only in the menu',
    ({ badges, experimental, deprecated }) => {
      const model = { ...MODEL, badges }
      const onSelect = vi.fn()
      render(
        <>
          <button type="button" data-testid="trigger">
            <ModelSelectorTriggerLabel
              selectedModel={model.id}
              models={[model]}
              autoIntelligence="high"
              isOpen={true}
            />
          </button>
          <ModelSelector
            selectedModel={model.id}
            models={[model]}
            onSelect={onSelect}
            isDarkMode={false}
          />
        </>,
      )

      const row = screen.getByRole('menuitemradio', { name: /GPT-OSS 120B/ })
      const trigger = screen.getByTestId('trigger')
      expect(
        within(trigger).queryByText('Experimental'),
      ).not.toBeInTheDocument()
      expect(within(trigger).queryByText('Deprecated')).not.toBeInTheDocument()
      expect(within(trigger).getByText(model.label)).toBeVisible()
      expect(within(row).queryByText('Experimental') !== null).toBe(
        experimental,
      )
      expect(within(row).queryByText('Deprecated') !== null).toBe(deprecated)
      expect(within(row).getByText(model.label)).toBeVisible()
      expect(row).toHaveAttribute('aria-checked', 'true')
      fireEvent.click(row)
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(model.id)
    },
  )

  it('shows no badge of a kind this client does not know', () => {
    const model: BaseModel = {
      ...MODEL,
      badges: [
        { kind: 'retiring', label: 'Retiring', tooltip: 'Leaving soon.' },
        EXPERIMENTAL,
      ],
    }
    render(
      <ModelSelector
        selectedModel={model.id}
        models={[model]}
        onSelect={vi.fn()}
        isDarkMode={false}
      />,
    )

    const row = screen.getByRole('menuitemradio', { name: /GPT-OSS 120B/ })
    expect(within(row).getByText('Experimental')).toBeVisible()
    expect(within(row).queryByText('Retiring')).not.toBeInTheDocument()
  })

  it('hides deprecated models unless one is the current selection', () => {
    const selectedDeprecated: BaseModel = {
      ...MODEL,
      id: 'old-selected',
      label: 'Old selected',
      deprecated: true,
      badges: [DEPRECATED],
    }
    const models: BaseModel[] = [
      { ...MODEL, id: 'old-top', label: 'Old top', deprecated: true },
      ...Array.from({ length: 20 }, (_, index) => ({
        ...MODEL,
        id: `chat-${index}`,
        label: `Chat ${index}`,
      })),
      selectedDeprecated,
      { ...MODEL, id: 'old-other', label: 'Old other', deprecated: true },
    ]
    render(
      <>
        <button type="button" data-testid="trigger">
          <ModelSelectorTriggerLabel
            selectedModel={selectedDeprecated.id}
            models={models}
            autoIntelligence="high"
            isOpen={true}
          />
        </button>
        <ModelSelector
          selectedModel={selectedDeprecated.id}
          models={models}
          onSelect={vi.fn()}
          isDarkMode={false}
        />
      </>,
    )
    expect(
      within(screen.getByTestId('trigger')).getByText('Old selected'),
    ).toBeVisible()
    expect(screen.getByText('Chat 0')).toBeVisible()
    expect(screen.queryByText('Old top')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Other models' }))
    expect(screen.getByText('Chat 19')).toBeVisible()
    expect(screen.queryByText('Old top')).not.toBeInTheDocument()
    expect(screen.queryByText('Old other')).not.toBeInTheDocument()
    const row = screen.getByRole('menuitemradio', { name: /Old selected/ })
    expect(row).toHaveAttribute('aria-checked', 'true')
    expect(within(row).getByText('Deprecated')).toBeVisible()
  })

  it('shows tags with a description under Other models', () => {
    const taggedModel: BaseModel = {
      ...MODEL,
      deprecated: true,
      badges: [EXPERIMENTAL, DEPRECATED],
      description: 'Best for quick reasoning tasks',
    }
    const models: BaseModel[] = [
      ...Array.from({ length: 20 }, (_, index) => ({
        ...MODEL,
        id: `chat-${index}`,
        label: `Chat ${index}`,
      })),
      taggedModel,
    ]
    const onSelect = vi.fn()
    render(
      <ModelSelector
        selectedModel={taggedModel.id}
        models={models}
        onSelect={onSelect}
        isDarkMode={true}
      />,
    )

    expect(screen.queryByText(taggedModel.label)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Other models' }))
    const row = screen.getByRole('menuitemradio', { name: /GPT-OSS 120B/ })
    expect(within(row).getByText('Experimental')).toBeVisible()
    expect(within(row).getByText('Deprecated')).toBeVisible()
    const name = within(row).getByText(taggedModel.label)
    const description = within(row).getByText('Best for quick reasoning tasks')
    const badgeRow = within(row).getByText('Experimental').parentElement
    expect(name.nextElementSibling).toBe(description)
    expect(description.nextElementSibling).toBe(badgeRow)
    expect(name.parentElement).toHaveClass('flex-col')
    expect(
      within(row).getByText('Best for quick reasoning tasks'),
    ).toBeVisible()
    fireEvent.click(row)
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(taggedModel.id)
  })

  it('shows Auto as the session labels the chosen level', () => {
    publish({
      session: {
        ...testSession,
        auto: {
          default: 'high',
          levels: [
            { id: 'low', label: 'Low', displayLabel: 'Auto, quick' },
            { id: 'high', label: 'High', displayLabel: 'Auto, thorough' },
          ],
        },
      },
    })
    render(
      <>
        <ModelSelectorTriggerLabel
          selectedModel="auto"
          models={testSession.models}
          autoIntelligence="high"
          isOpen={false}
        />
        <ModelSelector
          selectedModel="auto"
          models={testSession.models}
          onSelect={vi.fn()}
          isDarkMode={false}
          autoIntelligence="high"
          onAutoIntelligenceChange={vi.fn()}
        />
      </>,
    )
    expect(screen.getByText('Auto, thorough')).toHaveAttribute(
      'aria-hidden',
      'false',
    )
    expect(screen.getByText('Auto, quick')).toHaveAttribute(
      'aria-hidden',
      'true',
    )
    expect(
      screen.getByRole('menuitemradio', { name: /^Auto/ }),
    ).toHaveAttribute('aria-checked', 'true')
    expect(
      screen.getByRole('menuitemradio', { name: /Test model/ }),
    ).toHaveAttribute('aria-checked', 'false')
    expect(
      screen.getByRole('slider', { name: 'Auto intelligence' }),
    ).toBeVisible()
  })

  it.each([EXPERIMENTAL, DEPRECATED])(
    'shows the $label explanation immediately on hover without selecting the model',
    async ({ label, tooltip }) => {
      vi.useFakeTimers()
      const onSelect = vi.fn()
      render(
        <ModelSelector
          selectedModel={MODEL.id}
          models={[{ ...MODEL, badges: [EXPERIMENTAL, DEPRECATED] }]}
          onSelect={onSelect}
          isDarkMode={false}
        />,
      )
      const row = screen.getByRole('menuitemradio', { name: /GPT-OSS 120B/ })
      const badge = within(row).getByText(label)
      expect(badge.tagName).toBe('SPAN')
      expect(badge).not.toHaveAttribute('tabindex')
      expect(row.querySelector('button')).toBeNull()
      expect(within(badge).getByText(`: ${tooltip}`)).toHaveClass('sr-only')
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

      // Advancing by 0ms flushes Radix's zero-delay open timer but would leave a
      // real hover delay pending, so this fails if one is reintroduced.
      await act(async () => {
        fireEvent.pointerMove(badge, { pointerType: 'mouse' })
        await vi.advanceTimersByTimeAsync(0)
      })
      const content = screen.getByRole('tooltip')
      expect(content).toHaveTextContent(tooltip)
      expect(row.contains(content)).toBe(false)
      expect(onSelect).not.toHaveBeenCalled()

      fireEvent.keyDown(badge, { key: 'Escape' })
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
      fireEvent.click(badge)
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(MODEL.id)
    },
  )

  it('renders no trigger label for an unavailable model', () => {
    const { container } = render(
      <ModelSelectorTriggerLabel
        selectedModel={MODEL.id}
        models={[]}
        autoIntelligence="high"
        isOpen={false}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
