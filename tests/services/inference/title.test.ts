import type { Message } from '@/components/chat/types'
import { TITLE_SOURCE_MAX_CHARACTERS } from '@/services/inference/constants'
import { getTitleContent } from '@/services/inference/title'
import { describe, expect, it } from 'vitest'

function message(overrides: Partial<Message>): Message {
  return {
    role: 'user',
    content: '',
    timestamp: new Date('2026-08-12T00:00:00.000Z'),
    ...overrides,
  }
}

describe('getTitleContent', () => {
  it('bounds large message content before title processing', () => {
    const opening = 'Opening: '
    const retained =
      opening + 'A'.repeat(TITLE_SOURCE_MAX_CHARACTERS - opening.length)
    const content = getTitleContent(
      message({ content: retained + 'Discard this ending.' }),
    )

    expect(content).toBe(retained)
  })

  it('prefers trimmed message content over attachment text', () => {
    expect(
      getTitleContent(
        message({
          content: '  Short title source  ',
          attachments: [
            {
              id: 'unused',
              type: 'document',
              fileName: 'unused.txt',
              textContent: 'Do not prefer attachment text',
            },
          ],
        }),
      ),
    ).toBe('Short title source')
  })

  it('bounds combined attachment content and uses metadata fallbacks', () => {
    const content = getTitleContent(
      message({
        attachments: [
          {
            id: 'attachment-1',
            type: 'document',
            fileName: 'fallback.pdf',
            textContent: ' '.repeat(TITLE_SOURCE_MAX_CHARACTERS * 2),
          },
          {
            id: 'attachment-2',
            type: 'document',
            fileName: 'second.pdf',
            textContent: 'B'.repeat(TITLE_SOURCE_MAX_CHARACTERS * 2),
          },
        ],
      }),
    )

    const prefix = 'fallback.pdf\n'
    expect(content).toBe(
      prefix + 'B'.repeat(TITLE_SOURCE_MAX_CHARACTERS - prefix.length),
    )
    expect(
      getTitleContent(
        message({
          attachments: [
            {
              id: 'description',
              type: 'image',
              fileName: 'fallback.png',
              textContent: ' ',
              description: ' Description text ',
            },
            {
              id: 'text',
              type: 'document',
              fileName: 'ignored.txt',
              textContent: 'Preferred text',
              description: 'Ignored description',
            },
          ],
        }),
      ),
    ).toBe('Description text\nPreferred text')
  })
})
