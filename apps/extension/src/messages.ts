import type { ChatState } from '@tinfoil/chat-client/reducer'
import type {
  BrowserToolRequest,
  HarnessErrorBody,
  Session,
} from '@tinfoil/chat-client/types'
import { z } from 'zod'
import { MAX_PROMPT_CHARS, MAX_RECORDING_CHARS } from './config'
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
    // The browser actions whose picture of the page this device keeps, by
    // the id of the tool call each answered.
    captures: string[]
  }
  pending?: BrowserToolRequest & { preview: string }
  error?: string
}

export type ToPanel =
  | { type: 'state'; view: View }
  | { type: 'token'; id: string; skipCache?: boolean }
  | { type: 'result'; id: string; error?: string }
  // Another panel has taken this one's place with the worker.
  | { type: 'replaced' }
  // A recording's text, or why it has none: in the chat service's own words
  // where it was the one to refuse.
  | { type: 'transcript'; id: string; text: string }
  | {
      type: 'transcript'
      id: string
      error: string
      refusal?: { detail: HarnessErrorBody; status?: number }
    }

// A request the panel waits on, whatever it asks, by the id its answer
// carries.
export const requestEnvelopeSchema = z.object({
  type: z.enum(['command', 'transcribe']),
  id: z.string(),
})

export const toWorkerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('hello'), owner: z.string().min(1).max(200) }),
  z.object({
    type: z.literal('token'),
    id: z.string(),
    // No token when the sign-in has ended, or, as failed says, when it
    // could not be asked about.
    token: z.string().nullable(),
    failed: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('command'),
    id: z.string(),
    command: commandSchema,
  }),
  z.object({
    type: z.literal('transcribe'),
    id: z.string(),
    // The recording, in base64.
    audio: z.string().min(1).max(MAX_RECORDING_CHARS),
    mimeType: z.string().min(1).max(100),
  }),
  // The panel no longer waits for the recording's text.
  z.object({ type: z.literal('cancel'), id: z.string() }),
])
