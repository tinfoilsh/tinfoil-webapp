import { cn } from '@/components/ui/utils'

const DASHED_LINE_COLOR = 'rgba(6, 24, 32, 0.18)'

function createDashedLineStyle(direction: 'to right' | 'to bottom') {
  const mask = `linear-gradient(${direction}, transparent, black 30%, black 70%, transparent)`
  return {
    backgroundImage: `repeating-linear-gradient(${direction}, ${DASHED_LINE_COLOR} 0, ${DASHED_LINE_COLOR} 4px, transparent 4px, transparent 8px)`,
    maskImage: mask,
    WebkitMaskImage: mask,
  }
}

const horizontalStyle = createDashedLineStyle('to right')
const verticalStyle = createDashedLineStyle('to bottom')

export function DashedLines({
  horizontalClassName = '-left-6 -right-6',
  verticalClassName = '-top-6 -bottom-6',
}: {
  horizontalClassName?: string
  verticalClassName?: string
}) {
  return (
    <>
      <div
        className={cn(
          'pointer-events-none absolute top-0 z-20 h-px dark:invert',
          horizontalClassName,
        )}
        style={horizontalStyle}
      />
      <div
        className={cn(
          'pointer-events-none absolute bottom-0 z-20 h-px dark:invert',
          horizontalClassName,
        )}
        style={horizontalStyle}
      />
      <div
        className={cn(
          'pointer-events-none absolute left-0 z-20 w-px dark:invert',
          verticalClassName,
        )}
        style={verticalStyle}
      />
      <div
        className={cn(
          'pointer-events-none absolute right-0 z-20 w-px dark:invert',
          verticalClassName,
        )}
        style={verticalStyle}
      />
    </>
  )
}
