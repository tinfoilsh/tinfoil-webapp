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
 * A discrete slider with one stop per step. The slim rail meets a green-edged
 * thumb; inset dots follow the thumb's center from the first stop to the last.
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
        'relative flex h-8 w-full cursor-pointer touch-none select-none items-center',
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
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-content-muted/20">
        <SliderPrimitive.Range className="absolute h-full rounded-full bg-brand-accent-light" />
        <div
          className="pointer-events-none absolute inset-x-2.5 inset-y-0 flex items-center justify-between"
          aria-hidden="true"
        >
          {steps.map((step, i) => (
            <span
              key={step.id}
              className={cn(
                'h-1 w-1 shrink-0 rounded-full',
                i <= index ? 'bg-white/70' : 'bg-content-muted/40',
              )}
            />
          ))}
        </div>
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        className="block h-6 w-6 cursor-grab rounded-full border-[3px] border-brand-accent-light bg-white shadow-sm ring-offset-surface-chat transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent-light focus-visible:ring-offset-2 active:cursor-grabbing"
        aria-label={ariaLabel}
        aria-valuetext={steps[index]?.label}
      />
    </SliderPrimitive.Root>
  )
}
