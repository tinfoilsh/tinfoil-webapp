import { ImageWithSkeleton } from '@/components/preview/image-with-skeleton'
import { Card } from '@/components/ui/card'
import { sanitizeUrl } from '@braintree/sanitize-url'
import { Check, Clock, Flame, Printer, RotateCcw, Users } from 'lucide-react'
import { useState, type Dispatch, type SetStateAction } from 'react'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const ingredientSchema = z.object({
  quantity: z.string().optional(),
  item: z.string(),
  note: z.string().optional(),
})

const stepSchema = z.object({
  title: z.string().optional(),
  content: z.string(),
})

const schema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  image: z.string().optional(),
  cuisine: z.string().optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  servings: z.union([z.string(), z.number()]).optional(),
  prepTime: z.string().optional(),
  cookTime: z.string().optional(),
  totalTime: z.string().optional(),
  ingredients: z.array(ingredientSchema).optional(),
  steps: z.array(stepSchema).optional(),
  tags: z.array(z.string()).optional(),
  sourceUrl: z.string().optional(),
  source: z.string().optional(),
})

type RecipeProps = z.infer<typeof schema>

function difficultyLabel(value: RecipeProps['difficulty']): string | null {
  if (!value) return null
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function Recipe({
  title,
  description,
  image,
  cuisine,
  difficulty,
  servings,
  prepTime,
  cookTime,
  totalTime,
  ingredients,
  steps,
  tags,
  sourceUrl,
  source,
}: RecipeProps) {
  const ingredientItems = ingredients ?? []
  const stepItems = steps ?? []
  const tagItems = tags ?? []
  const difficultyText = difficultyLabel(difficulty)

  const [checkedIngredients, setCheckedIngredients] = useState<Set<number>>(
    () => new Set(),
  )
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(
    () => new Set(),
  )

  function toggle(
    current: Set<number>,
    index: number,
    setter: Dispatch<SetStateAction<Set<number>>>,
  ): void {
    setter(() => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const metaItems: Array<{ icon: typeof Clock; label: string; value: string }> =
    []
  if (prepTime) metaItems.push({ icon: Clock, label: 'Prep', value: prepTime })
  if (cookTime) metaItems.push({ icon: Flame, label: 'Cook', value: cookTime })
  if (totalTime && !prepTime && !cookTime)
    metaItems.push({ icon: Clock, label: 'Total', value: totalTime })
  if (servings !== undefined && servings !== '')
    metaItems.push({
      icon: Users,
      label: 'Serves',
      value: typeof servings === 'number' ? String(servings) : servings,
    })

  const hasAnyCheckedIngredients = checkedIngredients.size > 0
  const hasAnyCompletedSteps = completedSteps.size > 0
  const canReset = hasAnyCheckedIngredients || hasAnyCompletedSteps

  function resetProgress(): void {
    setCheckedIngredients(new Set())
    setCompletedSteps(new Set())
  }

  function print(): void {
    if (typeof window !== 'undefined') window.print()
  }

  return (
    <Card className="my-3 w-full overflow-hidden">
      {image && (
        <ImageWithSkeleton
          src={image}
          alt={title}
          wrapperClassName="relative aspect-[16/9] w-full overflow-hidden bg-surface-card"
          className="h-full w-full object-cover"
          loading="lazy"
        />
      )}
      <div className="flex flex-col gap-5 p-5 sm:p-6">
        {/* Header: action buttons anchor top-right; title block centers
            within the remaining space. */}
        <div className="relative flex flex-col items-center gap-2 text-center">
          <div className="absolute right-0 top-0 flex items-center gap-1">
            {canReset && (
              <button
                type="button"
                onClick={resetProgress}
                className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-surface-chat-background px-2.5 py-1 text-xs text-content-muted transition-colors hover:bg-surface-card hover:text-content-primary"
                aria-label="Reset checklist"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset
              </button>
            )}
            <button
              type="button"
              onClick={print}
              className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-surface-chat-background px-2.5 py-1 text-xs text-content-muted transition-colors hover:bg-surface-card hover:text-content-primary"
              aria-label="Print recipe"
            >
              <Printer className="h-3.5 w-3.5" />
              Print
            </button>
          </div>

          {(cuisine || difficultyText) && (
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-content-muted">
              {cuisine}
              {cuisine && difficultyText && (
                <span className="mx-1.5 opacity-60">·</span>
              )}
              {difficultyText}
            </p>
          )}
          <h3 className="text-2xl font-semibold leading-tight text-content-primary sm:text-3xl">
            {title}
          </h3>
          {description && (
            <p className="max-w-xl text-sm text-content-muted">{description}</p>
          )}
        </div>

        {metaItems.length > 0 && (
          <div className="flex flex-wrap justify-center gap-2">
            {metaItems.map((m) => {
              const Icon = m.icon
              return (
                <div
                  key={m.label}
                  className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-chat-background px-3 py-1.5"
                >
                  <Icon className="h-3.5 w-3.5 text-content-muted" />
                  <span className="text-[11px] uppercase tracking-wide text-content-muted">
                    {m.label}
                  </span>
                  <span className="text-sm font-medium text-content-primary">
                    {m.value}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {ingredientItems.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-content-muted">
              Ingredients
            </p>
            <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {ingredientItems.map((ingredient, i) => {
                const checked = checkedIngredients.has(i)
                return (
                  <li key={`${ingredient.item}-${i}`}>
                    <button
                      type="button"
                      aria-pressed={checked}
                      onClick={() =>
                        toggle(checkedIngredients, i, setCheckedIngredients)
                      }
                      className="flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-sm text-content-primary hover:bg-surface-chat-background"
                    >
                      <span
                        aria-hidden="true"
                        className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border ${
                          checked
                            ? 'border-content-primary bg-content-primary text-surface-chat-background'
                            : 'border-border-subtle bg-transparent'
                        }`}
                      >
                        {checked && <Check className="h-3 w-3" />}
                      </span>
                      <span
                        className={
                          checked
                            ? 'text-content-muted line-through'
                            : undefined
                        }
                      >
                        {ingredient.quantity && (
                          <span className="font-medium">
                            {ingredient.quantity}{' '}
                          </span>
                        )}
                        {ingredient.item}
                        {ingredient.note && (
                          <span className="text-xs text-content-muted">
                            {' '}
                            ({ingredient.note})
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {stepItems.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-content-muted">
              Steps
            </p>
            <ol className="flex flex-col gap-2">
              {stepItems.map((step, i) => {
                const done = completedSteps.has(i)
                return (
                  <li key={`step-${i}`}>
                    <button
                      type="button"
                      aria-pressed={done}
                      onClick={() =>
                        toggle(completedSteps, i, setCompletedSteps)
                      }
                      className="flex w-full items-start gap-3 rounded-lg border border-border-subtle bg-surface-chat-background px-3 py-2 text-left transition-colors hover:bg-surface-card"
                    >
                      <span
                        aria-hidden="true"
                        className={`mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
                          done
                            ? 'border-content-primary bg-content-primary text-surface-chat-background'
                            : 'border-border-subtle bg-transparent text-content-muted'
                        }`}
                      >
                        {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col">
                        {step.title && (
                          <span
                            className={`text-sm font-medium ${done ? 'text-content-muted line-through' : 'text-content-primary'}`}
                          >
                            {step.title}
                          </span>
                        )}
                        <span
                          className={`text-sm ${done ? 'text-content-muted line-through' : 'text-content-primary'}`}
                        >
                          {step.content}
                        </span>
                      </div>
                    </button>
                  </li>
                )
              })}
            </ol>
          </div>
        )}

        {tagItems.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {tagItems.map((tag, idx) => (
              <span
                key={`${idx}-${tag}`}
                className="rounded-full border border-border-subtle bg-surface-chat-background px-2.5 py-0.5 text-[11px] text-content-muted"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {(source || sourceUrl) && (
          <div className="border-t border-border-subtle pt-3 text-xs text-content-muted">
            Source:{' '}
            {sourceUrl ? (
              <a
                href={sanitizeUrl(sourceUrl)}
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-dotted underline-offset-2 hover:text-content-primary"
              >
                {source ?? sourceUrl}
              </a>
            ) : (
              <span>{source}</span>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}

export const widget = defineGenUIWidget({
  name: 'render_recipe_card',
  description:
    'Display a cookable recipe card with ingredients and step-by-step instructions. Use when presenting a recipe, cooking procedure, or multi-step preparation with ingredients.',
  schema,
  promptHint: 'a cookable recipe card with ingredients and steps',
  render: (args) => <Recipe {...args} />,
})
