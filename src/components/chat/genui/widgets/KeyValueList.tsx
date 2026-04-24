import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const schema = z.object({
  items: z
    .array(
      z.object({
        label: z.string(),
        value: z.union([z.string(), z.number()]),
      }),
    )
    .min(1)
    .describe('Key-value rows'),
  title: z.string().optional(),
})

export const widget = defineGenUIWidget({
  name: 'render_key_value_list',
  description:
    'Display a fact sheet of labeled values. Use for structured attributes like specs or metadata.',
  schema,
  promptHint: 'labeled fact sheet of attributes, specs, or metadata',
  render: ({ items, title }) => (
    <div className="my-3">
      {title && (
        <p className="mb-2 text-sm font-medium text-content-primary">{title}</p>
      )}
      <div className="overflow-hidden rounded-lg border border-border-subtle">
        <dl className="divide-y divide-border-subtle">
          {items.map((item, i) => (
            <div
              key={i}
              className="grid grid-cols-3 gap-4 px-4 py-2.5 sm:grid-cols-4"
            >
              <dt className="col-span-1 text-sm font-medium text-content-muted">
                {item.label}
              </dt>
              <dd className="col-span-2 text-sm text-content-primary sm:col-span-3">
                {item.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  ),
})
