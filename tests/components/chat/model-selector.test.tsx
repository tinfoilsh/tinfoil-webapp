import { ModelSelector } from '@/components/chat/model-selector'
import { ModelSelectorTriggerLabel } from '@/components/chat/model-selector-trigger-label'
import { AUTO_MODEL_ID, type BaseModel } from '@/config/models'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const MODEL: BaseModel = {
  modelName: 'gpt-oss-120b',
  image: 'openai.png',
  name: 'GPT-OSS 120B',
  nameShort: 'GPT-OSS',
  description: 'Reasoning model',
  type: 'chat',
  chat: true,
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('model lifecycle tags', () => {
  it.each([
    { flags: {}, experimental: false, deprecated: false },
    {
      flags: { deprecationDate: '2026-10-01' },
      experimental: false,
      deprecated: false,
    },
    {
      flags: { experimental: false, deprecated: false },
      experimental: false,
      deprecated: false,
    },
    { flags: { experimental: true }, experimental: true, deprecated: false },
    { flags: { deprecated: true }, experimental: false, deprecated: true },
    {
      flags: { experimental: true, deprecated: true },
      experimental: true,
      deprecated: true,
    },
  ])(
    'renders the flags $flags only in the menu',
    ({ flags, experimental, deprecated }) => {
      const model = { ...MODEL, ...flags }
      const onSelect = vi.fn()
      render(
        <>
          <button type="button" data-testid="trigger">
            <ModelSelectorTriggerLabel
              selectedModel={model.modelName}
              models={[model]}
              autoIntelligence="high"
              isOpen={true}
            />
          </button>
          <ModelSelector
            selectedModel={model.modelName}
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
      expect(within(trigger).getByText(model.name)).toBeVisible()
      expect(within(row).queryByText('Experimental') !== null).toBe(
        experimental,
      )
      expect(within(row).queryByText('Deprecated') !== null).toBe(deprecated)
      expect(within(row).getByText(model.name)).toBeVisible()
      expect(row).toHaveAttribute('aria-checked', 'true')
      fireEvent.click(row)
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(model.modelName)
    },
  )

  it('hides deprecated models unless one is the current selection', () => {
    const selectedDeprecated: BaseModel = {
      ...MODEL,
      modelName: 'old-selected',
      name: 'Old selected',
      deprecated: true,
    }
    const models: BaseModel[] = [
      { ...MODEL, modelName: 'old-top', name: 'Old top', deprecated: true },
      ...Array.from({ length: 20 }, (_, index) => ({
        ...MODEL,
        modelName: `chat-${index}`,
        name: `Chat ${index}`,
      })),
      selectedDeprecated,
      { ...MODEL, modelName: 'old-other', name: 'Old other', deprecated: true },
    ]
    render(
      <>
        <button type="button" data-testid="trigger">
          <ModelSelectorTriggerLabel
            selectedModel={selectedDeprecated.modelName}
            models={models}
            autoIntelligence="high"
            isOpen={true}
          />
        </button>
        <ModelSelector
          selectedModel={selectedDeprecated.modelName}
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

  it('shows tags with a description under Other models without exposing API-only models', () => {
    const taggedModel: BaseModel = {
      ...MODEL,
      experimental: true,
      deprecated: true,
      chatConfig: { descriptionShort: 'Best for quick reasoning tasks' },
    }
    const models: BaseModel[] = [
      ...Array.from({ length: 20 }, (_, index) => ({
        ...MODEL,
        modelName: `chat-${index}`,
        name: `Chat ${index}`,
      })),
      taggedModel,
      { ...taggedModel, modelName: 'api-only', name: 'API only', chat: false },
    ]
    const onSelect = vi.fn()
    render(
      <ModelSelector
        selectedModel={taggedModel.modelName}
        models={models}
        onSelect={onSelect}
        isDarkMode={true}
      />,
    )

    expect(screen.queryByText(taggedModel.name)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Other models' }))
    const row = screen.getByRole('menuitemradio', { name: /GPT-OSS 120B/ })
    expect(within(row).getByText('Experimental')).toBeVisible()
    expect(within(row).getByText('Deprecated')).toBeVisible()
    const name = within(row).getByText(taggedModel.name)
    const description = within(row).getByText('Best for quick reasoning tasks')
    const badgeRow = within(row).getByText('Experimental').parentElement
    expect(name.nextElementSibling).toBe(description)
    expect(description.nextElementSibling).toBe(badgeRow)
    expect(name.parentElement).toHaveClass('flex-col')
    expect(
      within(row).getByText('Best for quick reasoning tasks'),
    ).toBeVisible()
    expect(screen.queryByText('API only')).not.toBeInTheDocument()
    fireEvent.click(row)
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(taggedModel.modelName)
  })

  it('does not inherit tags from candidates when Auto is selected', () => {
    render(
      <ModelSelectorTriggerLabel
        selectedModel={AUTO_MODEL_ID}
        models={[{ ...MODEL, experimental: true, deprecated: true }]}
        autoIntelligence="high"
        isOpen={false}
      />,
    )
    expect(screen.getByText('Auto · High')).toBeVisible()
    expect(screen.queryByText('Experimental')).not.toBeInTheDocument()
    expect(screen.queryByText('Deprecated')).not.toBeInTheDocument()
  })

  it.each([
    {
      flags: { experimental: true },
      label: 'Experimental',
      tooltip:
        'Support and availability are not guaranteed. This model can be deprecated at any time.',
    },
    {
      flags: { deprecated: true },
      label: 'Deprecated',
      tooltip:
        'This model is deprecated. An offline date has not been announced.',
    },
    {
      flags: {
        experimental: true,
        deprecated: true,
        deprecationDate: '2026-10-01',
      },
      label: 'Deprecated',
      tooltip: 'This model will be taken offline on 2026-10-01.',
    },
  ])(
    'shows the $label explanation immediately on hover without selecting the model',
    async ({ flags, label, tooltip }) => {
      vi.useFakeTimers()
      const onSelect = vi.fn()
      render(
        <ModelSelector
          selectedModel={MODEL.modelName}
          models={[{ ...MODEL, ...flags }]}
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
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(MODEL.modelName)
    },
  )

  it('renders no trigger label for an unavailable model', () => {
    const { container } = render(
      <ModelSelectorTriggerLabel
        selectedModel={MODEL.modelName}
        models={[]}
        autoIntelligence="high"
        isOpen={false}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
