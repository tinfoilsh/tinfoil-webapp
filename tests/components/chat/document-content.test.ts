import { getDocumentTextContent } from '@/components/chat/document-content'
import { describe, expect, it } from 'vitest'

describe('getDocumentTextContent', () => {
  it('uses extracted markdown when available', () => {
    expect(getDocumentTextContent('# Notes')).toBe('# Notes')
  })

  it('recovers text from processed pages', () => {
    expect(
      getDocumentTextContent('', [
        { page: 1, text: 'First page', image: '', is_scanned: false },
        { page: 2, text: 'Second page', image: '', is_scanned: true },
      ]),
    ).toBe('First page\n\n---\n\nSecond page')
  })

  it('rejects processing results without readable content', () => {
    expect(getDocumentTextContent('   ', [])).toBeNull()
  })

  it('ignores malformed page entries from restored chats', () => {
    expect(
      getDocumentTextContent('', [
        {} as never,
        { page: 2, text: 'Readable', image: '', is_scanned: false },
      ]),
    ).toBe('Readable')
  })
})
