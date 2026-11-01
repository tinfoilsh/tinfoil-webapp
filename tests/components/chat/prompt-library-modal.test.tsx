import { MAX_FAVORITE_PRESETS } from '@/components/chat/hooks/use-prompt-library'
import { PromptLibraryModal } from '@/components/chat/prompt-library-modal'
import type { BaseModel } from '@/config/models'
import { getView, publish } from '@/services/harness/runtime'
import type { Session } from '@/services/harness/types'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { TfBookmarkFilled } from '@tinfoilsh/tinfoil-icons'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { testSession } from '../../harness-fixture'

const PRESETS: Session['presets'] = Array.from(
  { length: MAX_FAVORITE_PRESETS + 2 },
  (_, index) => ({
    id: `preset-${index}`,
    name: `Preset ${index}`,
    description: `Description ${index}`,
    icon: 'code',
    systemPrompt: `Prompt ${index}`,
    builtIn: true,
  }),
)
const PRESET = PRESETS[0]
const MODELS: BaseModel[] = [
  {
    modelName: 'auto',
    name: 'Auto',
    nameShort: 'Auto',
    image: '',
    description: '',
    type: 'chat',
    chat: true,
    isAuto: true,
  },
  {
    modelName: 'deep-model',
    name: 'Deep model',
    nameShort: 'Deep',
    image: '',
    description: '',
    type: 'chat',
    chat: true,
  },
]
const SAVED = {
  id: 'user:research',
  name: 'Research',
  description: 'Cites sources',
  systemPrompt: '<system>Cite sources.</system>',
  createdAt: 1,
  updatedAt: 1,
  model: 'deep-model',
  webSearchEnabled: false,
}

function renderModal() {
  return render(
    <PromptLibraryModal
      isOpen
      onClose={vi.fn()}
      activePresetId={null}
      onSelectPreset={vi.fn()}
      models={MODELS}
    />,
  )
}

beforeEach(() => {
  publish({ session: { ...testSession, presets: PRESETS }, profile: {} })
})

describe('PromptLibraryModal favorites', () => {
  it('stops adding favorites at capacity while allowing one to be removed', async () => {
    const favorites = PRESETS.slice(1, MAX_FAVORITE_PRESETS + 1)
    publish({
      profile: {
        favoritePromptPresetIds: favorites.map((preset) => preset.id),
      },
    })
    renderModal()
    const favorite = screen.getByRole('button', { name: 'Favorite' })
    expect(favorite).toBeDisabled()
    expect(favorite).toHaveAttribute(
      'title',
      `You can pin up to ${MAX_FAVORITE_PRESETS} favorites`,
    )

    const pinnedCard = screen.getByRole('button', {
      name: new RegExp(favorites[0].name),
    })
    fireEvent.click(pinnedCard)
    const selected = screen.getByRole('button', { name: 'Favorited' })
    expect(selected).toBeEnabled()
    expect(within(pinnedCard).getByText('Favorite')).toBeInTheDocument()
    fireEvent.click(selected)
    const unpinned = await screen.findByRole('button', { name: 'Favorite' })
    expect(getView().profile.favoritePromptPresetIds).toEqual(
      favorites.slice(1).map((preset) => preset.id),
    )
    expect(unpinned).toBeEnabled()
    expect(within(pinnedCard).queryByText('Favorite')).not.toBeInTheDocument()
  })
})

describe('PromptLibraryModal default prompt', () => {
  const withDefaults = (profile: Record<string, unknown> = {}) =>
    publish({
      session: { ...testSession, presets: PRESETS },
      profile,
    })

  it('sets a prompt as the default for new chats and marks its card', async () => {
    withDefaults()
    renderModal()
    const card = screen.getByRole('button', { name: new RegExp(PRESET.name) })

    fireEvent.click(screen.getByRole('button', { name: 'Set as default' }))

    const current = await screen.findByRole('button', {
      name: 'Default for new chats',
    })
    expect(current).toHaveAttribute('aria-pressed', 'true')
    expect(getView().profile.defaultPromptPresetId).toBe(PRESET.id)
    const badge = within(card).getByText('Default for new chats')
    expect(badge).toHaveClass('sr-only')
    expect(badge.previousElementSibling?.innerHTML).toBe(
      document
        .createRange()
        .createContextualFragment(renderToStaticMarkup(<TfBookmarkFilled />))
        .querySelector('svg')?.innerHTML,
    )

    fireEvent.click(current)
    await screen.findByRole('button', { name: 'Set as default' })
    expect(getView().profile.defaultPromptPresetId).toBe('')
  })

  it("shows a saved prompt's chat settings and edits them", async () => {
    withDefaults({ customPromptPresets: [SAVED] })
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /Research/ }))

    const settings = screen.getByText('Chat settings').nextElementSibling!
    expect(settings).toHaveTextContent('ModelDeep modelWeb searchOff')

    fireEvent.click(screen.getByRole('button', { name: /Edit/ }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), {
      target: { value: '' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Web search' }), {
      target: { value: 'on' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Save/ }))

    await screen.findByText('Chat settings')
    const [saved] = getView().profile.customPromptPresets as Record<
      string,
      unknown
    >[]
    expect(saved).toEqual({
      id: SAVED.id,
      name: SAVED.name,
      description: SAVED.description,
      systemPrompt: '<system>\nCite sources.\n</system>',
      createdAt: SAVED.createdAt,
      updatedAt: expect.any(Number),
      webSearchEnabled: true,
    })
    expect(
      screen.getByText('Chat settings').nextElementSibling,
    ).toHaveTextContent('ModelNo override setWeb searchOn')
  })
})
