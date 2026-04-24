import { Check, Minus, X } from 'lucide-react'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const schema = z.object({
  items: z
    .array(z.string())
    .min(1)
    .describe('Column headers — things being compared'),
  features: z
    .array(
      z.object({
        label: z.string(),
        values: z
          .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .describe(
            'One value per item. Use booleans for yes/no, strings/numbers otherwise.',
          ),
      }),
    )
    .min(1)
    .describe('Feature rows'),
  title: z.string().optional(),
})

function renderCell(value: string | number | boolean | null | undefined) {
  if (value === true) {
    return <Check className="mx-auto h-4 w-4 text-green-500" />
  }
  if (value === false) {
    return <X className="mx-auto h-4 w-4 text-red-500" />
  }
  if (value === null || value === undefined || value === '') {
    return <Minus className="mx-auto h-4 w-4 text-content-muted" />
  }
  return <span>{String(value)}</span>
}

export const widget = defineGenUIWidget({
  name: 'render_comparison_table',
  description:
    'Render a side-by-side feature comparison table. Booleans render as check/cross icons.',
  schema,
  promptHint: 'side-by-side feature comparison; booleans render as check/cross',
  render: ({ items, features, title }) => (
    <div className="my-3">
      {title && (
        <p className="mb-2 text-sm font-medium text-content-primary">{title}</p>
      )}
      <div className="overflow-x-auto rounded-lg border border-border-subtle">
        <table className="w-full divide-y divide-border-subtle">
          <thead className="bg-surface-chat-background">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-content-muted">
                Feature
              </th>
              {items.map((item) => (
                <th
                  key={item}
                  className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wider text-content-primary"
                >
                  {item}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {features.map((feature, i) => (
              <tr key={i}>
                <td className="px-4 py-3 text-sm font-medium text-content-primary">
                  {feature.label}
                </td>
                {items.map((_, j) => (
                  <td
                    key={j}
                    className="px-4 py-3 text-center text-sm text-content-primary"
                  >
                    {renderCell(feature.values[j])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  ),
})
