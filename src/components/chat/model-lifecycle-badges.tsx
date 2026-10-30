import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { BaseModel } from '@/config/models'

const BADGE_CLASS_NAME =
  'inline-flex shrink-0 cursor-help items-center whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-normal'

type Badge = BaseModel['badges'][number]
type BadgeKind = 'experimental' | 'deprecated'

const BADGE_COLORS: Record<BadgeKind, string> = {
  experimental:
    'bg-blue-500/10 text-blue-600 dark:bg-blue-400/15 dark:text-blue-300',
  deprecated:
    'bg-amber-500/10 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300',
}

// A badge of a kind this client does not know is not shown.
const isShownBadge = (badge: Badge): badge is Badge & { kind: BadgeKind } =>
  Object.hasOwn(BADGE_COLORS, badge.kind)

export function ModelLifecycleBadges({
  badges,
}: {
  badges: BaseModel['badges']
}) {
  const shown = badges.filter(isShownBadge)
  if (!shown.length) return null

  return (
    <TooltipProvider delayDuration={0}>
      <span className="mt-1.5 flex flex-wrap items-center gap-1">
        {shown.map(({ kind, label, tooltip }) => (
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
