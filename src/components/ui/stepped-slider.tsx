import * as SliderPrimitive from '@radix-ui/react-slider'

import { cn } from './utils'

export type SteppedSliderStep<T extends string> = {
  id: T
  label: string
}

type SteppedSliderProps<T extends string> = {
  steps: readonly SteppedSliderStep<T>[]
  value: T
  onValueChange: (value: T) => void
  'aria-label': string
  className?: string
}

/**
 * A discrete slider with one stop per step. The track is as tall as a switch
 * so the fill reads as a level indicator; a dot marks each stop and the thumb
 * covers the current one.
 */
export function SteppedSlider<T extends string>({
  steps,
  value,
  onValueChange,
  'aria-label': ariaLabel,
  className,
}: SteppedSliderProps<T>) {
  const index = Math.max(
    0,
    steps.findIndex((step) => step.id === value),
  )
  const lastIndex = steps.length - 1

  return (
    <SliderPrimitive.Root
      className={cn(
        'relative flex h-8 w-full touch-none select-none items-center',
        className,
      )}
      min={0}
      max={lastIndex}
      step={1}
      value={[index]}
      onValueChange={([next]) => {
        const step = steps[next]
        if (step && step.id !== value) onValueChange(step.id)
      }}
    >
      <SliderPrimitive.Track className="relative h-8 w-full grow overflow-hidden rounded-full bg-content-muted/25">
        <SliderPrimitive.Range className="absolute h-full bg-brand-accent-light" />
        <div
          className="pointer-events-none absolute inset-y-0 flex items-center justify-between"
          style={{ left: '1rem', right: '1rem' }}
          aria-hidden="true"
        >
          {steps.map((step, i) => (
            <span
              key={step.id}
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                i <= index ? 'bg-white/60' : 'bg-content-muted/70',
              )}
            />
          ))}
        </div>
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        className="block h-7 w-7 rounded-full bg-white shadow-md ring-offset-surface-chat transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent-light focus-visible:ring-offset-2"
        aria-label={ariaLabel}
        aria-valuetext={steps[index]?.label}
      />
    </SliderPrimitive.Root>
  )
}
