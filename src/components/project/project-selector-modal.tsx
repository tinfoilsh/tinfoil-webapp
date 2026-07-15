'use client'

import { cn } from '@/components/ui/utils'
import { useProjects } from '@/hooks/use-projects'
import type { Project } from '@/types/project'
import {
  FolderIcon,
  FolderPlusIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useState } from 'react'
import { useProject } from './project-context'

interface ProjectSelectorModalProps {
  isOpen: boolean
  onClose: () => void
  isDarkMode: boolean
}

export function ProjectSelectorModal({
  isOpen,
  onClose,
  isDarkMode,
}: ProjectSelectorModalProps) {
  const {
    projects,
    loading: loadingList,
    hasMore,
    loadMore,
    refresh,
  } = useProjects()
  const {
    createProject,
    enterProjectMode,
    loading: loadingAction,
  } = useProject()
  const [view, setView] = useState<'list' | 'create'>('list')
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectDescription, setNewProjectDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleCreateProject = useCallback(async () => {
    if (!newProjectName.trim()) {
      setError('Project name is required')
      return
    }

    setError(null)
    try {
      const project = await createProject({
        name: newProjectName.trim(),
        description: newProjectDescription.trim(),
      })
      await enterProjectMode(project.id)
      setNewProjectName('')
      setNewProjectDescription('')
      setView('list')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project')
    }
  }, [
    newProjectName,
    newProjectDescription,
    createProject,
    enterProjectMode,
    onClose,
  ])

  const handleSelectProject = useCallback(
    async (project: Project) => {
      try {
        await enterProjectMode(project.id)
        onClose()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to open project')
      }
    },
    [enterProjectMode, onClose],
  )

  const handleClose = useCallback(() => {
    setView('list')
    setNewProjectName('')
    setNewProjectDescription('')
    setError(null)
    onClose()
  }, [onClose])

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/50"
            onClick={handleClose}
          />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2"
          >
            <div
              className={cn(
                'overflow-hidden rounded-xl border shadow-xl',
                isDarkMode
                  ? 'border-border-strong bg-surface-sidebar'
                  : 'border-border-subtle bg-white',
              )}
            >
              {/* Header */}
              <div className="flex items-center justify-between border-b border-border-subtle p-4">
                <h2 className="font-aeonik text-lg font-semibold text-content-primary">
                  {view === 'list' ? 'Projects' : 'New Project'}
                </h2>
                <button
                  onClick={handleClose}
                  className={cn(
                    'rounded-md p-1.5 transition-colors',
                    isDarkMode
                      ? 'text-content-muted hover:bg-surface-chat hover:text-content-secondary'
                      : 'text-content-muted hover:bg-surface-sidebar hover:text-content-secondary',
                  )}
                >
                  <XMarkIcon className="h-5 w-5" />
                </button>
              </div>

              {/* Content */}
              <div className="max-h-96 overflow-y-auto p-4">
                {view === 'list' ? (
                  <>
                    {/* Create new project button */}
                    <button
                      onClick={() => setView('create')}
                      className={cn(
                        'mb-4 flex w-full items-center gap-3 rounded-lg border border-dashed p-4 transition-colors',
                        'hover:border-border-default border-border-subtle text-content-secondary hover:text-content-primary',
                        isDarkMode
                          ? 'hover:bg-surface-chat'
                          : 'hover:bg-surface-sidebar',
                      )}
                    >
                      <FolderPlusIcon className="h-6 w-6" />
                      <span className="font-aeonik font-medium">
                        New Project
                      </span>
                    </button>

                    {/* Projects list */}
                    {loadingList && projects.length === 0 ? (
                      <div className="py-8 text-center">
                        <div className="mx-auto mb-2 h-6 w-6 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
                        <p className="font-aeonik-fono text-sm text-content-muted">
                          Loading projects...
                        </p>
                      </div>
                    ) : projects.length === 0 ? (
                      <div className="py-8 text-center">
                        <FolderIcon className="mx-auto mb-2 h-10 w-10 text-content-muted" />
                        <p className="font-aeonik-fono text-sm text-content-muted">
                          No projects yet
                        </p>
                        <p className="font-aeonik-fono text-xs text-content-muted">
                          Create your first project to get started
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {projects.map((project) => (
                          <button
                            key={project.id}
                            onClick={() => handleSelectProject(project)}
                            disabled={loadingAction}
                            className={cn(
                              'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                              isDarkMode
                                ? 'border-border-strong bg-surface-chat hover:bg-surface-chat/80'
                                : 'border-border-subtle bg-surface-sidebar hover:bg-surface-sidebar/80',
                              loadingAction && 'cursor-not-allowed opacity-50',
                            )}
                          >
                            <FolderIcon
                              className={cn(
                                'mt-0.5 h-5 w-5 flex-shrink-0',
                                isDarkMode
                                  ? 'text-emerald-400'
                                  : 'text-emerald-600',
                              )}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-aeonik font-medium text-content-primary">
                                {project.name}
                              </div>
                              {project.description && (
                                <div className="mt-0.5 truncate font-aeonik-fono text-xs text-content-muted">
                                  {project.description}
                                </div>
                              )}
                              <div className="mt-1 font-aeonik-fono text-[10px] text-content-muted">
                                Updated{' '}
                                {formatRelativeTime(
                                  new Date(project.updatedAt),
                                )}
                              </div>
                            </div>
                          </button>
                        ))}

                        {hasMore && (
                          <button
                            onClick={loadMore}
                            disabled={loadingList}
                            className={cn(
                              'w-full rounded-md py-2 text-center font-aeonik-fono text-xs transition-colors',
                              isDarkMode
                                ? 'text-content-muted hover:text-content-secondary'
                                : 'text-content-muted hover:text-content-secondary',
                              loadingList && 'cursor-not-allowed opacity-50',
                            )}
                          >
                            {loadingList ? 'Loading...' : 'Load more'}
                          </button>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  /* Create project form */
                  <div className="space-y-4">
                    <div>
                      <label className="mb-1 block font-aeonik text-sm font-medium text-content-secondary">
                        Project Name
                      </label>
                      <input
                        type="text"
                        value={newProjectName}
                        onChange={(e) => setNewProjectName(e.target.value)}
                        placeholder="My Project"
                        autoFocus
                        className={cn(
                          'w-full rounded-md border px-3 py-2 text-sm',
                          isDarkMode
                            ? 'border-border-strong bg-surface-chat text-content-secondary placeholder:text-content-muted'
                            : 'border-border-subtle bg-surface-sidebar text-content-primary placeholder:text-content-muted',
                          'focus:outline-none focus:ring-2 focus:ring-emerald-500',
                        )}
                      />
                    </div>

                    <div>
                      <label className="mb-1 block font-aeonik text-sm font-medium text-content-secondary">
                        Description (optional)
                      </label>
                      <textarea
                        value={newProjectDescription}
                        onChange={(e) =>
                          setNewProjectDescription(e.target.value)
                        }
                        placeholder="Brief description..."
                        rows={2}
                        className={cn(
                          'w-full resize-none rounded-md border px-3 py-2 text-sm',
                          isDarkMode
                            ? 'border-border-strong bg-surface-chat text-content-secondary placeholder:text-content-muted'
                            : 'border-border-subtle bg-surface-sidebar text-content-primary placeholder:text-content-muted',
                          'focus:outline-none focus:ring-2 focus:ring-emerald-500',
                        )}
                      />
                    </div>

                    {error && (
                      <div className="rounded-md border border-red-500/20 bg-red-500/10 p-2">
                        <p
                          className={cn(
                            'text-xs',
                            isDarkMode ? 'text-red-400' : 'text-red-600',
                          )}
                        >
                          {error}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="flex items-center justify-end gap-2 border-t border-border-subtle p-4">
                {view === 'create' ? (
                  <>
                    <button
                      onClick={() => {
                        setView('list')
                        setError(null)
                      }}
                      className={cn(
                        'rounded-md px-4 py-2 font-aeonik text-sm font-medium transition-colors',
                        isDarkMode
                          ? 'text-content-secondary hover:bg-surface-chat'
                          : 'text-content-secondary hover:bg-surface-sidebar',
                      )}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleCreateProject}
                      disabled={loadingAction || !newProjectName.trim()}
                      className={cn(
                        'rounded-md px-4 py-2 font-aeonik text-sm font-medium transition-colors',
                        isDarkMode
                          ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                          : 'bg-emerald-600 text-white hover:bg-emerald-700',
                        (loadingAction || !newProjectName.trim()) &&
                          'cursor-not-allowed opacity-50',
                      )}
                    >
                      {loadingAction ? 'Creating...' : 'Create Project'}
                    </button>
                  </>
                ) : (
                  <button
                    onClick={handleClose}
                    className={cn(
                      'rounded-md px-4 py-2 font-aeonik text-sm font-medium transition-colors',
                      isDarkMode
                        ? 'text-content-secondary hover:bg-surface-chat'
                        : 'text-content-secondary hover:bg-surface-sidebar',
                    )}
                  >
                    Close
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

function formatRelativeTime(date: Date): string {
  const now = new Date()
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000)

  if (seconds < 60) return 'just now'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`

  return date.toLocaleDateString()
}
