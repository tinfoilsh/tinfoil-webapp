import { type BaseModel } from '@/config/models'
import { attachmentGetPublic } from '@/services/sync-enclave/sync-api'
import {
  base64ToUint8Array,
  decryptAttachment,
  uint8ArrayToBase64,
} from '@/utils/binary-codec'
import type { ShareableChatData } from '@/utils/compression'
import 'katex/dist/katex.min.css'
import { memo, useEffect, useMemo, useState } from 'react'
import { ensureTimeline } from './ensure-timeline'
import { getRendererRegistry } from './renderers/client'
import type { Attachment, Message } from './types'

type SharedChatViewProps = {
  chatData: ShareableChatData
  isDarkMode: boolean
  model: BaseModel
}

const SharedChatMessage = memo(function SharedChatMessage({
  message,
  messageIndex,
  model,
  isDarkMode,
}: {
  message: Message
  messageIndex: number
  model: BaseModel
  isDarkMode: boolean
}) {
  const normalized = ensureTimeline(message)
  const renderer = getRendererRegistry().getMessageRenderer(normalized, model)
  const RendererComponent = renderer.render

  return (
    <RendererComponent
      message={normalized}
      messageIndex={messageIndex}
      model={model}
      isDarkMode={isDarkMode}
      isLastMessage={false}
      isStreaming={false}
      onEditMessage={undefined}
      onRegenerateMessage={undefined}
    />
  )
})

const getMessageKey = (message: Message, index: number): string => {
  const timestamp =
    message.timestamp instanceof Date
      ? message.timestamp.getTime()
      : message.timestamp
  return `shared-${message.role}-${timestamp}-${index}`
}

export function SharedChatView({
  chatData,
  isDarkMode,
  model,
}: SharedChatViewProps) {
  // Build initial messages with thumbnail placeholders for images
  const initialMessages: Message[] = useMemo(
    () =>
      chatData.messages.map((m) => ({
        role: m.role,
        content: m.content,
        documentContent: m.documentContent,
        documents: m.documents,
        timestamp: new Date(m.timestamp),
        thoughts: m.thoughts,
        thinkingDuration: m.thinkingDuration,
        isError: m.isError,
        attachments: m.attachments?.map(
          (a): Attachment => ({
            ...a,
            // Use thumbnail as initial display image until full-res loads
            base64: a.thumbnailBase64,
          }),
        ),
      })),
    [chatData],
  )

  const [messages, setMessages] = useState<Message[]>(initialMessages)

  // Lazy-load full-resolution images from the public attachment endpoint
  useEffect(() => {
    const apiBaseUrl =
      process.env.NEXT_PUBLIC_API_BASE_URL || 'https://api.tinfoil.sh'

    let cancelled = false

    async function loadFullResImages() {
      const updated = [...initialMessages.map((m) => ({ ...m }))]
      let anyUpdated = false

      const tasks: Promise<void>[] = []

      for (let mi = 0; mi < updated.length; mi++) {
        const atts = updated[mi].attachments
        if (!atts) continue

        for (let ai = 0; ai < atts.length; ai++) {
          const att = atts[ai]
          if (att.type !== 'image' || !att.encryptionKey) continue

          const msgIdx = mi
          const attIdx = ai
          tasks.push(
            (async () => {
              const apply = (base64: string) => {
                if (cancelled) return
                updated[msgIdx] = { ...updated[msgIdx] }
                updated[msgIdx].attachments = [...updated[msgIdx].attachments!]
                updated[msgIdx].attachments![attIdx] = {
                  ...updated[msgIdx].attachments![attIdx],
                  base64,
                }
                anyUpdated = true
              }

              try {
                const plaintext = await attachmentGetPublic({
                  id: att.id,
                  attKeyB64: att.encryptionKey!,
                })
                apply(uint8ArrayToBase64(plaintext))
                return
              } catch {
                // fall through to legacy controlplane BYTEA endpoint
              }

              try {
                const resp = await fetch(
                  `${apiBaseUrl}/api/storage/attachment/${att.id}`,
                )
                if (!resp.ok) return

                const encryptedBuf = await resp.arrayBuffer()
                const keyBytes = base64ToUint8Array(att.encryptionKey!)
                const decrypted = decryptAttachment(
                  new Uint8Array(encryptedBuf),
                  keyBytes,
                )
                apply(uint8ArrayToBase64(await decrypted))
              } catch {
                // Silently skip — thumbnail is still visible
              }
            })(),
          )
        }
      }

      await Promise.all(tasks)
      if (!cancelled && anyUpdated) {
        setMessages(updated)
      }
    }

    loadFullResImages()
    return () => {
      cancelled = true
    }
  }, [initialMessages])

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl px-4 pb-6 pt-8">
      {messages.map((message, index) => (
        <SharedChatMessage
          key={getMessageKey(message, index)}
          message={message}
          messageIndex={index}
          model={model}
          isDarkMode={isDarkMode}
        />
      ))}
    </div>
  )
}
