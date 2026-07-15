import * as ToastPrimitives from '@radix-ui/react-toast'
import { cva, type VariantProps } from 'class-variance-authority'
import { X } from 'lucide-react'
import * as React from 'react'

import { cn } from './utils'

export type ToastPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'

const ToastPositionContext = React.createContext<ToastPosition>('bottom-right')

interface ToastProviderProps extends React.ComponentPropsWithoutRef<
  typeof ToastPrimitives.Provider
> {
  position?: ToastPosition
  children: React.ReactNode
}

const ToastProvider = ({
  position = 'bottom-right',
  children,
  ...props
}: ToastProviderProps) => {
  return (
    <ToastPositionContext.Provider value={position}>
      <ToastPrimitives.Provider {...props}>{children}</ToastPrimitives.Provider>
    </ToastPositionContext.Provider>
  )
}

const useToastPosition = () => React.useContext(ToastPositionContext)

const ToastViewport = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Viewport>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Viewport>
>(({ className, ...props }, ref) => {
  const position = useToastPosition()

  const positionClasses = {
    'top-left': 'top-0 left-0 flex-col-reverse',
    'top-center': 'top-0 left-1/2 -translate-x-1/2 flex-col-reverse',
    'top-right': 'top-0 right-0 flex-col-reverse',
    'bottom-left': 'bottom-0 left-0 flex-col',
    'bottom-center': 'bottom-0 left-1/2 -translate-x-1/2 flex-col',
    'bottom-right': 'bottom-0 right-0 flex-col',
  }[position]

  return (
    <ToastPrimitives.Viewport
      ref={ref}
      className={cn(
        'fixed z-[100] flex max-h-screen w-full p-4 md:max-w-[420px]',
        positionClasses,
        className,
      )}
      {...props}
    />
  )
})
ToastViewport.displayName = ToastPrimitives.Viewport.displayName

const TOAST_VARIANTS = cva(
  'group pointer-events-auto relative flex w-full items-center justify-between space-x-4 overflow-hidden rounded-md border p-6 pr-8 shadow-lg transition-all data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[swipe=end]:animate-out data-[state=closed]:fade-out-80',
  {
    variants: {
      variant: {
        default: 'border bg-background text-foreground',
        destructive:
          'destructive group border-destructive bg-destructive text-destructive-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

const Toast = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Root> &
    VariantProps<typeof TOAST_VARIANTS>
>(({ className, variant, ...props }, ref) => {
  const position = useToastPosition()

  const animationClasses = {
    'top-left':
      'data-[state=closed]:slide-out-to-left-full data-[state=open]:slide-in-from-left-full',
    'top-center':
      'data-[state=closed]:slide-out-to-top-full data-[state=open]:slide-in-from-top-full',
    'top-right':
      'data-[state=closed]:slide-out-to-right-full data-[state=open]:slide-in-from-right-full',
    'bottom-left':
      'data-[state=closed]:slide-out-to-left-full data-[state=open]:slide-in-from-left-full',
    'bottom-center':
      'data-[state=closed]:slide-out-to-bottom-full data-[state=open]:slide-in-from-bottom-full',
    'bottom-right':
      'data-[state=closed]:slide-out-to-right-full data-[state=open]:slide-in-from-right-full',
  }[position]

  return (
    <ToastPrimitives.Root
      ref={ref}
      className={cn(TOAST_VARIANTS({ variant }), animationClasses, className)}
      {...props}
    />
  )
})
Toast.displayName = ToastPrimitives.Root.displayName

const ToastAction = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Action>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Action>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Action
    ref={ref}
    className={cn(
      'inline-flex h-8 shrink-0 items-center justify-center rounded-md border bg-transparent px-3 text-sm font-medium transition-colors hover:bg-secondary focus:outline-none focus-visible:ring-1 focus-visible:ring-border-strong disabled:pointer-events-none disabled:opacity-50 group-[.destructive]:border-muted/40 group-[.destructive]:hover:border-destructive/30 group-[.destructive]:hover:bg-destructive group-[.destructive]:hover:text-destructive-foreground group-[.destructive]:focus-visible:ring-destructive',
      className,
    )}
    {...props}
  />
))
ToastAction.displayName = ToastPrimitives.Action.displayName

const ToastClose = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Close>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Close>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Close
    ref={ref}
    className={cn(
      'absolute right-2 top-2 rounded-md p-1 text-foreground/50 opacity-0 transition-opacity hover:text-foreground focus:opacity-100 focus:outline-none focus:ring-2 group-hover:opacity-100 group-[.destructive]:text-red-300 group-[.destructive]:hover:text-red-50 group-[.destructive]:focus:ring-red-400 group-[.destructive]:focus:ring-offset-red-600',
      className,
    )}
    toast-close=""
    {...props}
  >
    <X className="h-4 w-4" />
  </ToastPrimitives.Close>
))
ToastClose.displayName = ToastPrimitives.Close.displayName

const ToastTitle = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Title>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Title>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Title
    ref={ref}
    className={cn('text-sm font-semibold', className)}
    {...props}
  />
))
ToastTitle.displayName = ToastPrimitives.Title.displayName

const ToastDescription = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Description>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Description>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Description
    ref={ref}
    className={cn('text-sm opacity-90', className)}
    {...props}
  />
))
ToastDescription.displayName = ToastPrimitives.Description.displayName

type ToastProps = React.ComponentPropsWithoutRef<typeof Toast>

type ToastActionElement = React.ReactElement<typeof ToastAction>

export {
  Toast,
  ToastAction,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  type ToastActionElement,
  type ToastProps,
}
