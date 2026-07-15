import { Slot, Slottable } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from './utils'

const BUTTON_VARIANTS = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-strong disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow hover:bg-primary/90',
        solid:
          'border border-brand-accent-dark-darker bg-brand-accent-dark-darker text-white shadow-none hover:border-brand-accent-dark hover:bg-brand-accent-dark',
        destructive:
          'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        outline:
          'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground',
        landingOutline:
          'border border-border-subtle bg-surface-card text-content-primary shadow-none hover:border-content-muted',
        secondary:
          'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'h-9 w-9',
        landingSm:
          'h-auto rounded px-3 py-2.5 font-aeonik-fono text-sm font-medium leading-none tracking-[-0.04em]',
        landing:
          'h-auto rounded px-4 py-3.5 font-aeonik-fono text-sm font-medium leading-none tracking-[-0.04em]',
        landingLg:
          'h-auto rounded px-5 py-5 font-aeonik-fono text-sm font-medium leading-none tracking-[-0.04em]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof BUTTON_VARIANTS> {
  asChild?: boolean
  back?: boolean
  chevron?: boolean
}

function HoverChevron({ back = false }: { back?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block h-3.5 w-3.5 shrink-0 bg-current opacity-0 transition-opacity duration-300 group-hover/button:opacity-100',
        back && '-scale-x-100',
      )}
      style={{
        mask: 'url(/icons/chevron-right.svg) no-repeat center / contain',
        WebkitMask: 'url(/icons/chevron-right.svg) no-repeat center / contain',
      }}
    />
  )
}

const ChevronSpacer = () => <span aria-hidden className="w-3.5 shrink-0" />

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      back = false,
      chevron = false,
      children,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        className={cn(
          BUTTON_VARIANTS({ variant, size, className }),
          chevron && 'group/button',
        )}
        ref={ref}
        {...props}
      >
        {chevron ? (
          <>
            {back ? <HoverChevron back /> : <ChevronSpacer />}
            <Slottable>{children}</Slottable>
            {back ? <ChevronSpacer /> : <HoverChevron />}
          </>
        ) : (
          children
        )}
      </Comp>
    )
  },
)
Button.displayName = 'Button'

export { Button, BUTTON_VARIANTS as buttonVariants }
