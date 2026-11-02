import { createStore, type Store } from './store'
import type {
  AnswerChanges,
  Message,
  SavedAnswers,
  WidgetAnswers,
} from './types'

// What a questions widget shows of its answers while they save.
export type AnswerSaveStatus = 'saving' | 'failed'

// A save of one questions widget's answers, through its chat's store.
export type SaveAnswers = (
  messageId: string,
  toolCallId: string,
  changes: AnswerChanges,
) => Promise<void>

interface Unsent {
  messageId: string
  changes: AnswerChanges
}

// A widget's answers with changes applied: a question changed to null is
// unanswered.
export function changedAnswers(
  answers: SavedAnswers | undefined,
  changes: AnswerChanges,
): SavedAnswers | undefined {
  const next: SavedAnswers = { ...answers }
  for (const [questionId, picked] of Object.entries(changes)) {
    if (picked) next[questionId] = picked
    else delete next[questionId]
  }
  return Object.keys(next).length ? next : undefined
}

// The messages with changes applied to the answers of a questions widget's
// call in one of them.
export function withAnswers(
  messages: Message[],
  messageId: string,
  toolCallId: string,
  changes: AnswerChanges,
): Message[] {
  return messages.map((message) =>
    message.id !== messageId
      ? message
      : {
          ...message,
          timeline: message.timeline?.map((block) => {
            if ((block.toolCallId ?? block.id) !== toolCallId) return block
            const { answers: _answers, ...rest } = block
            const answers = changedAnswers(block.answers, changes)
            return answers ? { ...rest, answers } : rest
          }),
        },
  )
}

// The options a question sent the model of each widget's answered
// questions, by widget call: the latest the messages hold.
export function sentAnswers(
  messages: readonly Pick<Message, 'answers'>[],
): Record<string, SavedAnswers> {
  const sent: Record<string, SavedAnswers> = {}
  for (const message of messages)
    for (const widget of message.answers ?? [])
      sent[widget.toolCallId] = picksOf(widget)
  return sent
}

function picksOf(widget: WidgetAnswers): SavedAnswers {
  return Object.fromEntries(
    widget.questions
      .filter((question) => question.answered)
      .map((question) => [
        question.id,
        question.selected.map((option) => option.id),
      ]),
  )
}

// Whether two sets of answers pick the same options for the same questions.
export function sameAnswers(
  a: SavedAnswers | undefined,
  b: SavedAnswers | undefined,
): boolean {
  const left = Object.entries(a ?? {})
  if (left.length !== Object.keys(b ?? {}).length) return false
  return left.every(([questionId, picked]) => {
    const other = b?.[questionId]
    return (
      !!other &&
      other.length === picked.length &&
      picked.every((option) => other.includes(option))
    )
  })
}

// The answers the user picks in questions widgets that their chats have
// not saved yet. A chat saves one widget's answers at a time, in order, and
// picks made meanwhile go together in its next save.
export class AnswerSaves {
  // Each widget's save, by chat and then by widget call.
  readonly status: Store<Record<string, Record<string, AnswerSaveStatus>>> =
    createStore({})
  private unsent = new Map<string, Map<string, Unsent>>()
  private savers = new Map<string, SaveAnswers>()
  private saving = new Map<string, Promise<void>>()

  // Adds picks to those a widget has not saved, and saves them once the
  // chat's earlier saves end. Rejects with why a save failed; the picks
  // that failed stay unsent.
  pick(
    threadId: string,
    messageId: string,
    toolCallId: string,
    changes: AnswerChanges,
    save: SaveAnswers,
  ): Promise<void> {
    const chat = this.unsent.get(threadId) ?? new Map<string, Unsent>()
    this.unsent.set(threadId, chat)
    chat.set(toolCallId, {
      messageId,
      changes: { ...chat.get(toolCallId)?.changes, ...changes },
    })
    this.savers.set(threadId, save)
    this.mark(threadId, toolCallId, 'saving')
    return this.drain(threadId)
  }

  // Saves what a chat holds unsent, a failed save included, or nothing when
  // it holds nothing.
  flush(threadId: string): Promise<void> | undefined {
    const saving = this.saving.get(threadId)
    if (saving)
      return saving.then(
        () => this.flush(threadId),
        () => this.flush(threadId),
      )
    if (this.unsent.get(threadId)?.size) return this.drain(threadId)
  }

  // Applies the picks a chat has not saved to its messages.
  overlay(threadId: string, messages: Message[]): Message[] {
    let shown = messages
    for (const [toolCallId, { messageId, changes }] of this.unsent.get(
      threadId,
    ) ?? [])
      shown = withAnswers(shown, messageId, toolCallId, changes)
    return shown
  }

  // Forgets the picks a chat has not saved, as when it no longer holds the
  // widgets they are for.
  forget(threadId: string) {
    this.unsent.delete(threadId)
    this.status.update(({ [threadId]: _forgotten, ...rest }) => rest)
  }

  private mark(
    threadId: string,
    toolCallId: string,
    status: AnswerSaveStatus | undefined,
  ) {
    this.status.update((all) => {
      const { [toolCallId]: _previous, ...rest } = all[threadId] ?? {}
      return {
        ...all,
        [threadId]: status ? { ...rest, [toolCallId]: status } : rest,
      }
    })
  }

  private drain(threadId: string): Promise<void> {
    const running = this.saving.get(threadId)
    if (running) return running
    const save = this.savers.get(threadId)
    const chat = this.unsent.get(threadId)
    const run = (async () => {
      for (const [toolCallId] of chat ?? [])
        this.mark(threadId, toolCallId, 'saving')
      try {
        let next = chat?.entries().next().value
        while (save && chat && next) {
          const [toolCallId, { messageId, changes }] = next
          chat.delete(toolCallId)
          try {
            await save(messageId, toolCallId, changes)
          } catch (cause) {
            // The picks made since go over those that failed.
            chat.set(toolCallId, {
              messageId,
              changes: { ...changes, ...chat.get(toolCallId)?.changes },
            })
            for (const [unsaved] of chat) this.mark(threadId, unsaved, 'failed')
            throw cause
          }
          if (!chat.has(toolCallId)) this.mark(threadId, toolCallId, undefined)
          next = chat.entries().next().value
        }
      } finally {
        this.saving.delete(threadId)
      }
    })()
    this.saving.set(threadId, run)
    return run
  }
}
