import type { AnswerSaveStatus } from '@/services/harness/question-answers'
import type { AnswerChanges, SavedAnswers } from '@/services/harness/types'
import { createContext } from 'react'

// What the open chat lets its questions widgets do. Without it, as in a
// shared chat, a widget shows its answers and takes none.
export interface QuestionAnswering {
  // The chat takes changes to its answers now: it is open and not running.
  canAnswer: boolean
  // The chat takes the question that sends answers to the model now.
  canSubmit: boolean
  // Each widget's save, by widget call.
  saves: Record<string, AnswerSaveStatus>
  // What the chat's questions last sent the model of each widget's
  // answers, by widget call.
  sent: Record<string, SavedAnswers>
  answer(messageId: string, toolCallId: string, changes: AnswerChanges): void
  // Saves again the answers a save failed to keep.
  retry(): void
  // Sends the model a question of the answers alone.
  submit(): void
}

export const QuestionsContext = createContext<QuestionAnswering | null>(null)
