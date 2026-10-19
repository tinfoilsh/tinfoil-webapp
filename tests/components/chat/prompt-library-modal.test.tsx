import { MAX_FAVORITE_PRESETS } from '@/components/chat/hooks/use-prompt-library'
import { PromptLibraryModal } from '@/components/chat/prompt-library-modal'
import { BUILT_IN_PROMPT_PRESETS } from '@/components/chat/prompts/built-in-presets'
import {
  USER_PREFS_DEFAULT_PROMPT_PRESET_ID,
  USER_PREFS_FAVORITE_PROMPT_PRESETS,
} from '@/constants/storage-keys'
import { StarIcon } from '@heroicons/react/24/outline'
import { StarIcon as StarIconSolid } from '@heroicons/react/24/solid'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { TfBookmarkFilled, TfBoxCheckmark } from '@tinfoilsh/tinfoil-icons'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const PRESET = BUILT_IN_PROMPT_PRESETS[0]

function renderModal(activePresetId: string | null = null) {
  return render(
    <PromptLibraryModal
      isOpen
      onClose={vi.fn()}
      activePresetId={activePresetId}
      onSelectPreset={vi.fn()}
      models={[]}
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

describe('PromptLibraryModal favorite icons', () => {
  it('switches between real outline and solid stars when toggled, including the card badge', () => {
    renderModal()
    const card = screen.getByRole('button', { name: new RegExp(PRESET.name) })
    const favorite = screen.getByRole('button', { name: 'Favorite' })
    expectIcon(favorite.querySelector('svg'), <StarIcon />)
    expect(favorite).toHaveClass('text-content-secondary')
    expect(within(card).queryByText('Favorite')).not.toBeInTheDocument()

    fireEvent.click(favorite)
    const selected = screen.getByRole('button', { name: 'Favorited' })
    expectIcon(selected.querySelector('svg'), <StarIconSolid />)
    expect(selected).toHaveClass('text-yellow-600', 'dark:text-yellow-400')
    const badgeLabel = within(card).getByText('Favorite')
    expect(badgeLabel).toHaveClass('sr-only')
    expectIcon(badgeLabel.previousElementSibling, <StarIconSolid />)
    expect(badgeLabel.previousElementSibling).toHaveClass('text-yellow-500')

    fireEvent.click(selected)
    expectIcon(
      screen.getByRole('button', { name: 'Favorite' }).querySelector('svg'),
      <StarIcon />,
    )
    expect(within(card).queryByText('Favorite')).not.toBeInTheDocument()
  })

  it('renders a saved favorite badge alongside the Tinfoil default and active badges', () => {
    localStorage.setItem(
      USER_PREFS_FAVORITE_PROMPT_PRESETS,
      JSON.stringify([PRESET.id]),
    )
    localStorage.setItem(USER_PREFS_DEFAULT_PROMPT_PRESET_ID, PRESET.id)
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
      within(card).getByText('Default for new chats').previousElementSibling,
      <TfBookmarkFilled />,
    )
    expectIcon(
      within(card).getByText('Active').previousElementSibling,
      <TfBoxCheckmark />,
    )
    expect(card).toHaveAttribute('aria-pressed', 'true')
    expect(card).toHaveAttribute('aria-current', 'true')
  })

  it('keeps the outline visible at capacity while allowing a solid favorite to be removed', () => {
    const favorites = BUILT_IN_PROMPT_PRESETS.slice(1, MAX_FAVORITE_PRESETS + 1)
    localStorage.setItem(
      USER_PREFS_FAVORITE_PROMPT_PRESETS,
      JSON.stringify(favorites.map((preset) => preset.id)),
    )
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
    const unpinned = screen.getByRole('button', { name: 'Favorite' })
    expect(unpinned).toBeEnabled()
    expectIcon(unpinned.querySelector('svg'), <StarIcon />)
    expect(within(pinnedCard).queryByText('Favorite')).not.toBeInTheDocument()
  })
})
