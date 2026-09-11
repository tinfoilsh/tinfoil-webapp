import type { BaseModel } from '@/config/models'

const BADGE_CLASS_NAME =
  'inline-flex shrink-0 items-center whitespace-nowrap rounded-md px-1.5 py-px font-aeonik text-[10px] font-normal leading-none tracking-normal'

export function ModelLifecycleBadges({
  model,
}: {
  model: Pick<BaseModel, 'experimental' | 'deprecated'>
}) {
  return (
    <>
      {model.experimental === true && (
        <span
          className={`${BADGE_CLASS_NAME} bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200`}
        >
          Experimental
        </span>
      )}
      {model.deprecated === true && (
        <span
          className={`${BADGE_CLASS_NAME} bg-amber-50 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200`}
        >
          Deprecated
        </span>
      )}
    </>
  )
}
