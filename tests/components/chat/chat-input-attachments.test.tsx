import { ChatInput } from '@/components/chat/chat-input'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef, type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { signIn, testSession } from '../../harness-fixture'

vi.mock('@/components/project', () => ({
  ProjectModeBanner: () => null,
  useProject: () => ({
    isProjectMode: false,
    activeProject: null,
    loadingProject: false,
  }),
}))

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}))

vi.mock('@/components/chat/hooks/use-chat-font', () => ({
  CHAT_FONT_CLASSES: { default: '' },
  useChatFont: () => 'default',
}))

function renderChatInput(
  overrides: Partial<ComponentProps<typeof ChatInput>> = {},
) {
  return render(
    <ChatInput
      input=""
      setInput={vi.fn()}
      handleSubmit={vi.fn()}
      loadingState="idle"
      cancelGeneration={vi.fn()}
      inputRef={createRef<HTMLTextAreaElement>()}
      handleInputFocus={vi.fn()}
      inputMinHeight="40px"
      isDarkMode
      {...overrides}
    />,
  )
}

// A session whose composer turns a paste longer than 12 characters into a
// file, and whose picker offers two groups of files.
function signInWithComposer() {
  signIn({
    session: {
      ...testSession,
      composer: {
        ...testSession.composer,
        attachments: [
          { accept: ['.png', '.jpg'], maxBytes: 1000 },
          { accept: ['.pdf'], maxBytes: 2000 },
        ],
        pasteAsFileChars: 12,
      },
    },
  })
}

const paste = (text: string) =>
  fireEvent.paste(screen.getByRole('textbox'), {
    clipboardData: { items: [], getData: () => text },
  })

describe('ChatInput attachments', () => {
  it('uploads pasted text longer than the session allows as an attachment', async () => {
    signInWithComposer()
    const handleDocumentUpload = vi.fn().mockResolvedValue(undefined)
    renderChatInput({ handleDocumentUpload })

    expect(paste('a'.repeat(12))).toBe(true)
    expect(handleDocumentUpload).not.toHaveBeenCalled()
    const pastedText = 'b'.repeat(13)
    expect(paste(pastedText)).toBe(false)

    await waitFor(() => expect(handleDocumentUpload).toHaveBeenCalledOnce())
    const file = handleDocumentUpload.mock.calls[0][0] as File
    expect(file.name).toMatch(/^pasted-text-.*\.txt$/)
    expect(await file.text()).toBe(pastedText)
  })

  it('offers the files the session accepts', () => {
    signInWithComposer()
    const { container } = renderChatInput({ handleDocumentUpload: vi.fn() })
    expect(
      container.querySelector('input[type="file"]')?.getAttribute('accept'),
    ).toBe('.png,.jpg,.pdf')
  })
})
