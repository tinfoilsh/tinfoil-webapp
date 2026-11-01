import { cn } from '@/components/ui/utils'
import { TfWarning } from '@tinfoilsh/tinfoil-icons'
import { createContext, useContext } from 'react'

// Whether the open chat keeps its images only while the page is open, as a
// signed-out visitor's chat does.
const UnsavedImagesContext = createContext(false)

export const UnsavedImagesProvider = UnsavedImagesContext.Provider

export function useUnsavedImages(): boolean {
  return useContext(UnsavedImagesContext)
}

export function UnsavedImagesNotice({ className }: { className?: string }) {
  return (
    <p
      className={cn(
        'flex w-fit items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-content-secondary',
        className,
      )}
    >
      <TfWarning
        className="h-3.5 w-3.5 flex-shrink-0 !text-amber-500"
        aria-hidden="true"
      />
      Images aren&apos;t saved while you&apos;re signed out.
    </p>
  )
}
