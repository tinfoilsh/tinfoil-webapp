import { MAX_FAVORITE_PRESETS } from '@/components/chat/hooks/use-prompt-library'
import { PromptLibraryModal } from '@/components/chat/prompt-library-modal'
import type { BaseModel } from '@/config/models'
import { getView, publish } from '@/services/harness/runtime'
import type { Session } from '@/services/harness/types'
import { StarIcon } from '@heroicons/react/24/outline'
import { StarIcon as StarIconSolid } from '@heroicons/react/24/solid'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { TfBookmarkFilled, TfBoxCheckmark } from '@tinfoilsh/tinfoil-icons'
import type { ReactElement } from 'react'
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

function renderModal(activePresetId: string | null = null) {
  return render(
    <PromptLibraryModal
      isOpen
      onClose={vi.fn()}
      activePresetId={activePresetId}
      onSelectPreset={vi.fn()}
      models={MODELS}
    />,
  )
}

function expectIcon(actual: Element | null, icon: ReactElement) {
  const template = document.createElement('template')
  template.innerHTML = renderToStaticMarkup(icon)
  const expected = template.content.querySelector('svg')!
  expect(actual).not.toBeNull()
  expect(actual!.innerHTML).toBe(expected.innerHTML)
  for (const attribute of ['fill', 'stroke', 'stroke-width', 'viewBox']) {
    expect(actual!.getAttribute(attribute)).toBe(
      expected.getAttribute(attribute),
    )
  }
  expect(actual).toHaveAttribute('aria-hidden', 'true')
  expect(actual).toHaveClass('h-3.5', 'w-3.5')
  expect(actual).not.toHaveClass('[stroke-width:initial]')
}

beforeEach(() => {
  publish({ session: { ...testSession, presets: PRESETS }, profile: {} })
})

describe('PromptLibraryModal favorite icons', () => {
  it('switches between real outline and solid stars when toggled, including the card badge', async () => {
    renderModal()
    const card = screen.getByRole('button', { name: new RegExp(PRESET.name) })
    const favorite = screen.getByRole('button', { name: 'Favorite' })
    expectIcon(favorite.querySelector('svg'), <StarIcon />)
    expect(favorite).toHaveClass('text-content-secondary')
    expect(within(card).queryByText('Favorite')).not.toBeInTheDocument()

    fireEvent.click(favorite)
    const selected = await screen.findByRole('button', { name: 'Favorited' })
    expect(getView().profile.favoritePromptPresetIds).toEqual([PRESET.id])
    expectIcon(selected.querySelector('svg'), <StarIconSolid />)
    expect(selected).toHaveClass('text-yellow-600', 'dark:text-yellow-400')
    const badgeLabel = within(card).getByText('Favorite')
    expect(badgeLabel).toHaveClass('sr-only')
    expectIcon(badgeLabel.previousElementSibling, <StarIconSolid />)
    expect(badgeLabel.previousElementSibling).toHaveClass('text-yellow-500')

    fireEvent.click(selected)
    const unselected = await screen.findByRole('button', { name: 'Favorite' })
    expect(getView().profile.favoritePromptPresetIds).toEqual([])
    expectIcon(unselected.querySelector('svg'), <StarIcon />)
    expect(within(card).queryByText('Favorite')).not.toBeInTheDocument()
  })

  it('renders a saved favorite badge alongside the active badge', () => {
    publish({ profile: { favoritePromptPresetIds: [PRESET.id] } })
    renderModal(PRESET.id)
    const card = screen.getByRole('button', { name: new RegExp(PRESET.name) })
    expectIcon(
      within(card).getByText('Favorite').previousElementSibling,
      <StarIconSolid />,
    )
    expectIcon(
      screen.getByRole('button', { name: 'Favorited' }).querySelector('svg'),
      <StarIconSolid />,
    )
    expectIcon(
      within(card).getByText('Active').previousElementSibling,
      <TfBoxCheckmark />,
    )
    expect(card).toHaveAttribute('aria-pressed', 'true')
    expect(card).toHaveAttribute('aria-current', 'true')
  })

  it('keeps the outline visible at capacity while allowing a solid favorite to be removed', async () => {
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
    expectIcon(favorite.querySelector('svg'), <StarIcon />)

    const pinnedCard = screen.getByRole('button', {
      name: new RegExp(favorites[0].name),
    })
    fireEvent.click(pinnedCard)
    const selected = screen.getByRole('button', { name: 'Favorited' })
    expect(selected).toBeEnabled()
    expectIcon(selected.querySelector('svg'), <StarIconSolid />)
    fireEvent.click(selected)
    const unpinned = await screen.findByRole('button', { name: 'Favorite' })
    expect(getView().profile.favoritePromptPresetIds).toEqual(
      favorites.slice(1).map((preset) => preset.id),
    )
    expect(unpinned).toBeEnabled()
    expectIcon(unpinned.querySelector('svg'), <StarIcon />)
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
