import { memo } from 'react'
import { PiSpinner } from 'react-icons/pi'

export const GeneratingTable = memo(function GeneratingTable() {
  return (
    <div className="my-4 flex h-12 items-center gap-2 rounded-lg border border-border-subtle bg-transparent px-4">
      <PiSpinner
        className="h-3.5 w-3.5 animate-spin text-content-primary"
        aria-hidden
      />
      <span className="text-sm font-medium text-content-primary">
        Generating table
      </span>
    </div>
  )
})
