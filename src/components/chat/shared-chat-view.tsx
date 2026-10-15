import type { BaseModel } from '@/config/models'
import { useHarness } from '@/services/harness/provider'
import { HarnessError } from '@/services/harness/sse'
import type { SharedThread } from '@/services/harness/types'
import { messageView } from '@/services/harness/view-model'
import { uint8ArrayToBase64 } from '@/utils/binary-codec'
import { useCallback, useEffect, useState } from 'react'
import { DocumentTextProvider } from './document-text-context'
import { ImageGalleryProvider } from './image-gallery-context'
import { MessageRendererHost } from './message-renderer-host'
import type { Attachment } from './types'
export function SharedChatView({
  chatData,
  isDarkMode,
  model,
}: {
  chatData: SharedThread
  isDarkMode: boolean
  model: BaseModel
}) {
  const { api } = useHarness()
  const [messages, setMessages] = useState(() =>
    chatData.messages.map((m) => messageView(m)),
  )
  useEffect(() => {
    const abort = new AbortController()
    setMessages(chatData.messages.map((m) => messageView(m)))
    for (const message of chatData.messages)
      for (const attachment of message.attachments ?? []) {
        if (attachment.kind !== 'image' || !attachment.attKey) continue
        void api.client
          .download(
            '/v1/attachments/get-public',
            { id: attachment.id, attKey: attachment.attKey },
            api.signal(abort.signal),
          )
          .then((blob) => blob.arrayBuffer())
          .then((bytes) => {
            if (!abort.signal.aborted)
              setMessages((previous) =>
                previous.map((m) =>
                  m.id !== message.id
                    ? m
                    : {
                        ...m,
                        attachments: m.attachments?.map((a) =>
                          a.id !== attachment.id
                            ? a
                            : {
                                ...a,
                                base64: uint8ArrayToBase64(
                                  new Uint8Array(bytes),
                                ),
                              },
                        ),
                      },
                ),
              )
          })
          .catch(() => {
            /* retain the thumbnail when the full image is unavailable */
          })
      }
    return () => abort.abort()
  }, [api, chatData])
  // A shared stored document holds its text in its blob, which the harness
  // reads as text with the share's attachment key.
  const loadDocumentText = useCallback(
    async (attachment: Attachment) => {
      const attKey = chatData.messages
        .flatMap((message) => message.attachments ?? [])
        .find((candidate) => candidate.id === attachment.id)?.attKey
      if (!attKey)
        throw new HarnessError({
          code: 'THREAD_NOT_FOUND',
          message: 'This document is not part of the share.',
        })
      const blob = await api.client.download(
        '/v1/attachments/get-public',
        { id: attachment.id, attKey },
        api.signal(undefined, false),
      )
      return blob.text()
    },
    [api, chatData],
  )
  return (
    <ImageGalleryProvider messages={messages}>
      <DocumentTextProvider load={loadDocumentText}>
        <div className="mx-auto w-full min-w-0 max-w-3xl px-4 pb-6 pt-8">
          {messages.map((message, index) => (
            <MessageRendererHost
              key={message.id}
              message={message}
              messageIndex={index}
              model={model}
              isDarkMode={isDarkMode}
              hideActions
            />
          ))}
        </div>
      </DocumentTextProvider>
    </ImageGalleryProvider>
  )
}
