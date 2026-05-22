/**
 * Tests that the chat-query builder hides computer-use UI scaffolding from
 * the model. Two kinds of message must NEVER round-trip to inference:
 *
 *   - The inline consent prompt (`computerUseProposedManifest`) — a UI
 *     artifact the model never produced.
 *   - The session-record audit trail (`computerUseFrames` + empty content)
 *     — the model already saw every frame in the loop; the record is for
 *     the user's chat history, not the model's context.
 *
 * The companion final-answer message (no frames, has content) DOES round-trip:
 * it IS the model's last turn and should be visible on follow-up turns.
 */
import type { Message } from '@/components/chat/types'
import type { BaseModel } from '@/config/models'
import type { CapabilityManifest } from '@/services/computer-use'
import { ChatQueryBuilder } from '@/services/inference/chat-query-builder'
import { describe, expect, it } from 'vitest'

const model = {
  modelName: 'kimi-k2-6',
  name: 'Kimi K2.6',
  multimodal: true,
} as unknown as BaseModel

const ts = new Date('2026-05-22T00:00:00Z')

const manifest: CapabilityManifest = {
  version: 1,
  session: { os: 'mac', image: 'tahoe', clone: true },
}

function userMsg(content: string): Message {
  return { role: 'user', content, timestamp: ts }
}
function assistantMsg(over: Partial<Message>): Message {
  return { role: 'assistant', content: '', timestamp: ts, ...over }
}

describe('ChatQueryBuilder filters computer-use artifacts', () => {
  it('drops messages with a proposed manifest (inline consent prompt)', () => {
    const out = ChatQueryBuilder.buildMessages({
      model,
      systemPrompt: 'you are helpful',
      messages: [
        userMsg('research X'),
        assistantMsg({
          computerUseProposedManifest: manifest,
          computerUseTaskReason: 'I need a sandbox',
          computerUseConsentStatus: 'pending',
        }),
        userMsg('approved'),
      ],
      maxMessages: 10,
    })
    // system + user + user — no assistant in the middle.
    const roles = out.map((m) => m.role)
    expect(roles).toEqual(['system', 'user', 'user'])
  })

  it('drops the session-record audit trail (frames + empty content)', () => {
    const out = ChatQueryBuilder.buildMessages({
      model,
      systemPrompt: 'you are helpful',
      messages: [
        userMsg('research X'),
        assistantMsg({
          content: '',
          computerUseFrames: [
            {
              type: 'model_message',
              content: 'opening Safari',
              reasoning: '',
              toolCalls: [],
            },
          ],
          computerUseManifest: manifest,
        }),
        // The final-answer message a sibling commit creates.
        assistantMsg({ content: 'top post is X' }),
      ],
      maxMessages: 10,
    })
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant'])
    expect(out[2].content).toBe('top post is X')
  })

  it('keeps the final-answer message even when frames record sits before it', () => {
    const out = ChatQueryBuilder.buildMessages({
      model,
      systemPrompt: 'helpful',
      messages: [
        userMsg('q'),
        assistantMsg({
          content: '',
          computerUseFrames: [
            {
              type: 'begin',
              session: 's',
              screenshot: { content: [] },
            },
          ],
        }),
        assistantMsg({ content: 'done' }),
        userMsg('follow-up'),
      ],
      maxMessages: 10,
    })
    // The record is filtered, the final-answer and follow-up survive.
    expect(out.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ])
    expect(out.filter((m) => m.role === 'assistant')[0].content).toBe('done')
  })

  it('approved consent record (no proposed manifest) still gets filtered if it carries one', () => {
    // After approval the manifest moves from `computerUseProposedManifest` to
    // `computerUseManifest` and the proposed field is cleared. That record
    // has empty content + no frames + no proposed manifest, so the current
    // builder skips it anyway (assistant messages with no content + no
    // toolCalls are skipped). Verify by inspection.
    const out = ChatQueryBuilder.buildMessages({
      model,
      systemPrompt: 'helpful',
      messages: [
        userMsg('q'),
        assistantMsg({
          content: '',
          computerUseConsentStatus: 'approved',
          computerUseManifest: manifest,
        }),
        userMsg('continue'),
      ],
      maxMessages: 10,
    })
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'user'])
  })
})
