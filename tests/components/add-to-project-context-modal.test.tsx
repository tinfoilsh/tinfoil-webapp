import { AddToProjectContextModal } from '@/components/modals/add-to-project-context-modal'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

describe('AddToProjectContextModal', () => {
  it('asks for each upload destination without remembering the choice', () => {
    const onConfirm = vi.fn()
    render(
      <AddToProjectContextModal
        isOpen
        onClose={vi.fn()}
        onConfirm={onConfirm}
        fileName="notes.txt"
        projectName="Research"
        isDarkMode
      />,
    )

    expect(
      screen.queryByText('Remember my decision for future uploads'),
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'No, just this chat' }))
    expect(onConfirm).toHaveBeenCalledWith(false)

    fireEvent.click(screen.getByRole('button', { name: 'Yes, add to project' }))
    expect(onConfirm).toHaveBeenCalledWith(true)
  })
})
