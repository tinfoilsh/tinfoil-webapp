import type { WidgetAnswers } from '@/services/harness/types'

type AnsweredQuestion = WidgetAnswers['questions'][number]

function answerOf(question: AnsweredQuestion): string {
  if (!question.answered) return 'Not answered'
  if (!question.selected.length) return 'None selected'
  return question.selected.map((option) => option.label).join(', ')
}

// The answers to questions widgets a user message sent the model, folded
// to how many it answered.
export function SentAnswers({ answers }: { answers: WidgetAnswers[] }) {
  const questions = answers.flatMap((widget) => widget.questions)
  const answered = questions.filter((question) => question.answered).length
  return (
    <details className="w-full max-w-[95%] rounded-site-lg bg-surface-message-user/90 px-4 py-2 text-sm shadow-sm backdrop-blur-sm">
      <summary className="cursor-pointer select-none font-medium text-content-primary">
        Answered {answered} of {questions.length}{' '}
        {questions.length === 1 ? 'question' : 'questions'}
      </summary>
      <div className="mt-2 flex flex-col gap-3">
        {answers.map((widget) => (
          <div key={widget.toolCallId} className="flex flex-col gap-2">
            {widget.title && (
              <p className="text-xs font-semibold text-content-muted">
                {widget.title}
              </p>
            )}
            <ol className="flex list-decimal flex-col gap-1.5 pl-5">
              {widget.questions.map((question) => (
                <li key={question.id}>
                  <p className="text-content-secondary">{question.prompt}</p>
                  <p className="font-medium text-content-primary">
                    {answerOf(question)}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </details>
  )
}
