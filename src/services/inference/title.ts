import { CONSTANTS } from '@/components/chat/constants'
import type { Message } from '@/components/chat/types'
import { DEFAULT_CHAT_TITLE } from '@/constants/chat'
import { logError } from '@/utils/error-handling'
import { TITLE_SOURCE_MAX_CHARACTERS } from './constants'
import { summarize } from './summary-client'

function boundedText(value: string | undefined, maxCharacters: number): string {
  return value?.slice(0, maxCharacters).trim() ?? ''
}

export function getTitleContent(
  message: Pick<Message, 'content' | 'attachments'>,
): string {
  const content = boundedText(message.content, TITLE_SOURCE_MAX_CHARACTERS)
  if (content) return content

  const attachmentParts: string[] = []
  let remainingCharacters = TITLE_SOURCE_MAX_CHARACTERS
  for (const attachment of message.attachments ?? []) {
    if (remainingCharacters === 0) break
    const attachmentContent =
      boundedText(attachment.textContent, remainingCharacters) ||
      boundedText(attachment.description, remainingCharacters) ||
      boundedText(attachment.fileName, remainingCharacters)
    if (!attachmentContent) continue
    attachmentParts.push(attachmentContent)
    remainingCharacters -= attachmentContent.length
  }

  return attachmentParts.join('\n').slice(0, TITLE_SOURCE_MAX_CHARACTERS)
}

export async function generateTitle(
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  if (!messages || messages.length === 0) return DEFAULT_CHAT_TITLE

  try {
    const userMessage = messages.find((msg) => msg.role === 'user')
    if (!userMessage?.content) return DEFAULT_CHAT_TITLE

    const words = userMessage.content
      .slice(0, TITLE_SOURCE_MAX_CHARACTERS)
      .split(/\s+/)
    const truncatedContent = words
      .slice(0, CONSTANTS.TITLE_GENERATION_WORD_THRESHOLD)
      .join(' ')

    const title = await summarize({
      content: truncatedContent,
      style: 'title_summary',
    })

    const cleanTitle = title.replace(/^["']|["']$/g, '').trim()
    if (cleanTitle && cleanTitle.length > 0 && cleanTitle.length <= 50) {
      return cleanTitle
    }
    return DEFAULT_CHAT_TITLE
  } catch (error) {
    logError('Failed to generate title', error, {
      component: 'title',
      action: 'generateTitle',
    })
    return DEFAULT_CHAT_TITLE
  }
}
