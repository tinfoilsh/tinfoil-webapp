import { Card } from '@/components/ui/card'
import { cn } from '@/components/ui/utils'
import { sameAnswers } from '@/services/harness/question-answers'
import { useContext } from 'react'
import { QuestionsContext } from '../questions-context'
import { defineGenUIWidget, type GenUIRenderContext } from '../types'
import type { RenderQuestionsArgs } from '../widget-args'

type Question = RenderQuestionsArgs['questions'][number]

// The options of a question picked once the user toggles one, in the order
// the question offers them, or null when none is left. Toggling a
// single-choice question's answer off leaves it unanswered.
function toggled(
  question: Question,
  picked: readonly string[],
  optionId: string,
): string[] | null {
  const chosen = picked.includes(optionId)
    ? picked.filter((id) => id !== optionId)
    : question.selection === 'single'
      ? [optionId]
      : [...picked, optionId]
  const ordered = question.options
    .map((option) => option.id)
    .filter((id) => chosen.includes(id))
  return ordered.length ? ordered : null
}

function QuestionsCard({
  args: { title, questions },
  ctx: { toolCallId, messageId, answers, isStreaming },
}: {
  args: RenderQuestionsArgs
  ctx: GenUIRenderContext
}) {
  const answering = useContext(QuestionsContext)
  const editable = !!answering?.canAnswer && !isStreaming
  const save = toolCallId ? answering?.saves[toolCallId] : undefined
  const answered = questions.filter(
    (question) => answers?.[question.id] !== undefined,
  ).length
  const unsent =
    !!toolCallId && !sameAnswers(answers, answering?.sent[toolCallId])
  const pick = (question: Question, optionId: string) => {
    if (!editable || !answering || !messageId || !toolCallId) return
    answering.answer(messageId, toolCallId, {
      [question.id]: toggled(question, answers?.[question.id] ?? [], optionId),
    })
  }
  const status =
    save === 'saving'
      ? 'Saving…'
      : save === 'failed'
        ? 'Your answers could not be saved.'
        : unsent
          ? 'Saved. Your answers are sent with your next message.'
          : answered
            ? 'Your answers were sent.'
            : null

  return (
    <Card className="my-3 w-full overflow-hidden">
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          {title && (
            <p className="text-sm font-semibold text-content-primary">
              {title}
            </p>
          )}
          <p className="text-xs text-content-muted">
            {answered} of {questions.length} answered
          </p>
        </div>
        {questions.map((question, index) => {
          const picked = answers?.[question.id] ?? []
          const single = question.selection === 'single'
          return (
            <fieldset
              key={question.id}
              disabled={!editable}
              className="flex flex-col gap-2"
            >
              <legend className="mb-2 text-sm font-medium text-content-primary">
                <span className="text-content-muted">{index + 1}.</span>{' '}
                {question.prompt}
              </legend>
              {question.options.map((option) => {
                const checked = picked.includes(option.id)
                return (
                  <label
                    key={option.id}
                    className={cn(
                      'flex items-start gap-3 rounded-lg border px-3 py-2 text-sm text-content-primary transition-colors',
                      checked
                        ? 'border-content-primary/50 bg-surface-chat-background'
                        : 'border-border-subtle',
                      editable
                        ? 'cursor-pointer hover:border-content-primary/40'
                        : 'cursor-default',
                    )}
                  >
                    <input
                      type={single ? 'radio' : 'checkbox'}
                      name={`${toolCallId}-${question.id}`}
                      checked={checked}
                      onChange={() => pick(question, option.id)}
                      // A picked radio button takes no change, so clicking
                      // it again unpicks it here.
                      onClick={
                        single && checked
                          ? () => pick(question, option.id)
                          : undefined
                      }
                      className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                    />
                    <span>{option.label}</span>
                  </label>
                )
              })}
            </fieldset>
          )
        })}
        {answering && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p role="status" className="text-xs text-content-muted">
              {status}
              {save === 'failed' && editable && (
                <button
                  type="button"
                  onClick={answering.retry}
                  className="ml-2 font-medium text-content-primary underline-offset-2 hover:underline"
                >
                  Try again
                </button>
              )}
            </p>
            {!isStreaming && (
              <button
                type="button"
                onClick={answering.submit}
                disabled={!answering.canSubmit || !unsent}
                className="rounded-lg bg-tinfoil-oak px-3 py-1.5 text-sm font-medium text-brand-dark transition-colors hover:bg-tinfoil-oak-hover disabled:cursor-default disabled:opacity-50"
              >
                Submit answers
              </button>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}

export const widget = defineGenUIWidget({
  name: 'render_questions',
  render: (args, ctx) => <QuestionsCard args={args} ctx={ctx} />,
})
