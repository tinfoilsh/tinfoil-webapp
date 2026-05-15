import { truncateForCodeExec } from '@/components/chat/attachment-helpers'
import { CONSTANTS } from '@/components/chat/constants'
import type { DocumentPage } from '@/components/chat/types'
import { describe, expect, it } from 'vitest'

const CHARS_PER_TOKEN = 4
const TEXT_CHAR_CAP =
  CONSTANTS.CODE_EXEC_TEXT_TOKEN_CAP_PER_FILE * CHARS_PER_TOKEN
const MAX_PAGES = CONSTANTS.CODE_EXEC_MAX_PAGES_PER_FILE

const makePages = (n: number): DocumentPage[] =>
  Array.from({ length: n }, (_, i) => ({
    page: i + 1,
    text: `p${i + 1}`,
    image: '',
    is_scanned: false,
  }))

describe('truncateForCodeExec', () => {
  it('returns the input unchanged when content fits and no pages are over the cap', () => {
    const content = 'a'.repeat(TEXT_CHAR_CAP)
    const result = truncateForCodeExec({ content, fileName: 'small.md' })

    expect(result.truncated).toBe(false)
    expect(result.content).toBe(content)
    expect(result.content).not.toContain('truncated')
  })

  it('caps content at the char limit and appends a footer pointing to /user-uploads', () => {
    const content = 'a'.repeat(TEXT_CHAR_CAP + 1000)
    const result = truncateForCodeExec({
      content,
      fileName: 'big.csv',
    })

    expect(result.truncated).toBe(true)
    expect(result.content.startsWith('a'.repeat(TEXT_CHAR_CAP))).toBe(true)
    expect(result.content).toContain('/user-uploads/big.csv')
    expect(result.content).toContain('truncated')
  })

  it('caps pages at the max-pages limit', () => {
    const pages = makePages(MAX_PAGES + 5)
    const result = truncateForCodeExec({
      content: 'short',
      pages,
      fileName: 'long.pdf',
    })

    expect(result.truncated).toBe(true)
    expect(result.pages).toHaveLength(MAX_PAGES)
    expect(result.pages?.[0].page).toBe(1)
    expect(result.pages?.[MAX_PAGES - 1].page).toBe(MAX_PAGES)
    // Short text content is left alone — no footer.
    expect(result.content).toBe('short')
  })

  it('truncates content and pages together when both exceed the caps', () => {
    const content = 'a'.repeat(TEXT_CHAR_CAP + 10)
    const pages = makePages(MAX_PAGES + 3)
    const result = truncateForCodeExec({
      content,
      pages,
      fileName: 'huge.pdf',
    })

    expect(result.truncated).toBe(true)
    expect(result.content).toContain('/user-uploads/huge.pdf')
    expect(result.pages).toHaveLength(MAX_PAGES)
  })

  it('leaves pages alone when the array is at or below the cap', () => {
    const pages = makePages(MAX_PAGES)
    const result = truncateForCodeExec({
      content: 'short',
      pages,
      fileName: 'edge.pdf',
    })

    expect(result.truncated).toBe(false)
    expect(result.pages).toBe(pages)
  })
})
