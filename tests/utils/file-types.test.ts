import { isPlainTextFile } from '@/utils/file-types'
import { describe, expect, it } from 'vitest'

describe('isPlainTextFile', () => {
  it.each([
    'notes.txt',
    'README.MD',
    'main.py',
    'component.tsx',
    'config.yaml',
    'statement.qfx',
    'contacts.vcf',
    'archive.tar.patch',
  ])('previews %s as text', (filename) => {
    expect(isPlainTextFile(filename)).toBe(true)
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
