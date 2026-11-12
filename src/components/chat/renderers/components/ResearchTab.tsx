import { TfWebSearch } from '@tinfoilsh/tinfoil-icons'

// The tab on the top edge of a question's bubble saying it asked for deep
// research, inset from the bubble's rounded corner.
export function ResearchTab() {
  return (
    <div className="flex justify-end px-4">
      <span className="inline-flex items-center gap-1.5 rounded-t-site-tab bg-surface-message-user/90 px-2.5 py-1 text-xs font-medium text-content-secondary backdrop-blur-sm">
        <TfWebSearch className="h-3 w-3" aria-hidden="true" />
        Deep research
      </span>
    </div>
  )
}
