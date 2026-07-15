import { cn } from '@/components/ui/utils'
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog'

type ConfirmDialogProps = {
  isOpen: boolean
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'default' | 'destructive'
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  isOpen,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const isDestructive = variant === 'destructive'

  return (
    <AlertDialogPrimitive.Root open={isOpen}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay
          className="fixed inset-0 z-[60] bg-black/60"
          onClick={onCancel}
        />
        <AlertDialogPrimitive.Content
          onEscapeKeyDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          }}
          className="fixed left-1/2 top-1/2 z-[60] w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-site-lg border border-border-subtle bg-surface-sidebar p-5 shadow-xl focus:outline-none"
        >
          <AlertDialogPrimitive.Title className="text-base font-semibold text-content-primary">
            {title}
          </AlertDialogPrimitive.Title>
          {description && (
            <AlertDialogPrimitive.Description className="mt-2 text-sm text-content-secondary">
              {description}
            </AlertDialogPrimitive.Description>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialogPrimitive.Cancel asChild>
              <button
                type="button"
                onClick={onCancel}
                className="rounded-lg border border-border-subtle bg-surface-chat-background px-3 py-2 text-sm font-medium text-content-primary transition-colors hover:bg-surface-chat"
              >
                {cancelLabel}
              </button>
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action asChild>
              <button
                type="button"
                onClick={onConfirm}
                className={cn(
                  'rounded-lg px-3 py-2 text-sm font-semibold text-white transition-colors',
                  isDestructive
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-brand-accent-dark hover:bg-brand-accent-dark/90',
                )}
              >
                {confirmLabel}
              </button>
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  )
}
