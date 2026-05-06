import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const schema = z.object({
  events: z
    .array(
      z.object({
        date: z.string(),
        title: z.string(),
        description: z.string().optional(),
      }),
    )
    .min(1)
    .describe('Chronological events'),
  title: z.string().optional(),
})

export const widget = defineGenUIWidget({
  name: 'render_timeline',
  description:
    'Display a chronological timeline of events. Use for history, news recaps, or project milestones.',
  schema,
  promptHint: 'chronological events, history, news recaps, or milestones',
  render: ({ events, title }) => (
    <div className="my-3">
      {title && (
        <p className="mb-3 text-sm font-medium text-content-primary">{title}</p>
      )}
      <div className="relative">
        <div className="absolute bottom-2 left-[7px] top-2 w-px bg-border-subtle" />
        <div className="space-y-4">
          {events.map((event, i) => (
            <div key={i} className="relative flex gap-4">
              <div className="mt-1.5 h-[14px] w-[14px] shrink-0 rounded-full border-2 border-border-subtle bg-surface-card" />
              <div className="flex-1">
                <p className="text-xs font-medium uppercase tracking-wider text-content-muted">
                  {event.date}
                </p>
                <p className="mt-0.5 text-sm font-medium text-content-primary">
                  {event.title}
                </p>
                {event.description && (
                  <p className="mt-1 text-sm text-content-muted">
                    {event.description}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  ),
})
