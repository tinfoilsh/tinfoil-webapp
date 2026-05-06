import { ImageWithSkeleton } from '@/components/preview/image-with-skeleton'
import { Card } from '@/components/ui/card'
import { sanitizeUrl } from '@braintree/sanitize-url'
import { Check, Clock, Flame, Printer, RotateCcw, Users } from 'lucide-react'
import { useState, type Dispatch, type SetStateAction } from 'react'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const RECIPE_SCALE_OPTIONS = [1, 2, 3] as const
const DEFAULT_RECIPE_SCALE = 1
const RECIPE_ACCENT_TEXT = 'text-orange-600 dark:text-orange-400'
const RECIPE_ACCENT_BG = 'bg-orange-500'
const RECIPE_ACCENT_TINT = 'bg-orange-500/12 dark:bg-orange-400/15'

type RecipeScale = (typeof RECIPE_SCALE_OPTIONS)[number]

const UNICODE_FRACTIONS: Record<string, number> = {
  '⅛': 1 / 8,
  '¼': 1 / 4,
  '⅓': 1 / 3,
  '⅜': 3 / 8,
  '½': 1 / 2,
  '⅝': 5 / 8,
  '⅔': 2 / 3,
  '¾': 3 / 4,
  '⅞': 7 / 8,
}

const FRACTION_LABELS: Array<[number, string]> = [
  [1 / 8, '⅛'],
  [1 / 4, '¼'],
  [1 / 3, '⅓'],
  [3 / 8, '⅜'],
  [1 / 2, '½'],
  [5 / 8, '⅝'],
  [2 / 3, '⅔'],
  [3 / 4, '¾'],
  [7 / 8, '⅞'],
]

const QUANTITY_TOKEN_PATTERN =
  /\d+\s*[⅛¼⅓⅜½⅝⅔¾⅞]|\d+\s+\d+\/\d+|\d+\/\d+|\d*\.?\d+|[⅛¼⅓⅜½⅝⅔¾⅞]/g
const FRACTION_MATCH_TOLERANCE = 0.02
const DECIMAL_PLACES = 2

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
  sourceUrl: z.string().optional(),
  source: z.string().optional(),
})

type RecipeProps = z.infer<typeof schema>

function difficultyLabel(value: RecipeProps['difficulty']): string | null {
  if (!value) return null
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function parseQuantityToken(token: string): number | null {
  const trimmed = token.trim()
  if (Object.prototype.hasOwnProperty.call(UNICODE_FRACTIONS, trimmed)) {
    return UNICODE_FRACTIONS[trimmed]
  }

  // Combined form like "1⅓" or "2 ½" — whole number followed by a unicode
  // fraction. Without this branch the regex tokenizer would split these
  // into two adjacent numeric replacements that, after scaling, can fuse
  // into a different number (e.g. 2½ × 2 → "41" instead of "5").
  const mixedUnicode = trimmed.match(/^(\d+)\s*([⅛¼⅓⅜½⅝⅔¾⅞])$/)
  if (mixedUnicode) {
    const whole = Number(mixedUnicode[1])
    const fraction = UNICODE_FRACTIONS[mixedUnicode[2]]
    if (Number.isFinite(whole) && fraction !== undefined) {
      return whole + fraction
    }
  }

  const mixed = trimmed.match(/^(\d+)\s+(\d+)\/(\d+)$/)
  if (mixed) {
    const whole = Number(mixed[1])
    const numerator = Number(mixed[2])
    const denominator = Number(mixed[3])
    if (denominator === 0) return null
    return whole + numerator / denominator
  }

  const fraction = trimmed.match(/^(\d+)\/(\d+)$/)
  if (fraction) {
    const numerator = Number(fraction[1])
    const denominator = Number(fraction[2])
    if (denominator === 0) return null
    return numerator / denominator
  }

  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

function formatScaledQuantity(value: number): string {
  if (Number.isInteger(value)) return String(value)

  const whole = Math.floor(value)
  const fractional = value - whole
  const match = FRACTION_LABELS.find(
    ([fraction]) => Math.abs(fractional - fraction) < FRACTION_MATCH_TOLERANCE,
  )
  if (match) return whole > 0 ? `${whole} ${match[1]}` : match[1]

  return value.toFixed(DECIMAL_PLACES).replace(/\.?0+$/, '')
}

function scaleQuantityText(value: string, scale: RecipeScale): string {
  if (scale === DEFAULT_RECIPE_SCALE) return value
  return value.replace(QUANTITY_TOKEN_PATTERN, (token) => {
    const amount = parseQuantityToken(token)
    if (amount === null) return token
    return formatScaledQuantity(amount * scale)
  })
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
  sourceUrl,
  source,
}: RecipeProps) {
  const ingredientItems = ingredients ?? []
  const stepItems = steps ?? []
  const difficultyText = difficultyLabel(difficulty)

  const [checkedIngredients, setCheckedIngredients] = useState<Set<number>>(
    () => new Set(),
  )
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(
    () => new Set(),
  )
  const [recipeScale, setRecipeScale] =
    useState<RecipeScale>(DEFAULT_RECIPE_SCALE)

  function toggle(
    index: number,
    setter: Dispatch<SetStateAction<Set<number>>>,
  ): void {
    setter((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const metaItems: Array<{
    icon: typeof Clock
    label: string
    value: string
    scaled?: boolean
  }> = []
  if (prepTime) metaItems.push({ icon: Clock, label: 'Prep', value: prepTime })
  if (cookTime) metaItems.push({ icon: Flame, label: 'Cook', value: cookTime })
  if (totalTime && !prepTime && !cookTime)
    metaItems.push({ icon: Clock, label: 'Total', value: totalTime })
  if (servings !== undefined && servings !== '') {
    const servingValue =
      typeof servings === 'number' ? String(servings) : servings
    const scaledServingValue = scaleQuantityText(servingValue, recipeScale)
    metaItems.push({
      icon: Users,
      label: 'Serves',
      value: scaledServingValue,
      scaled:
        recipeScale !== DEFAULT_RECIPE_SCALE &&
        scaledServingValue !== servingValue,
    })
  }

  const hasAnyCheckedIngredients = checkedIngredients.size > 0
  const hasAnyCompletedSteps = completedSteps.size > 0
  const canReset = hasAnyCheckedIngredients || hasAnyCompletedSteps

  function resetProgress(): void {
    setCheckedIngredients(new Set())
    setCompletedSteps(new Set())
  }

  function print(): void {
    if (typeof window === 'undefined') return
    const html = buildPrintableRecipeHtml({
      title,
      description,
      image,
      cuisine,
      difficultyText,
      metaItems: metaItems.map((m) => ({ label: m.label, value: m.value })),
      ingredients: ingredientItems.map((ingredient) => ({
        quantity: ingredient.quantity
          ? scaleQuantityText(ingredient.quantity, recipeScale)
          : undefined,
        item: ingredient.item,
        note: ingredient.note,
      })),
      steps: stepItems,
      source,
      sourceUrl,
      scale: recipeScale,
    })
    const printWindow = window.open('', '_blank', 'noopener,noreferrer')
    if (!printWindow) return
    printWindow.document.open()
    printWindow.document.write(html)
    printWindow.document.close()
    printWindow.focus()
    const triggerPrint = () => {
      printWindow.print()
    }
    if (printWindow.document.readyState === 'complete') {
      triggerPrint()
    } else {
      printWindow.addEventListener('load', triggerPrint, { once: true })
    }
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
            <p
              className={`text-[11px] font-semibold uppercase tracking-[0.18em] ${RECIPE_ACCENT_TEXT}`}
            >
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
                  className="flex items-center gap-2.5 rounded-xl bg-surface-chat-background px-3 py-2"
                >
                  <Icon className="h-3.5 w-3.5 text-content-muted" />
                  <div className="flex flex-col leading-tight">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-content-muted">
                      {m.label}
                    </span>
                    <span
                      className={`text-sm font-semibold tabular-nums ${m.scaled ? RECIPE_ACCENT_TEXT : 'text-content-primary'}`}
                      style={{
                        fontFamily:
                          'ui-rounded, "SF Pro Rounded", system-ui, -apple-system, sans-serif',
                      }}
                    >
                      {m.value}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {ingredientItems.length > 0 && (
          <div className="flex justify-center">
            <div className="inline-flex items-center overflow-hidden rounded-full bg-surface-chat-background p-1">
              <span className="px-3 text-[10px] font-semibold uppercase tracking-wider text-content-muted">
                Scale
              </span>
              {RECIPE_SCALE_OPTIONS.map((scale) => {
                const active = scale === recipeScale
                return (
                  <button
                    key={scale}
                    type="button"
                    onClick={() => setRecipeScale(scale)}
                    className={`rounded-full px-3.5 py-1 text-xs font-semibold tabular-nums transition-colors ${
                      active
                        ? `${RECIPE_ACCENT_BG} text-white`
                        : 'text-content-muted hover:bg-surface-card hover:text-content-primary'
                    }`}
                    style={{
                      fontFamily:
                        'ui-rounded, "SF Pro Rounded", system-ui, -apple-system, sans-serif',
                    }}
                    aria-pressed={active}
                  >
                    {scale}x
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {ingredientItems.length > 0 && (
          <div className="flex flex-col gap-2">
            <p
              className={`text-[11px] font-bold uppercase tracking-[0.18em] ${RECIPE_ACCENT_TEXT}`}
            >
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
                      onClick={() => toggle(i, setCheckedIngredients)}
                      className="flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-sm text-content-primary hover:bg-surface-chat-background"
                    >
                      <span
                        aria-hidden="true"
                        className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border ${
                          checked
                            ? `border-orange-500 ${RECIPE_ACCENT_BG} text-white`
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
                          <span
                            className={`font-medium ${
                              recipeScale !== DEFAULT_RECIPE_SCALE
                                ? RECIPE_ACCENT_TEXT
                                : ''
                            }`}
                          >
                            {scaleQuantityText(
                              ingredient.quantity,
                              recipeScale,
                            )}{' '}
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
            <p
              className={`text-[11px] font-bold uppercase tracking-[0.18em] ${RECIPE_ACCENT_TEXT}`}
            >
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
                      onClick={() => toggle(i, setCompletedSteps)}
                      className="flex w-full items-start gap-3 rounded-lg border border-border-subtle bg-surface-chat-background px-3 py-2 text-left transition-colors hover:bg-surface-card"
                    >
                      <span
                        aria-hidden="true"
                        className={`mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums ${
                          done
                            ? `${RECIPE_ACCENT_BG} text-white`
                            : `${RECIPE_ACCENT_TINT} ${RECIPE_ACCENT_TEXT}`
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

interface PrintableRecipeArgs {
  title: string
  description?: string
  image?: string
  cuisine?: string
  difficultyText: string | null
  metaItems: Array<{ label: string; value: string }>
  ingredients: Array<{ quantity?: string; item: string; note?: string }>
  steps: Array<{ title?: string; content: string }>
  source?: string
  sourceUrl?: string
  scale: RecipeScale
}

function buildPrintableRecipeHtml(args: PrintableRecipeArgs): string {
  const safeTitle = escapeHtml(args.title)
  const cuisineLine = [args.cuisine, args.difficultyText]
    .filter((part): part is string => Boolean(part))
    .map(escapeHtml)
    .join(' &middot; ')
  const metaHtml = args.metaItems
    .map(
      (m) =>
        `<div class="meta-item"><span class="meta-label">${escapeHtml(m.label)}</span><span class="meta-value">${escapeHtml(m.value)}</span></div>`,
    )
    .join('')
  const ingredientsHtml = args.ingredients
    .map((ingredient) => {
      const quantity = ingredient.quantity
        ? `<span class="ingredient-qty">${escapeHtml(ingredient.quantity)}</span> `
        : ''
      const note = ingredient.note
        ? ` <span class="ingredient-note">(${escapeHtml(ingredient.note)})</span>`
        : ''
      return `<li>${quantity}${escapeHtml(ingredient.item)}${note}</li>`
    })
    .join('')
  const stepsHtml = args.steps
    .map((step) => {
      const stepTitle = step.title
        ? `<p class="step-title">${escapeHtml(step.title)}</p>`
        : ''
      return `<li>${stepTitle}<p class="step-content">${escapeHtml(step.content)}</p></li>`
    })
    .join('')
  const sourceHtml = (() => {
    if (!args.source && !args.sourceUrl) return ''
    if (args.sourceUrl) {
      const safeUrl = sanitizeUrl(args.sourceUrl)
      const label = args.source ?? args.sourceUrl
      return `<p class="source">Source: <a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a></p>`
    }
    return `<p class="source">Source: ${escapeHtml(args.source ?? '')}</p>`
  })()
  const imageHtml = args.image
    ? `<img class="hero" src="${escapeHtml(args.image)}" alt="" referrerpolicy="no-referrer" />`
    : ''
  const descriptionHtml = args.description
    ? `<p class="description">${escapeHtml(args.description)}</p>`
    : ''
  const cuisineHtml = cuisineLine ? `<p class="cuisine">${cuisineLine}</p>` : ''
  const scaleHtml =
    args.scale !== DEFAULT_RECIPE_SCALE
      ? `<p class="scale-note">Scaled to ${args.scale}x</p>`
      : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${safeTitle}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #111;
    background: #fff;
    padding: 32px;
    line-height: 1.5;
  }
  .container { max-width: 720px; margin: 0 auto; }
  .hero { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 6px; margin-bottom: 24px; }
  h1 { font-size: 28px; font-weight: 600; margin: 0 0 8px; }
  .cuisine { text-transform: uppercase; letter-spacing: 0.16em; font-size: 11px; color: #ea580c; font-weight: 600; margin: 0 0 12px; }
  .description { color: #444; margin: 0 0 20px; }
  .meta { display: flex; flex-wrap: wrap; gap: 18px; padding: 14px 0; margin: 0 0 20px; border-top: 1px solid #e5e5e5; border-bottom: 1px solid #e5e5e5; }
  .meta-item { display: flex; flex-direction: column; }
  .meta-label { text-transform: uppercase; letter-spacing: 0.08em; font-size: 10px; color: #777; }
  .meta-value { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .scale-note { font-size: 12px; color: #ea580c; margin: 0 0 16px; font-weight: 600; }
  h2 { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.18em; color: #ea580c; margin: 24px 0 8px; }
  ul.ingredients, ol.steps { padding-left: 22px; margin: 0; }
  ul.ingredients li, ol.steps li { margin-bottom: 6px; }
  .ingredient-qty { font-weight: 600; }
  .ingredient-note { color: #666; font-size: 12px; }
  ol.steps li { margin-bottom: 12px; }
  .step-title { font-weight: 600; margin: 0 0 2px; }
  .step-content { margin: 0; }
  .source { margin-top: 28px; font-size: 12px; color: #555; }
  @media print {
    body { padding: 0; }
    a { color: inherit; text-decoration: none; }
  }
</style>
</head>
<body>
  <div class="container">
    ${imageHtml}
    ${cuisineHtml}
    <h1>${safeTitle}</h1>
    ${descriptionHtml}
    ${scaleHtml}
    ${metaHtml ? `<div class="meta">${metaHtml}</div>` : ''}
    ${ingredientsHtml ? `<h2>Ingredients</h2><ul class="ingredients">${ingredientsHtml}</ul>` : ''}
    ${stepsHtml ? `<h2>Steps</h2><ol class="steps">${stepsHtml}</ol>` : ''}
    ${sourceHtml}
  </div>
</body>
</html>`
}

export const widget = defineGenUIWidget({
  name: 'render_recipe_card',
  description:
    'Display a cookable recipe card with ingredients and step-by-step instructions. Use when presenting a recipe, cooking procedure, or multi-step preparation with ingredients.',
  schema,
  promptHint: 'a cookable recipe card with ingredients and steps',
  render: (args) => <Recipe {...args} />,
})
