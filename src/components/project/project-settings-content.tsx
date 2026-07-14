'use client'

import { cn } from '@/components/ui/utils'
import { PROJECT_COLORS } from '@/constants/project-colors'
import { CheckIcon, NoSymbolIcon } from '@heroicons/react/24/outline'
import { useCallback, useEffect, useState } from 'react'
import { useProject } from './project-context'

interface ProjectSettingsContentProps {
  isDarkMode: boolean
  modelContextLimit: number
}

export function ProjectSettingsContent({
  isDarkMode,
  modelContextLimit,
}: ProjectSettingsContentProps) {
  const {
    activeProject,
    projectDocuments,
    updateProject,
    loading,
    error,
    getContextUsage,
  } = useProject()

  const [name, setName] = useState(activeProject?.name || '')
  const [description, setDescription] = useState(
    activeProject?.description || '',
  )
  const [systemInstructions, setSystemInstructions] = useState(
    activeProject?.systemInstructions || '',
  )
  const [color, setColor] = useState(activeProject?.color)
  const [saveStatus, setSaveStatus] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle')

  useEffect(() => {
    setName(activeProject?.name || '')
    setDescription(activeProject?.description || '')
    setSystemInstructions(activeProject?.systemInstructions || '')
    setColor(activeProject?.color)
    setSaveStatus('idle')
    // Only reset form when project ID changes, not when individual fields change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.id])

  const contextUsage = getContextUsage(modelContextLimit)
  const usagePercent = Math.min(
    100,
    Math.round((contextUsage.totalUsed / modelContextLimit) * 100),
  )
  const isHighUsage = usagePercent > 70

  const handleSave = useCallback(async () => {
    if (!activeProject) return

    setSaveStatus('saving')
    try {
      await updateProject(activeProject.id, {
        name: name.trim() || 'Untitled Project',
        description: description.trim(),
        systemInstructions: systemInstructions.trim(),
      })
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2000)
    } catch {
      setSaveStatus('error')
    }
  }, [activeProject, name, description, systemInstructions, updateProject])

  const handleColorSelect = useCallback(
    async (nextColor: string | undefined) => {
      if (!activeProject) return

      setColor(nextColor)
      setSaveStatus('saving')
      try {
        await updateProject(activeProject.id, { color: nextColor ?? '' })
        setSaveStatus('saved')
        setTimeout(() => setSaveStatus('idle'), 2000)
      } catch {
        setSaveStatus('error')
      }
    },
    [activeProject, updateProject],
  )

  const handleColorToggle = useCallback(
    (nextColor: string) => {
      handleColorSelect(color === nextColor ? undefined : nextColor)
    },
    [color, handleColorSelect],
  )

  if (!activeProject) return null

  return (
    <div className="space-y-6 p-4">
      {/* Project Name */}
      <div>
        <label
          className={cn(
            'mb-1 block font-aeonik text-sm font-medium',
            'text-content-secondary',
          )}
        >
          Project Name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={handleSave}
          placeholder="Untitled Project"
          className={cn(
            'w-full rounded-md border px-3 py-2 text-sm',
            isDarkMode
              ? 'border-border-strong bg-surface-chat text-content-secondary placeholder:text-content-muted'
              : 'border-border-subtle bg-surface-sidebar text-content-primary placeholder:text-content-muted',
            'focus:outline-none',
          )}
        />
      </div>

      {/* Project Description */}
      <div>
        <label
          className={cn(
            'mb-1 block font-aeonik text-sm font-medium',
            'text-content-secondary',
          )}
        >
          Description
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={handleSave}
          placeholder="Brief description of the project..."
          rows={2}
          className={cn(
            'w-full resize-none rounded-md border px-3 py-2 text-sm',
            isDarkMode
              ? 'border-border-strong bg-surface-chat text-content-secondary placeholder:text-content-muted'
              : 'border-border-subtle bg-surface-sidebar text-content-primary placeholder:text-content-muted',
            'focus:outline-none',
          )}
        />
      </div>

      {/* Project Color */}
      <div>
        <label
          className={cn(
            'mb-1 block font-aeonik text-sm font-medium',
            'text-content-secondary',
          )}
        >
          Color
        </label>
        <p className="mb-2 font-aeonik-fono text-xs text-content-muted">
          Tints the project labels and sidebar
        </p>
        <div className="flex flex-wrap gap-2">
          {PROJECT_COLORS.map((projectColor) => {
            const isSelected = color === projectColor.id
            return (
              <button
                key={projectColor.id}
                type="button"
                onClick={() => handleColorToggle(projectColor.id)}
                title={projectColor.label}
                aria-label={projectColor.label}
                aria-pressed={isSelected}
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-full ring-offset-2 transition-transform hover:scale-110 focus:outline-none',
                  isDarkMode
                    ? 'ring-offset-surface-chat'
                    : 'ring-offset-surface-sidebar',
                  isSelected && 'ring-2 ring-content-primary',
                )}
                style={{ backgroundColor: projectColor.hex }}
              >
                {isSelected && <CheckIcon className="h-4 w-4 text-black/70" />}
              </button>
            )
          })}
          <button
            type="button"
            onClick={() => handleColorSelect(undefined)}
            title="No color"
            aria-label="No color"
            aria-pressed={!color}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-full border border-border-strong text-content-muted ring-offset-2 transition-transform hover:scale-110 focus:outline-none',
              isDarkMode
                ? 'ring-offset-surface-chat'
                : 'ring-offset-surface-sidebar',
              !color && 'ring-2 ring-content-primary',
            )}
          >
            <NoSymbolIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* System Instructions */}
      <div>
        <label
          className={cn(
            'mb-1 block font-aeonik text-sm font-medium',
            'text-content-secondary',
          )}
        >
          System Instructions
        </label>
        <p className="mb-2 font-aeonik-fono text-xs text-content-muted">
          Custom instructions for all chats in this project
        </p>
        <textarea
          value={systemInstructions}
          onChange={(e) => setSystemInstructions(e.target.value)}
          onBlur={handleSave}
          placeholder="Enter custom instructions for the AI..."
          rows={6}
          className={cn(
            'w-full resize-none rounded-md border px-3 py-2 font-mono text-sm',
            isDarkMode
              ? 'border-border-strong bg-surface-chat text-content-secondary placeholder:text-content-muted'
              : 'border-border-subtle bg-surface-sidebar text-content-primary placeholder:text-content-muted',
            'focus:outline-none',
          )}
        />
      </div>

      {/* Context Usage */}
      <div
        className={cn(
          'rounded-lg border p-4',
          isDarkMode
            ? 'border-border-strong bg-surface-chat'
            : 'border-border-subtle bg-white',
        )}
      >
        <h4 className="mb-3 font-aeonik text-sm font-medium text-content-secondary">
          Context Usage
        </h4>

        {/* Progress bar */}
        <div className="mb-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-aeonik-fono text-xs text-content-muted">
              {usagePercent}% used
            </span>
            <span className="font-aeonik-fono text-xs text-content-muted">
              {formatTokenCount(contextUsage.totalUsed)} /{' '}
              {formatTokenCount(modelContextLimit)}
            </span>
          </div>
          <div
            className={cn(
              'h-2 overflow-hidden rounded-full',
              isDarkMode ? 'bg-surface-sidebar' : 'bg-surface-sidebar',
            )}
          >
            <div
              className={cn(
                'h-full rounded-full transition-all',
                isHighUsage
                  ? 'bg-amber-500'
                  : isDarkMode
                    ? 'bg-emerald-500'
                    : 'bg-emerald-600',
              )}
              style={{ width: `${usagePercent}%` }}
            />
          </div>
        </div>

        {/* Breakdown */}
        <div className="space-y-2 text-xs">
          <div className="flex justify-between">
            <span className="text-content-muted">System Instructions</span>
            <span className="font-aeonik-fono text-content-secondary">
              {formatTokenCount(contextUsage.systemInstructions)} tokens
            </span>
          </div>

          {contextUsage.documents.length > 0 && (
            <div>
              <div className="flex justify-between">
                <span className="text-content-muted">
                  Documents ({contextUsage.documents.length})
                </span>
                <span className="font-aeonik-fono text-content-secondary">
                  {formatTokenCount(
                    contextUsage.documents.reduce(
                      (sum, d) => sum + d.tokens,
                      0,
                    ),
                  )}{' '}
                  tokens
                </span>
              </div>
              <div className="ml-3 mt-1 space-y-0.5">
                {contextUsage.documents.map((doc) => (
                  <div
                    key={doc.filename}
                    className="flex justify-between text-[10px]"
                  >
                    <span className="truncate text-content-muted">
                      {doc.filename}
                    </span>
                    <span className="ml-2 font-aeonik-fono text-content-muted">
                      {formatTokenCount(doc.tokens)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-between">
            <span className="text-content-muted">Project Memory</span>
            <span className="font-aeonik-fono text-content-secondary">
              {formatTokenCount(contextUsage.memory)} tokens
            </span>
          </div>

          <div className="border-t border-border-subtle pt-2">
            <div className="flex justify-between font-medium">
              <span className="text-content-secondary">Available for chat</span>
              <span
                className={cn(
                  'font-aeonik-fono',
                  isHighUsage
                    ? 'text-amber-500'
                    : isDarkMode
                      ? 'text-emerald-400'
                      : 'text-emerald-600',
                )}
              >
                ~{formatTokenCount(contextUsage.availableForChat)} tokens
              </span>
            </div>
          </div>
        </div>

        {isHighUsage && (
          <div className="mt-3 rounded-md border border-amber-500/20 bg-amber-500/10 p-2">
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Project is using a lot of context. Consider removing some
              documents or reducing system instructions.
            </p>
          </div>
        )}
      </div>

      {/* Project Memory (read-only) */}
      {activeProject.memory && activeProject.memory.length > 0 && (
        <div>
          <label
            className={cn(
              'mb-1 block font-aeonik text-sm font-medium',
              'text-content-secondary',
            )}
          >
            Project Memory
          </label>
          <p className="mb-2 font-aeonik-fono text-xs text-content-muted">
            Facts learned from project conversations
          </p>
          <div
            className={cn(
              'rounded-md border p-3 text-sm',
              isDarkMode
                ? 'border-border-strong bg-surface-chat text-content-secondary'
                : 'border-border-subtle bg-surface-sidebar text-content-primary',
            )}
          >
            {activeProject.memory.map((fact, index) => (
              <div key={index} className="mb-2 last:mb-0">
                - {fact.fact}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Save status */}
      {saveStatus !== 'idle' && (
        <div className="text-center">
          <span
            className={cn(
              'font-aeonik-fono text-xs',
              saveStatus === 'saving' && 'text-content-muted',
              saveStatus === 'saved' && 'text-emerald-500',
              saveStatus === 'error' && 'text-red-500',
            )}
          >
            {saveStatus === 'saving' && 'Saving...'}
            {saveStatus === 'saved' && 'Saved'}
            {saveStatus === 'error' && 'Failed to save'}
          </span>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-500/20 bg-red-500/10 p-3">
          <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}
    </div>
  )
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    return (tokens / 1000).toFixed(1) + 'k'
  }
  return tokens.toLocaleString()
}
