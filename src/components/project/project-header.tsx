'use client'

import { cn } from '@/components/ui/utils'
import { ArrowLeftIcon } from '@heroicons/react/24/outline'
import { TfFolder, TfSetting } from '@tinfoilsh/tinfoil-icons'
import { useProject } from './project-context'

interface ProjectHeaderProps {
  isDarkMode: boolean
  onSettingsClick: () => void
}

export function ProjectHeader({
  isDarkMode,
  onSettingsClick,
}: ProjectHeaderProps) {
  const { activeProject, exitProjectMode } = useProject()

  if (!activeProject) return null

  return (
    <div
      className={cn(
        'flex h-12 flex-none items-center justify-between border-b px-4',
        isDarkMode
          ? 'border-brand-accent-light/30 bg-brand-accent-dark/20'
          : 'border-brand-accent-dark/30 bg-brand-accent-light/10',
      )}
    >
      <div className="flex items-center gap-3">
        <button
          onClick={exitProjectMode}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors',
            isDarkMode
              ? 'text-content-secondary hover:bg-surface-chat hover:text-content-primary'
              : 'text-content-secondary hover:bg-surface-sidebar hover:text-content-primary',
          )}
          title="Exit project mode"
        >
          <ArrowLeftIcon className="h-4 w-4" />
          <span className="hidden sm:inline">Exit</span>
        </button>

        <div className="h-5 w-px bg-border-subtle" />

        <div className="flex items-center gap-2">
          <TfFolder
            className={cn(
              'h-5 w-5',
              isDarkMode
                ? '!text-brand-accent-light'
                : '!text-brand-accent-dark',
            )}
            aria-hidden="true"
          />
          <span
            className={cn(
              'font-aeonik text-sm font-medium',
              isDarkMode ? 'text-brand-accent-light' : 'text-brand-accent-dark',
            )}
          >
            {activeProject.name}
          </span>
        </div>
      </div>

      <button
        onClick={onSettingsClick}
        className={cn(
          'rounded-md p-1.5 transition-colors',
          isDarkMode
            ? 'text-content-secondary hover:bg-surface-chat hover:text-content-primary'
            : 'text-content-secondary hover:bg-surface-sidebar hover:text-content-primary',
        )}
        title="Project settings"
      >
        <TfSetting className="h-5 w-5" aria-hidden="true" />
      </button>
    </div>
  )
}
