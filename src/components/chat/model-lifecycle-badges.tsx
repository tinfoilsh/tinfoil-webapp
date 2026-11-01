import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { BaseModel } from '@/config/models'

const BADGE_CLASS_NAME =
  'inline-flex shrink-0 cursor-help items-center whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-normal'

const BADGE_COLORS: Record<BaseModel['badges'][number]['kind'], string> = {
  experimental:
    'bg-blue-500/10 text-blue-600 dark:bg-blue-400/15 dark:text-blue-300',
  deprecated:
    'bg-amber-500/10 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300',
}

export function ModelLifecycleBadges({
  badges,
}: {
  badges: BaseModel['badges']
}) {
  if (!badges.length) return null

  return (
    <TooltipProvider delayDuration={0}>
      <span className="mt-1.5 flex flex-wrap items-center gap-1">
        {badges.map(({ kind, label, tooltip }) => (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <span className={`${BADGE_CLASS_NAME} ${BADGE_COLORS[kind]}`}>
                {label}
                <span className="sr-only">: {tooltip}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs border-border-subtle bg-surface-chat font-aeonik text-xs text-content-primary">
              {tooltip}
            </TooltipContent>
          </Tooltip>
        ))}
      </span>
    </TooltipProvider>
  )
}
