import { getFileIconType, hasImageExtension } from '@/utils/file-types'
import { describe, expect, it } from 'vitest'

describe('file-types', () => {
  describe('hasImageExtension', () => {
    it.each([
      'photo.jpg',
      'photo.jpeg',
      'image.png',
      'animation.gif',
      'modern.webp',
      'old.bmp',
      'scan.tiff',
      'scan.tif',
      'PHOTO.JPG',
      'Photo.PNG',
      'IMAGE.Jpeg',
    ])('should return true for %s', (filename) => {
      expect(hasImageExtension(filename)).toBe(true)
    })

    it.each([
      'document.pdf',
      'text.txt',
      'code.ts',
      'data.json',
      'noextension',
      'fake.jpgx',
    ])('should return false for %s', (filename) => {
      expect(hasImageExtension(filename)).toBe(false)
    })
  })

  describe('getFileIconType', () => {
    describe('document types', () => {
      it.each([
        ['document.pdf', 'pdf'],
        ['file.docx', 'docx'],
        ['slides.pptx', 'pptx'],
        ['data.xlsx', 'xlsx'],
        ['data.csv', 'csv'],
      ])('should return %s for %s', (filename, expected) => {
        expect(getFileIconType(filename)).toBe(expected)
      })
    })

    describe('image types', () => {
      it.each(['photo.jpg', 'image.png', 'animation.gif'])(
        'should return "image" for %s',
        (filename) => {
          expect(getFileIconType(filename)).toBe('image')
        },
      )
    })

    describe('media types', () => {
      it.each([
        ['song.mp3', 'audio'],
        ['sound.wav', 'audio'],
        ['music.ogg', 'audio'],
        ['movie.mp4', 'video'],
        ['clip.mov', 'video'],
        ['film.avi', 'video'],
      ])('should return %s for %s', (filename, expected) => {
        expect(getFileIconType(filename)).toBe(expected)
      })
    })

    describe('archive types', () => {
      it.each(['archive.zip', 'archive.rar', 'archive.tar'])(
        'should return "zip" for %s',
        (filename) => {
          expect(getFileIconType(filename)).toBe('zip')
        },
      )
    })

    describe('code types', () => {
      it.each([
        ['page.html', 'html'],
        ['page.htm', 'html'],
        ['script.js', 'js'],
        ['component.jsx', 'js'],
        ['module.ts', 'ts'],
        ['component.tsx', 'ts'],
        ['styles.css', 'css'],
        ['readme.md', 'md'],
        ['notes.txt', 'txt'],
      ])('should return %s for %s', (filename, expected) => {
        expect(getFileIconType(filename)).toBe(expected)
      })
    })

    it('should return "file" for unknown extensions', () => {
      expect(getFileIconType('unknown.xyz')).toBe('file')
      expect(getFileIconType('noextension')).toBe('file')
    })
  })
})
