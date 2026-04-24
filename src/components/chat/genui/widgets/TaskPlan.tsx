import { Progress } from '@/components/ui/progress'
import { AlertTriangle, CheckCircle2, Circle, CircleDot } from 'lucide-react'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const taskStatusEnum = z.enum([
  'pending',
  'in_progress',
  'completed',
  'blocked',
])

const schema = z.object({
  title: z.string().optional().describe('Plan title (defaults to "Plan")'),
  summary: z.string().optional().describe('Short description of the plan'),
  status: taskStatusEnum.optional().describe('Overall status override'),
  progress: z
    .number()
    .optional()
    .describe('Overall progress 0-100; derived from tasks if omitted'),
  tasks: z
    .array(
      z.object({
        title: z.string(),
        description: z.string().optional(),
        status: taskStatusEnum.optional(),
      }),
    )
    .min(1)
    .describe('Ordered list of tasks'),
  nextStep: z
    .string()
    .optional()
    .describe('Callout for the immediate next step'),
})

const STATUS_META = {
  pending: {
    icon: Circle,
    iconClass: 'text-content-muted',
    badgeClass:
      'border-border-subtle bg-surface-chat-background text-content-muted',
    label: 'Pending',
  },
  in_progress: {
    icon: CircleDot,
    iconClass: 'text-blue-500',
    badgeClass:
      'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400',
    label: 'In progress',
  },
  completed: {
    icon: CheckCircle2,
    iconClass: 'text-green-500',
    badgeClass:
      'border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400',
    label: 'Completed',
  },
  blocked: {
    icon: AlertTriangle,
    iconClass: 'text-red-500',
    badgeClass:
      'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400',
    label: 'Blocked',
  },
} as const

type TaskStatus = keyof typeof STATUS_META

function clampProgress(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function countByStatus(tasks: Array<{ status?: TaskStatus }>) {
  return tasks.reduce(
    (counts, task) => {
      const status = task.status ?? 'pending'
      counts[status] += 1
      return counts
    },
    { pending: 0, in_progress: 0, completed: 0, blocked: 0 },
  )
}

export const widget = defineGenUIWidget({
  name: 'render_task_plan',
  description:
    'Display a task or execution plan with statuses and overall progress. Use for multi-step workflows, agent plans, or long-running work.',
  schema,
  promptHint: 'multi-step plan with statuses and overall progress',
  render: ({ title, summary, status, progress, tasks, nextStep }) => {
    const counts = countByStatus(tasks)
    const overall: TaskStatus = status
      ? status
      : counts.blocked > 0
        ? 'blocked'
        : counts.in_progress > 0
          ? 'in_progress'
          : tasks.length > 0 && counts.completed === tasks.length
            ? 'completed'
            : 'pending'
    const meta = STATUS_META[overall]
    const percent =
      typeof progress === 'number'
        ? clampProgress(progress)
        : tasks.length === 0
          ? 0
          : clampProgress((counts.completed / tasks.length) * 100)

    return (
      <div className="my-3 overflow-hidden rounded-lg border border-border-subtle bg-surface-card">
        <div className="border-b border-border-subtle bg-surface-chat-background px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-content-primary">
                {title ?? 'Plan'}
              </p>
              {summary && (
                <p className="mt-1 text-sm text-content-muted">{summary}</p>
              )}
            </div>
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${meta.badgeClass}`}
            >
              {meta.label}
            </span>
          </div>
          <div className="mt-3 space-y-2">
            <div className="flex items-center justify-between text-xs text-content-muted">
              <span>Overall progress</span>
              <span>{Math.round(percent)}%</span>
            </div>
            <Progress value={percent} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-content-muted">
            <span>{counts.completed} completed</span>
            <span>·</span>
            <span>{counts.in_progress} in progress</span>
            <span>·</span>
            <span>{counts.pending} pending</span>
            {counts.blocked > 0 && (
              <>
                <span>·</span>
                <span>{counts.blocked} blocked</span>
              </>
            )}
          </div>
        </div>
        <div className="space-y-3 p-4">
          {tasks.map((task, i) => {
            const taskStatus: TaskStatus = task.status ?? 'pending'
            const taskMeta = STATUS_META[taskStatus]
            const Icon = taskMeta.icon
            return (
              <div key={i} className="flex gap-3">
                <div className="mt-0.5 shrink-0">
                  <Icon className={`h-5 w-5 ${taskMeta.iconClass}`} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-content-primary">
                    {task.title}
                  </p>
                  {task.description && (
                    <p className="mt-0.5 text-xs text-content-muted">
                      {task.description}
                    </p>
                  )}
                </div>
              </div>
            )
          })}
          {nextStep && (
            <div className="rounded-md border border-border-subtle bg-surface-chat-background px-3 py-2">
              <p className="text-xs uppercase tracking-wide text-content-muted">
                Next step
              </p>
              <p className="mt-1 text-sm text-content-primary">{nextStep}</p>
            </div>
          )}
        </div>
      </div>
    )
  },
})
