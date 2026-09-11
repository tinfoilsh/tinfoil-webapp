import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { BaseModel } from '@/config/models'

// Matches the "Default" chip in the effort menu so the labels read as quiet
// metadata rather than alerts.
const BADGE_CLASS_NAME =
  'inline-flex shrink-0 cursor-help items-center whitespace-nowrap rounded bg-surface-card px-1.5 py-0.5 text-xs font-normal'

const EXPERIMENTAL_TOOLTIP =
  'Support and availability are not guaranteed. This model can be deprecated at any time.'
const DEPRECATION_TOOLTIP =
  'This model is deprecated. An offline date has not been announced.'

export function ModelLifecycleBadges({
  model,
}: {
  model: Pick<BaseModel, 'experimental' | 'deprecated' | 'deprecationdate'>
}) {
  if (model.experimental !== true && model.deprecated !== true) return null

  const badges = [
    ...(model.experimental === true
      ? [
          {
            label: 'Experimental',
            tooltip: EXPERIMENTAL_TOOLTIP,
            className: 'text-content-muted',
          },
        ]
      : []),
    ...(model.deprecated === true
      ? [
          {
            label: 'Deprecated',
            tooltip: model.deprecationdate
              ? `This model will be taken offline on ${model.deprecationdate}.`
              : DEPRECATION_TOOLTIP,
            className: 'text-amber-700 dark:text-amber-400',
          },
        ]
      : []),
  ]

  return (
    <TooltipProvider>
      <span className="mb-1 mt-0.5 flex flex-wrap items-center gap-1">
        {badges.map(({ label, tooltip, className }) => (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <span className={`${BADGE_CLASS_NAME} ${className}`}>
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
