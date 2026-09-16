import { cn } from '@/components/ui/utils'
import { formatFileSize } from '@/utils/format-file-size'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { MacFileIcon } from './components/mac-file-icon'

interface ImportFileListProps {
  files: readonly File[]
  isDarkMode: boolean
  onRemove: (index: number) => void
  onAddMore: () => void
  onImport: () => void
  onCancel: () => void
  importLabel: string
}

/**
 * Files selected for an import, shown before the import starts so the user
 * can confirm the set, drop a wrong file, or add the rest of a split export.
 */
export function ImportFileList({
  files,
  isDarkMode,
  onRemove,
  onAddMore,
  onImport,
  onCancel,
  importLabel,
}: ImportFileListProps) {
  return (
    <div
      className={cn(
        'mt-2 rounded-lg border border-border-subtle p-3',
        isDarkMode ? 'bg-surface-chat' : 'bg-surface-sidebar',
      )}
    >
      <ul className="flex flex-col gap-2">
        {files.map((file, index) => (
          <li
            key={`${file.name}-${file.size}-${file.lastModified}`}
            className={cn(
              'flex items-center gap-3 rounded-lg border border-border-subtle px-3 py-2',
              isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
            )}
          >
            <MacFileIcon
              filename={file.name}
              size={18}
              isDarkMode={isDarkMode}
              compact
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium text-content-primary">
                {file.name}
              </span>
              <span className="font-aeonik-fono text-xs text-content-muted">
                {formatFileSize(file.size)}
              </span>
            </div>
            <button
              type="button"
              onClick={() => onRemove(index)}
              aria-label={`Remove ${file.name}`}
              className="shrink-0 rounded p-1 text-content-muted transition-colors hover:bg-surface-chat-background hover:text-content-primary"
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onAddMore}
          className="rounded-lg px-3 py-2 text-sm font-medium text-content-secondary transition-colors hover:bg-surface-chat-background hover:text-content-primary"
        >
          Add more files
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm font-medium text-content-primary transition-colors hover:bg-surface-chat-background"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onImport}
            className="rounded-lg bg-brand-accent-dark px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-accent-dark/90"
          >
            {importLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
