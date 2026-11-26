import { Favicon } from '@/components/ui/favicon'
import { cn } from '@/components/ui/utils'

// A connector's icon: its site's favicon, which the harness looks up, or
// the first letter of its name until then and when there is none.
export function ConnectorIcon({
  url,
  name,
  className = 'h-4 w-4',
}: {
  url: string
  name: string
  className?: string
}) {
  const initial = (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-sm bg-surface-muted text-[10px] font-semibold uppercase text-content-secondary',
        className,
      )}
    >
      {name.trim().charAt(0)}
    </span>
  )
  return (
    <Favicon
      url={url}
      className={cn('shrink-0 rounded-sm', className)}
      placeholder={initial}
      fallback={initial}
    />
  )
}
