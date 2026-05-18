import type { Attachment, Message } from '@/components/chat/types'
import type { BaseModel } from '@/config/models'
import { ChatQueryBuilder } from '@/services/inference/chat-query-builder'
import { describe, expect, it } from 'vitest'

const baseTextModel: BaseModel = {
  modelName: 'llama3-3-70b',
  image: '',
  name: 'Llama',
  nameShort: 'Llama',
  description: '',
  type: 'chat',
  multimodal: false,
}

const baseMultimodalModel: BaseModel = {
  ...baseTextModel,
  modelName: 'qwen2-5-72b',
  multimodal: true,
}

function userMessage(content: string, attachments: Attachment[]): Message {
  return {
    role: 'user',
    content,
    attachments,
    timestamp: new Date(0),
  }
}

function build(model: BaseModel, msg: Message) {
  return ChatQueryBuilder.buildMessages({
    model,
    systemPrompt: '',
    messages: [msg],
    maxMessages: 10,
  })
}

describe('chat-query-builder /user-uploads inline notes', () => {
  describe('text-only document', () => {
    const baseDoc: Attachment = {
      id: 'a1',
      type: 'document',
      fileName: 'report.pdf',
      textContent: 'doc body',
    }

    it('omits the path line when the file was not uploaded to buckets', () => {
      const msgs = build(baseTextModel, userMessage('hi', [baseDoc]))
      const userMsg = msgs[msgs.length - 1].content as string
      expect(userMsg).toContain('Document title: report.pdf')
      expect(userMsg).not.toContain('/user-uploads')
    })

    it('inserts the path line between title and contents when fileAccessToken is set', () => {
      const msgs = build(
        baseTextModel,
        userMessage('hi', [
          { ...baseDoc, fileAccessToken: 'fat-1', sha256: 'abc' },
        ]),
      )
      const userMsg = msgs[msgs.length - 1].content as string
      expect(userMsg).toContain(
        'Document title: report.pdf\nAvailable in code execution environment at: /user-uploads/report.pdf\nDocument contents:\ndoc body',
      )
    })
  })

  describe('multimodal paged document', () => {
    const pagedDoc: Attachment = {
      id: 'a2',
      type: 'document',
      fileName: 'scan.pdf',
      pages: [{ page: 1, text: 'p1', image: '', is_scanned: false }],
    }

    it('omits the hint when fileAccessToken is missing', () => {
      const msgs = build(baseMultimodalModel, userMessage('hi', [pagedDoc]))
      const blocks = msgs[msgs.length - 1].content as Array<{
        type: string
        text?: string
      }>
      const header = blocks.find((b) => b.text?.startsWith('[Attached file:'))
      expect(header?.text).toBe('[Attached file: scan.pdf]')
    })

    it('appends the hint inline when fileAccessToken is set', () => {
      const msgs = build(
        baseMultimodalModel,
        userMessage('hi', [
          { ...pagedDoc, fileAccessToken: 'fat-2', sha256: 'def' },
        ]),
      )
      const blocks = msgs[msgs.length - 1].content as Array<{
        type: string
        text?: string
      }>
      const header = blocks.find((b) => b.text?.startsWith('[Attached file:'))
      expect(header?.text).toBe(
        '[Attached file: scan.pdf — also available at /user-uploads/scan.pdf in the code execution environment]',
      )
    })
  })

  describe('multimodal image', () => {
    const img: Attachment = {
      id: 'a3',
      type: 'image',
      fileName: 'pic.png',
      mimeType: 'image/png',
      base64: 'AAA',
    }

    it('omits the labelling text block when fileAccessToken is missing', () => {
      const msgs = build(baseMultimodalModel, userMessage('hi', [img]))
      const blocks = msgs[msgs.length - 1].content as Array<{
        type: string
        text?: string
      }>
      const labelBlock = blocks.find((b) => b.text?.startsWith('[Image:'))
      expect(labelBlock).toBeUndefined()
    })

    it('emits a label block before the image when fileAccessToken is set', () => {
      const msgs = build(
        baseMultimodalModel,
        userMessage('hi', [
          { ...img, fileAccessToken: 'fat-3', sha256: 'ghi' },
        ]),
      )
      const blocks = msgs[msgs.length - 1].content as Array<{
        type: string
        text?: string
        image_url?: { url: string }
      }>
      const labelIdx = blocks.findIndex((b) => b.text?.startsWith('[Image:'))
      const imageIdx = blocks.findIndex((b) => b.image_url)
      expect(labelIdx).toBeGreaterThanOrEqual(0)
      expect(imageIdx).toBeGreaterThan(labelIdx)
      expect(blocks[labelIdx].text).toBe(
        '[Image: pic.png — also available at /user-uploads/pic.png in the code execution environment]',
      )
    })
  })

  describe('non-multimodal image with description', () => {
    const img: Attachment = {
      id: 'a4',
      type: 'image',
      fileName: 'pic.png',
      mimeType: 'image/png',
      base64: 'AAA',
      description: 'a picture',
    }

    it('omits the hint when fileAccessToken is missing', () => {
      const msgs = build(baseTextModel, userMessage('hi', [img]))
      const userMsg = msgs[msgs.length - 1].content as string
      expect(userMsg).toContain('Image: pic.png\nDescription:\na picture')
    })

    it('appends the hint inline when fileAccessToken is set', () => {
      const msgs = build(
        baseTextModel,
        userMessage('hi', [
          { ...img, fileAccessToken: 'fat-4', sha256: 'jkl' },
        ]),
      )
      const userMsg = msgs[msgs.length - 1].content as string
      expect(userMsg).toContain(
        'Image: pic.png — also available at /user-uploads/pic.png in the code execution environment\nDescription:\na picture',
      )
    })
  })
})
