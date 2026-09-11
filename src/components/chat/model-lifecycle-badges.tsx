import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { BaseModel } from '@/config/models'
import { InformationCircleIcon } from '@heroicons/react/24/outline'

const BADGE_CLASS_NAME =
  'inline-flex shrink-0 cursor-help items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-px font-aeonik text-xs font-normal leading-none tracking-normal'

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
            className:
              'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
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
            className:
              'bg-amber-50 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
          },
        ]
      : []),
  ]

  return (
    <TooltipProvider>
      <span className="my-0.5 flex flex-wrap items-center gap-1">
        {badges.map(({ label, tooltip, className }) => (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <span className={`${BADGE_CLASS_NAME} ${className}`}>
                <InformationCircleIcon
                  className="h-3 w-3 shrink-0"
                  aria-hidden="true"
                />
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
