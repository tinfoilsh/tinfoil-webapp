import { z } from 'zod'
import { coerceArray } from '../input-coercion'
import { defineGenUIWidget } from '../types'

const schema = z.object({
  columns: z.array(z.string()).describe('Column header names'),
  rows: z
    .array(z.record(z.string(), z.union([z.string(), z.number()])))
    .describe('Row objects keyed by column name'),
  caption: z.string().optional().describe('Optional table caption'),
})

export const widget = defineGenUIWidget({
  name: 'render_data_table',
  description:
    'Render structured tabular data. Use when presenting rows and columns.',
  schema,
  promptHint: 'structured rows and columns',
  render: ({ columns, rows, caption }) => {
    const safeColumns = coerceArray<string>(columns)
    const safeRows = coerceArray<Record<string, string | number>>(rows)
    return (
      <div className="my-3 overflow-x-auto rounded-lg border border-border-subtle">
        <table className="w-full divide-y divide-border-subtle">
          {caption && (
            <caption className="bg-surface-chat-background px-4 py-2 text-left text-sm font-medium text-content-primary">
              {caption}
            </caption>
          )}
          <thead className="bg-surface-chat-background">
            <tr>
              {safeColumns.map((col) => (
                <th
                  key={col}
                  className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-content-primary"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {safeRows.map((row, i) => (
              <tr key={i}>
                {safeColumns.map((col) => (
                  <td
                    key={col}
                    className="px-4 py-3 text-sm text-content-primary"
                  >
                    {row[col] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  },
})
