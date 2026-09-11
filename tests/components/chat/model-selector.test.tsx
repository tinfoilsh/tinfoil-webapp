import { ModelSelector } from '@/components/chat/model-selector'
import { ModelSelectorTriggerLabel } from '@/components/chat/model-selector-trigger-label'
import { AUTO_MODEL_ID, type BaseModel } from '@/config/models'
import {
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

afterEach(cleanup)

describe('model lifecycle tags', () => {
  it.each([
    { flags: {}, experimental: false, deprecated: false },
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
    'renders the flags $flags in the menu and trigger',
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
      for (const element of [row, screen.getByTestId('trigger')]) {
        expect(within(element).queryByText('Experimental') !== null).toBe(
          experimental,
        )
        expect(within(element).queryByText('Deprecated') !== null).toBe(
          deprecated,
        )
        expect(within(element).getByText(model.name)).toBeVisible()
      }
      expect(row).toHaveAttribute('aria-checked', 'true')
      fireEvent.click(row)
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(model.modelName)
    },
  )

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
        selectedModel={AUTO_MODEL_ID}
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
