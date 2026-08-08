import {
  compressToBase64,
  isGzippedData,
  parseShareableChatData,
  safeDecompress,
  type ShareableChatData,
} from '@/utils/compression'
import pako from 'pako'
import { describe, expect, it } from 'vitest'

// Helper to create valid gzipped base64 data
function createGzippedBase64(data: object): string {
  const jsonString = JSON.stringify(data)
  const compressed = pako.gzip(jsonString)
  // Convert Uint8Array to base64
  let binary = ''
  for (let i = 0; i < compressed.length; i++) {
    binary += String.fromCharCode(compressed[i])
  }
  return btoa(binary)
}

// Helper to create valid shareable chat data
function createValidShareableChatData(): ShareableChatData {
  return {
    v: 1,
    title: 'Test Chat',
    messages: [
      {
        role: 'user',
        content: 'Hello',
        timestamp: 1704067200000,
      },
      {
        role: 'assistant',
        content: 'Hi there!',
        timestamp: 1704067201000,
      },
    ],
    createdAt: 1704067200000,
  }
}

describe('compression', () => {
  describe('isGzippedData', () => {
    it('should return true for gzip header prefix', () => {
      expect(isGzippedData('H4sIAAAAAAAA')).toBe(true)
    })

    it('should return false for non-gzip data', () => {
      expect(isGzippedData('eyJmb28iOiJiYXIifQ==')).toBe(false)
    })

    it('should return false for empty string', () => {
      expect(isGzippedData('')).toBe(false)
    })

    it('should return false for non-string input', () => {
      expect(isGzippedData(null as any)).toBe(false)
      expect(isGzippedData(undefined as any)).toBe(false)
      expect(isGzippedData(123 as any)).toBe(false)
    })

    it('should detect actual gzipped content', () => {
      const gzipped = createGzippedBase64({ test: 'data' })
      expect(isGzippedData(gzipped)).toBe(true)
    })
  })

  describe('safeDecompress', () => {
    it('should decompress valid gzipped JSON data', () => {
      const original = { message: 'Hello, World!', count: 42 }
      const gzipped = createGzippedBase64(original)

      const result = safeDecompress(gzipped)
      expect(result).toBe(JSON.stringify(original))
    })

    it('should return null for null input', () => {
      expect(safeDecompress(null as any)).toBeNull()
    })

    it('should return null for undefined input', () => {
      expect(safeDecompress(undefined as any)).toBeNull()
    })

    it('should return null for non-string input', () => {
      expect(safeDecompress(123 as any)).toBeNull()
    })

    it('should return null for non-gzip data (wrong prefix)', () => {
      expect(safeDecompress('eyJmb28iOiJiYXIifQ==')).toBeNull()
    })

    it('should return null for invalid base64', () => {
      expect(safeDecompress('H4sI!!!invalid!!!')).toBeNull()
    })

    it('should return null for truncated gzip data', () => {
      // Valid gzip prefix but truncated
      expect(safeDecompress('H4sI')).toBeNull()
    })

    it('should handle complex nested JSON', () => {
      const complex = {
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
        ],
        metadata: {
          timestamp: '2024-01-01',
          nested: { deep: { value: true } },
        },
      }
      const gzipped = createGzippedBase64(complex)

      const result = safeDecompress(gzipped)
      expect(JSON.parse(result!)).toEqual(complex)
    })

    it('should handle unicode content', () => {
      const unicode = { content: '你好世界 🌍 émojis' }
      const gzipped = createGzippedBase64(unicode)

      const result = safeDecompress(gzipped)
      expect(JSON.parse(result!)).toEqual(unicode)
    })

    it('should return null for decompressed non-JSON content', () => {
      // Create gzipped data that is not valid JSON
      const notJson = 'this is not json'
      const compressed = pako.gzip(notJson)
      let binary = ''
      for (let i = 0; i < compressed.length; i++) {
        binary += String.fromCharCode(compressed[i])
      }
      const gzipped = btoa(binary)

      expect(safeDecompress(gzipped)).toBeNull()
    })
  })

  describe('compressToBase64', () => {
    it('should compress an object to base64 gzipped string', () => {
      const data = { test: 'value', number: 42 }
      const result = compressToBase64(data)

      expect(result).not.toBeNull()
      expect(typeof result).toBe('string')
      expect(isGzippedData(result!)).toBe(true)
    })

    it('should produce decompressable output', () => {
      const original = { message: 'Hello, World!', items: [1, 2, 3] }
      const compressed = compressToBase64(original)

      expect(compressed).not.toBeNull()
      const decompressed = safeDecompress(compressed!)
      expect(decompressed).not.toBeNull()
      expect(JSON.parse(decompressed!)).toEqual(original)
    })

    it('should handle shareable chat data', () => {
      const chatData = createValidShareableChatData()
      const compressed = compressToBase64(chatData)

      expect(compressed).not.toBeNull()
      const decompressed = safeDecompress(compressed!)
      expect(decompressed).not.toBeNull()
      expect(JSON.parse(decompressed!)).toEqual(chatData)
    })

    it('should handle unicode content', () => {
      const unicode = {
        content: '你好世界 🌍 émojis',
        nested: { value: '日本語' },
      }
      const compressed = compressToBase64(unicode)

      expect(compressed).not.toBeNull()
      const decompressed = safeDecompress(compressed!)
      expect(JSON.parse(decompressed!)).toEqual(unicode)
    })

    it('should handle large data', () => {
      const largeContent = 'x'.repeat(100000)
      const largeData = { content: largeContent }
      const compressed = compressToBase64(largeData)

      expect(compressed).not.toBeNull()
      const decompressed = safeDecompress(compressed!)
      expect(JSON.parse(decompressed!)).toEqual(largeData)
    })

    it('should handle empty objects', () => {
      const compressed = compressToBase64({})

      expect(compressed).not.toBeNull()
      const decompressed = safeDecompress(compressed!)
      expect(JSON.parse(decompressed!)).toEqual({})
    })

    it('should handle arrays', () => {
      const arrayData = [1, 2, 3, { nested: true }]
      const compressed = compressToBase64(arrayData)

      expect(compressed).not.toBeNull()
      const decompressed = safeDecompress(compressed!)
      expect(JSON.parse(decompressed!)).toEqual(arrayData)
    })
  })

  describe('parseShareableChatData', () => {
    it('should parse valid shareable chat data', () => {
      const chatData = createValidShareableChatData()
      const jsonString = JSON.stringify(chatData)
      const result = parseShareableChatData(jsonString)

      expect(result).toEqual(chatData)
    })

    it('should return null for invalid version', () => {
      const invalidData = { ...createValidShareableChatData(), v: 2 }
      const jsonString = JSON.stringify(invalidData)

      expect(parseShareableChatData(jsonString)).toBeNull()
    })

    it('should return null for missing version', () => {
      const { v, ...dataWithoutVersion } = createValidShareableChatData()
      const jsonString = JSON.stringify(dataWithoutVersion)

      expect(parseShareableChatData(jsonString)).toBeNull()
    })

    it('should return null for missing title', () => {
      const { title, ...dataWithoutTitle } = createValidShareableChatData()
      const jsonString = JSON.stringify({ ...dataWithoutTitle, v: 1 })

      expect(parseShareableChatData(jsonString)).toBeNull()
    })

    it('should return null for missing messages array', () => {
      const { messages, ...dataWithoutMessages } =
        createValidShareableChatData()
      const jsonString = JSON.stringify({ ...dataWithoutMessages, v: 1 })

      expect(parseShareableChatData(jsonString)).toBeNull()
    })

    it('should return null for missing createdAt', () => {
      const { createdAt, ...dataWithoutCreatedAt } =
        createValidShareableChatData()
      const jsonString = JSON.stringify({ ...dataWithoutCreatedAt, v: 1 })

      expect(parseShareableChatData(jsonString)).toBeNull()
    })

    it('should return null for invalid message role', () => {
      const chatData = createValidShareableChatData()
      chatData.messages[0].role = 'invalid' as any
      const jsonString = JSON.stringify(chatData)

      expect(parseShareableChatData(jsonString)).toBeNull()
    })

    it('should return null for an invalid model display name', () => {
      const data = createValidShareableChatData()
      ;(data.messages[1] as Record<string, unknown>).modelDisplayName = 42

      expect(parseShareableChatData(JSON.stringify(data))).toBeNull()
    })

    it('should return null for missing message content', () => {
      const chatData = createValidShareableChatData()
      delete (chatData.messages[0] as any).content
      const jsonString = JSON.stringify(chatData)

      expect(parseShareableChatData(jsonString)).toBeNull()
    })

    it('should return null for missing message timestamp', () => {
      const chatData = createValidShareableChatData()
      delete (chatData.messages[0] as any).timestamp
      const jsonString = JSON.stringify(chatData)

      expect(parseShareableChatData(jsonString)).toBeNull()
    })

    it('should return null for non-JSON string', () => {
      expect(parseShareableChatData('not valid json')).toBeNull()
    })

    it('should return null for null input', () => {
      expect(parseShareableChatData(null as any)).toBeNull()
    })

    it('should accept optional fields in messages', () => {
      const chatData: ShareableChatData = {
        v: 1,
        title: 'Test',
        messages: [
          {
            role: 'user',
            content: 'Hello',
            timestamp: 1704067200000,
            documentContent: 'Some document',
            documents: [{ name: 'file.txt' }],
          },
          {
            role: 'assistant',
            content: 'Response',
            timestamp: 1704067201000,
            thoughts: 'Thinking about this...',
            thinkingDuration: 5,
            isError: false,
          },
        ],
        createdAt: 1704067200000,
      }
      const jsonString = JSON.stringify(chatData)
      const result = parseShareableChatData(jsonString)

      expect(result).toEqual(chatData)
    })

    it('should handle empty messages array', () => {
      const chatData: ShareableChatData = {
        v: 1,
        title: 'Empty Chat',
        messages: [],
        createdAt: 1704067200000,
      }
      const jsonString = JSON.stringify(chatData)
      const result = parseShareableChatData(jsonString)

      expect(result).toEqual(chatData)
    })
  })

  describe('roundtrip: compress and decompress', () => {
    it('should successfully roundtrip shareable chat data', () => {
      const original = createValidShareableChatData()

      const compressed = compressToBase64(original)
      expect(compressed).not.toBeNull()

      const decompressed = safeDecompress(compressed!)
      expect(decompressed).not.toBeNull()

      const parsed = parseShareableChatData(decompressed!)
      expect(parsed).toEqual(original)
    })

    it('should roundtrip complex chat with all optional fields', () => {
      const original: ShareableChatData = {
        v: 1,
        title: 'Complex Chat with Unicode 你好 🎉',
        messages: [
          {
            role: 'user',
            content:
              'Can you explain this code?\n```typescript\nconst x = 1;\n```',
            timestamp: 1704067200000,
            documentContent:
              'import React from "react";\n\nexport default function App() {}',
            documents: [{ name: 'App.tsx' }, { name: 'index.ts' }],
          },
          {
            role: 'assistant',
            content:
              'Sure! This code imports React and exports a functional component.',
            timestamp: 1704067201000,
            thoughts: 'The user wants an explanation of React code.',
            thinkingDuration: 3,
          },
          {
            role: 'user',
            content: 'Thanks!',
            timestamp: 1704067202000,
          },
          {
            role: 'assistant',
            content: "You're welcome!",
            timestamp: 1704067203000,
            isError: false,
          },
        ],
        createdAt: 1704067200000,
      }

      const compressed = compressToBase64(original)
      expect(compressed).not.toBeNull()

      const decompressed = safeDecompress(compressed!)
      expect(decompressed).not.toBeNull()

      const parsed = parseShareableChatData(decompressed!)
      expect(parsed).toEqual(original)
    })

    it('should achieve compression for repetitive content', () => {
      const repetitiveContent = 'Hello world! '.repeat(1000)
      const chatData: ShareableChatData = {
        v: 1,
        title: 'Repetitive Content Test',
        messages: [
          {
            role: 'user',
            content: repetitiveContent,
            timestamp: 1704067200000,
          },
        ],
        createdAt: 1704067200000,
      }

      const originalSize = JSON.stringify(chatData).length
      const compressed = compressToBase64(chatData)
      expect(compressed).not.toBeNull()

      // Compressed size should be significantly smaller for repetitive content
      // Base64 encoding adds ~33% overhead, but gzip should still compress well
      expect(compressed!.length).toBeLessThan(originalSize)
    })
  })
})
