import type { BaseModel } from '@/config/models'
import { useHarness } from '@/services/harness/provider'
import type { SharedThread } from '@/services/harness/types'
import { messageView } from '@/services/harness/view-model'
import { uint8ArrayToBase64 } from '@/utils/binary-codec'
import { useEffect, useState } from 'react'
import { ImageGalleryProvider } from './image-gallery-context'
import { getRendererRegistry } from './renderers/client'
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
  return (
    <ImageGalleryProvider messages={messages}>
      <div className="mx-auto w-full min-w-0 max-w-3xl px-4 pb-6 pt-8">
        {messages.map((message, index) => {
          const Renderer = getRendererRegistry().getMessageRenderer(
            message,
            model,
          ).render
          return (
            <Renderer
              key={message.id}
              message={message}
              messageIndex={index}
              model={model}
              isDarkMode={isDarkMode}
              hideActions
            />
          )
        })}
      </div>
    </ImageGalleryProvider>
  )
}
