import type { BaseModel } from '@/config/models'
import { ERROR_ACTIONS, ERROR_CODES } from '@/services/harness/protocol'
import { sharedAttachment } from '@/services/harness/shares'
import { speakText } from '@/services/harness/speech'
import { HarnessError } from '@/services/harness/sse'
import type { SharedThread } from '@/services/harness/types'
import { messageView, shownMessages } from '@/services/harness/view-model'
import { uint8ArrayToBase64 } from '@/utils/binary-codec'
import { useCallback, useEffect, useState } from 'react'
import { DocumentTextProvider } from './document-text-context'
import { ImageGalleryProvider } from './image-gallery-context'
import { MessageRendererHost } from './message-renderer-host'
import { SpeechProvider } from './speech-context'
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
  const [messages, setMessages] = useState(() =>
    shownMessages(chatData.messages).map((m) => messageView(m)),
  )
  useEffect(() => {
    const abort = new AbortController()
    const shown = shownMessages(chatData.messages)
    setMessages(shown.map((m) => messageView(m)))
    for (const message of shown)
      for (const attachment of message.attachments ?? []) {
        if (attachment.kind !== 'image' || !attachment.attKey) continue
        void sharedAttachment(attachment.id, attachment.attKey, abort.signal)
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
  }, [chatData])
  // A shared stored document holds its text in its blob, which the harness
  // reads as text with the share's attachment key.
  const loadDocumentText = useCallback(
    async (attachment: Attachment) => {
      const attKey = chatData.messages
        .flatMap((message) => message.attachments ?? [])
        .find((candidate) => candidate.id === attachment.id)?.attKey
      if (!attKey)
        throw new HarnessError({
          code: ERROR_CODES.threadNotFound,
          action: ERROR_ACTIONS.stop,
          message: 'This document is not part of the share.',
        })
      return (await sharedAttachment(attachment.id, attKey)).text()
    },
    [chatData],
  )
  // The harness reads a shared message's text, as it reads text a user
  // selected.
  const speak = useCallback(
    (messageId: string, signal: AbortSignal) =>
      speakText(
        messages.find((message) => message.id === messageId)?.content ?? '',
        signal,
      ),
    [messages],
  )
  return (
    <ImageGalleryProvider messages={messages}>
      <DocumentTextProvider load={loadDocumentText}>
        <SpeechProvider speak={speak}>
          <div className="mx-auto w-full min-w-0 max-w-3xl px-4 pb-6 pt-8">
            {messages.map((message, index) => (
              <MessageRendererHost
                key={message.id}
                message={message}
                messageIndex={index}
                model={model}
                isDarkMode={isDarkMode}
              />
            ))}
          </div>
        </SpeechProvider>
      </DocumentTextProvider>
    </ImageGalleryProvider>
  )
}
