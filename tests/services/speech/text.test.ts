import { SPEECH } from '@/services/speech/constants'
import { prepareSpeechText, splitSpeechText } from '@/services/speech/text'
import { describe, expect, it } from 'vitest'

describe('speech text', () => {
  it('reads prose and labels without code blocks, citations, or markup', () => {
    expect(
      prepareSpeechText(
        '# Hello **world**\n\nRead [this guide](https://example.com) [1](https://source.com).\n\n```js\nsecretCode()\n```\n\nUse `settings`.',
      ),
    ).toBe('Hello world\nRead this guide .\nUse settings.')
  })

  it('preserves list items, table cells, inline math, and Unicode', () => {
    expect(
      prepareSpeechText(
        '- Café &amp; tea\n- 日本語\n\n| Name | Count |\n| --- | --- |\n| Apples | 3 |\n\n$x + y$',
      ),
    ).toBe('Café & tea\n日本語\nName\nCount\nApples\n3\nx + y')
  })

  it('does not read footnote definitions, images, or automatic URLs', () => {
    expect(
      prepareSpeechText(
        'Answer[^1]. ![picture](https://image.com) https://example.com\n\n[^1]: Citation details',
      ),
    ).toBe('Answer.')
  })

  it('has no speech for an empty or code-only response', () => {
    expect(splitSpeechText(prepareSpeechText('```js\nexample()\n```'))).toEqual(
      [],
    )
    expect(splitSpeechText('   ')).toEqual([])
  })

  it('rejects oversized input instead of silently truncating', () => {
    expect(() =>
      prepareSpeechText('x'.repeat(SPEECH.MAX_TEXT_CHARACTERS + 1)),
    ).toThrow('too-long')
  })

  it('groups sentences without losing or duplicating words', () => {
    const text = Array.from(
      { length: 30 },
      (_, i) =>
        `Sentence ${i} is a complete thought with enough words for natural narration.`,
    ).join(' ')
    const chunks = splitSpeechText(text)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.join(' ')).toBe(text)
    for (const chunk of chunks) {
      expect(Array.from(chunk).length).toBeLessThanOrEqual(
        SPEECH.MAX_CHUNK_CHARACTERS,
      )
      expect(chunk.endsWith('.')).toBe(true)
    }
  })

  it('splits oversized sentences and unbroken Unicode without broken surrogates', () => {
    const text = '🙂'.repeat(SPEECH.MAX_CHUNK_CHARACTERS * 2 + 1)
    const chunks = splitSpeechText(text)
    expect(chunks.join('')).toBe(text)
    expect(chunks).toHaveLength(3)
    expect(
      chunks.every(
        (chunk) => Array.from(chunk).length <= SPEECH.MAX_CHUNK_CHARACTERS,
      ),
    ).toBe(true)
  })

  it('preserves an oversized sentence split on word boundaries', () => {
    const text = `${'hello '.repeat(250)}world.`
    expect(splitSpeechText(text).join(' ')).toBe(text)
  })
})
