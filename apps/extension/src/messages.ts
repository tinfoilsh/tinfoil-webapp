import type { ChatState } from '@tinfoil/chat-client/reducer'
import type { BrowserToolRequest, Session } from '@tinfoil/chat-client/types'
import { z } from 'zod'
import { MAX_PROMPT_CHARS } from './config'
import type { TaskPhase } from './storage'

export const commandSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('send'),
    content: z.string().trim().min(1).max(MAX_PROMPT_CHARS),
    model: z.string().max(100),
    effort: z.enum(['low', 'medium', 'high']),
    autoIntelligence: z.string().max(100).optional(),
  }),
  z.object({ kind: z.literal('resume') }),
  z.object({ kind: z.literal('stop') }),
  z.object({
    kind: z.literal('review'),
    executionId: z.string(),
    allow: z.boolean(),
  }),
  z.object({ kind: z.literal('select'), id: z.string() }),
  z.object({ kind: z.literal('new') }),
  z.object({ kind: z.literal('delete'), id: z.string() }),
])
export type Command = z.infer<typeof commandSchema>

export interface View {
  session?: Session
  verified: boolean
  tasks: { id: string; title: string; updatedAt: number }[]
  task?: {
    id: string
    title: string
    state: ChatState
    phase: TaskPhase
    model: string
    effort: 'low' | 'medium' | 'high'
    autoIntelligence?: string
    error?: string
  }
  pending?: BrowserToolRequest & { preview: string }
  error?: string
}

export type ToPanel =
  | { type: 'state'; view: View }
  | { type: 'token'; id: string; skipCache?: boolean }
  | { type: 'result'; id: string; error?: string }

export const toWorkerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('hello'), owner: z.string().min(1).max(200) }),
  z.object({
    type: z.literal('token'),
    id: z.string(),
    token: z.string().nullable(),
  }),
  z.object({
    type: z.literal('command'),
    id: z.string(),
    command: commandSchema,
  }),
])
