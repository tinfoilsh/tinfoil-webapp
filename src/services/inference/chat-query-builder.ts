import {
  getMessageDocuments,
  getMessageImages,
} from '@/components/chat/attachment-helpers'
import { buildGenUIPromptHint } from '@/components/chat/genui/system-prompt'
import type { Message } from '@/components/chat/types'
import {
  getReasoningHistoryPolicy,
  getResolvedModelContextWindowTokens,
  type BaseModel,
} from '@/config/models'
import { shouldIncludeReasoning } from '@/utils/reasoning-history'
import { formatCurrentTimeReminder } from '@/utils/time-reminder'
import { selectMessagesWithinBudget } from '@/utils/token-estimation'
import { webSearchHistoryMessages } from '@/utils/web-search-history'
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionSystemMessageParam,
  ChatCompletionToolMessageParam,
  ChatCompletionUserMessageParam,
} from 'openai/resources/chat/completions'

/**
 * Helper for building chat completion queries. The system prompt is always
 * sent with the `system` role; every hosted chat model supports it.
 */

export interface ChatQueryBuilderParams {
  model: BaseModel
  systemPrompt: string
  rules?: string
  messages: Message[]
  autoCandidates?: BaseModel[]
  /**
   * Append GenUI widget guidance to the system prompt. Defaults to `false`
   * so non-chat callers (title gen, memory) stay unaffected.
   */
  includeGenUIHint?: boolean
  /**
   * Append an ephemeral current-time reminder as the final message. The
   * reminder is built at request time and never persisted, keeping the
   * system prompt and history byte-stable so prefix caching works.
   * Defaults to `false` so internal utilities (title gen, memory) stay
   * unaffected.
   */
  includeTimeReminder?: boolean
}

export class ChatQueryBuilder {
  /**
   * Build chat completion messages with model-appropriate system prompt and rules injection
   */
  static buildMessages(
    params: ChatQueryBuilderParams,
  ): ChatCompletionMessageParam[] {
    const {
      model,
      systemPrompt,
      rules,
      messages: conversationMessages,
      autoCandidates,
      includeGenUIHint,
      includeTimeReminder,
    } = params
    const reasoningHistoryPolicy = getReasoningHistoryPolicy({
      model,
      autoCandidates,
    })
    const contextWindowTokens = getResolvedModelContextWindowTokens({
      model,
      autoCandidates,
    })

    const genUIHint = includeGenUIHint ? buildGenUIPromptHint() : null

    const processedSystemPrompt = systemPrompt.replaceAll(
      '{MODEL_NAME}',
      model.name,
    )
    const processedRules = rules
      ? rules.replaceAll('{MODEL_NAME}', model.name)
      : ''

    const result: ChatCompletionMessageParam[] = []

    const systemContent = this.buildSystemContent(
      processedSystemPrompt,
      processedRules,
      genUIHint,
    )
    if (systemContent) {
      result.push({
        role: 'system',
        content: systemContent,
      } as ChatCompletionSystemMessageParam)
    }

    // Add conversation history that fits within the model's context budget
    const recentMessages = selectMessagesWithinBudget(
      conversationMessages,
      contextWindowTokens,
      { reasoningHistoryPolicy },
    )

    for (let index = 0; index < recentMessages.length; index++) {
      const msg = recentMessages[index]
      result.push(...webSearchHistoryMessages(msg, index))
      const includeReasoning = shouldIncludeReasoning(
        reasoningHistoryPolicy,
        Boolean(msg.toolCalls?.length),
      )

      if (msg.role === 'user') {
        result.push({
          role: 'user',
          content: this.buildUserContent(msg, model.multimodal),
        } as ChatCompletionUserMessageParam)
      } else if (
        msg.content ||
        (msg.toolCalls && msg.toolCalls.length > 0) ||
        (includeReasoning && msg.thoughts !== undefined)
      ) {
        // Assistant messages - include annotations and searchReasoning for multi-turn context
        const assistantParam: ChatCompletionAssistantMessageParam & {
          annotations?: Message['annotations']
          search_reasoning?: string
          reasoning_content?: string
        } = {
          role: 'assistant',
          content: msg.content || '',
        }
        if (msg.annotations && msg.annotations.length > 0) {
          assistantParam.annotations = msg.annotations
        }
        if (msg.searchReasoning) {
          assistantParam.search_reasoning = msg.searchReasoning
        }
        if (includeReasoning && msg.thoughts !== undefined) {
          assistantParam.reasoning_content = msg.thoughts
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          assistantParam.tool_calls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: tc.arguments || '{}',
            },
          }))
        }
        result.push(assistantParam)

        // Emit synthetic tool results so the model's next turn sees a
        // consistent history. GenUI tools auto-continue: the UI rendered
        // the component on the client, so we just acknowledge.
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            result.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: 'executed',
            } as ChatCompletionToolMessageParam)
          }
        }
      }
    }

    if (includeTimeReminder) {
      result.push({
        role: 'user',
        content: formatCurrentTimeReminder(),
      } as ChatCompletionUserMessageParam)
    }

    return result
  }

  private static buildSystemContent(
    systemPrompt: string,
    rules: string,
    genUIHint: string | null,
  ): string | null {
    const base = rules ? `${systemPrompt}\n${rules}` : systemPrompt
    const content = genUIHint ? `${base}\n\n${genUIHint}` : base
    return content.trim() ? content : null
  }

  /**
   * Build user content including document and image data if applicable.
   * Handles both new attachment format and legacy fields.
   */
  private static buildUserContent(
    msg: Message,
    multimodal?: boolean,
  ):
    | string
    | Array<{ type: string; text?: string; image_url?: { url: string } }> {
    let textContent = msg.content

    // Prepend the quoted reference so the model knows what the user is replying to.
    if (msg.quote) {
      const quoted = msg.quote
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
      textContent = textContent
        ? `In reply to:\n${quoted}\n\n${textContent}`
        : `In reply to:\n${quoted}`
    }

    // Derive document content from attachments (or legacy fields via helpers)
    const docAttachments = getMessageDocuments(msg)
    const pagedDocs = multimodal
      ? docAttachments.filter((a) => a.pages && a.pages.length > 0)
      : []
    const textOnlyDocs = docAttachments.filter((a) => !pagedDocs.includes(a))

    if (textOnlyDocs.length > 0) {
      const docContent = textOnlyDocs
        .filter((a) => a.textContent)
        .map(
          (a) =>
            `Document title: ${a.fileName}\nDocument contents:\n${a.textContent}`,
        )
        .join('\n\n')
      if (docContent) {
        textContent = `---\nDocument content:\n${docContent}\n---\n\n${textContent}`
      }
    }

    // Derive image data from attachments (or legacy fields via helpers)
    const imageAttachments = getMessageImages(msg)

    if (multimodal && (imageAttachments.length > 0 || pagedDocs.length > 0)) {
      const content: Array<{
        type: string
        text?: string
        image_url?: { url: string }
      }> = []

      for (const doc of pagedDocs) {
        content.push({
          type: 'text',
          text: `[Attached file: ${doc.fileName}]`,
        })
        for (const p of doc.pages!) {
          const label = p.is_scanned
            ? `Page ${p.page} (scanned):`
            : `Page ${p.page}:`
          content.push({
            type: 'text',
            text: p.text ? `${label}\n${p.text}` : label,
          })
          if (p.image) {
            content.push({
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${p.image}` },
            })
          }
        }
      }

      content.push({ type: 'text', text: textContent })

      for (const img of imageAttachments) {
        if (img.base64 && img.mimeType) {
          content.push({
            type: 'image_url',
            image_url: {
              url: `data:${img.mimeType};base64,${img.base64}`,
            },
          })
        }
      }

      return content
    }

    // Non-multimodal fallback: append image descriptions as text
    if (imageAttachments.length > 0 && !multimodal) {
      const descriptions = imageAttachments
        .filter((a) => a.description)
        .map((a) => `Image: ${a.fileName}\nDescription:\n${a.description}`)
        .join('\n\n')
      if (descriptions) {
        textContent = `${textContent}\n\n[Treat these descriptions as if they are the raw images.]\n${descriptions}`
      }
    }

    return textContent
  }
}
