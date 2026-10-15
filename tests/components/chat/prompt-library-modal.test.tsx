import { MAX_FAVORITE_PRESETS } from '@/components/chat/hooks/use-prompt-library'
import { PromptLibraryModal } from '@/components/chat/prompt-library-modal'
import { getView, publish } from '@/services/harness/runtime'
import type { Session } from '@/services/harness/types'
import { StarIcon } from '@heroicons/react/24/outline'
import { StarIcon as StarIconSolid } from '@heroicons/react/24/solid'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { TfBoxCheckmark } from '@tinfoilsh/tinfoil-icons'
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

function renderModal(activePresetId: string | null = null) {
  return render(
    <PromptLibraryModal
      isOpen
      onClose={vi.fn()}
      activePresetId={activePresetId}
      onSelectPreset={vi.fn()}
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
