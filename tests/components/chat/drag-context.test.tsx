import { DragProvider, useDrag } from '@/components/chat/drag-context'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

function DragHarness() {
  const { draggingChatSource, setDraggingChat, clearDragState } = useDrag()
  return (
    <>
      <output aria-label="drag source">{draggingChatSource ?? 'none'}</output>
      <button
        type="button"
        onClick={() => setDraggingChat('chat-a', null, 'favorites')}
      >
        Start favorite drag
      </button>
      <button type="button" onClick={clearDragState}>
        Clear drag
      </button>
    </>
  )
}

describe('DragProvider', () => {
  it('tracks and clears favorite drag sources', () => {
    render(
      <DragProvider>
        <DragHarness />
      </DragProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Start favorite drag' }))
    expect(screen.getByLabelText('drag source')).toHaveTextContent('favorites')

    fireEvent.click(screen.getByRole('button', { name: 'Clear drag' }))
    expect(screen.getByLabelText('drag source')).toHaveTextContent('none')
  })
})
