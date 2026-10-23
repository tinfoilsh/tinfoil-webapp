import { isPlainTextFile } from '@/utils/file-types'
import { describe, expect, it } from 'vitest'

describe('isPlainTextFile', () => {
  it('previews a text file whose extension is upper case', () => {
    expect(isPlainTextFile('README.MD')).toBe(true)
  })

  it.each([
    'photo.png',
    'report.pdf',
    'slides.pptx',
    'archive.zip',
    'notes.txt.exe',
    'Makefile',
    'txt',
  ])('does not preview %s as text', (filename) => {
    expect(isPlainTextFile(filename)).toBe(false)
  })
})
