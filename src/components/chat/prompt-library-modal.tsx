import { cn } from '@/components/ui/utils'
import {
  ArrowLeftIcon,
  CheckIcon,
  PencilSquareIcon,
  PlusIcon,
  SparklesIcon,
  Squares2X2Icon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ConfirmDialog } from './components/confirm-dialog'
import { CONSTANTS } from './constants'
import { usePromptLibrary } from './hooks/use-prompt-library'
import {
  EMPTY_PRESET_EDITOR_STATE,
  PresetEditor,
  ensureSystemTags,
  stripSystemTags,
  type PresetEditorState,
} from './prompts/preset-editor'
import type { PromptPreset } from './prompts/types'

type PromptLibraryModalProps = {
  isOpen: boolean
  onClose: () => void
  activePresetId: string | null
  onSelectPreset: (presetId: string | null) => void
  isSidebarOpen?: boolean
  isRightSidebarOpen?: boolean
}

export function PromptLibraryModal({
  isOpen,
  onClose,
  activePresetId,
  onSelectPreset,
  isSidebarOpen = false,
  isRightSidebarOpen = false,
}: PromptLibraryModalProps) {
  const {
    builtInPresets,
    userPresets,
    allPresets,
    createUserPreset,
    updateUserPreset,
    deleteUserPreset,
    duplicatePreset,
  } = usePromptLibrary()

  const [selectedId, setSelectedId] = useState<string | null>(
    activePresetId ?? builtInPresets[0]?.id ?? null,
  )
  const [editor, setEditor] = useState<PresetEditorState | null>(null)
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list')
  const [presetPendingDelete, setPresetPendingDelete] =
    useState<PromptPreset | null>(null)
  const wasOpenRef = useRef(false)

  useEffect(() => {
    if (!isOpen) {
      setEditor(null)
      setMobileView('list')
      wasOpenRef.current = false
      return
    }
    if (!wasOpenRef.current) {
      setSelectedId(activePresetId ?? builtInPresets[0]?.id ?? null)
      setMobileView('list')
      wasOpenRef.current = true
    }
  }, [isOpen, activePresetId, builtInPresets])

  const selectedPreset = useMemo<PromptPreset | null>(() => {
    if (!selectedId) return null
    return allPresets.find((p) => p.id === selectedId) ?? null
  }, [selectedId, allPresets])

  if (!isOpen) return null

  const leftOffset = isSidebarOpen ? CONSTANTS.CHAT_SIDEBAR_WIDTH_PX : 0
  const rightOffset = isRightSidebarOpen
    ? CONSTANTS.SETTINGS_SIDEBAR_WIDTH_PX
    : 0

  const handleUseThis = () => {
    if (!selectedPreset) return
    onSelectPreset(selectedPreset.id)
    onClose()
  }

  const handleClearActive = () => {
    onSelectPreset(null)
    onClose()
  }

  const startCreate = () => {
    setEditor({ ...EMPTY_PRESET_EDITOR_STATE })
    setMobileView('detail')
  }

  const startEdit = (preset: PromptPreset) => {
    setEditor({
      mode: 'edit',
      presetId: preset.id,
      name: preset.name,
      description: preset.description,
      systemPrompt: stripSystemTags(preset.systemPrompt),
    })
    setMobileView('detail')
  }

  const handleDuplicate = (preset: PromptPreset) => {
    const copy = duplicatePreset(preset.id)
    if (copy) {
      setSelectedId(copy.id)
      setEditor({
        mode: 'edit',
        presetId: copy.id,
        name: copy.name,
        description: copy.description,
        systemPrompt: stripSystemTags(copy.systemPrompt),
      })
      setMobileView('detail')
    }
  }

  const handleDelete = (preset: PromptPreset) => {
    if (preset.isBuiltIn) return
    setPresetPendingDelete(preset)
  }

  const handleConfirmDelete = () => {
    const preset = presetPendingDelete
    if (!preset) return
    deleteUserPreset(preset.id)
    if (selectedId === preset.id) {
      setSelectedId(builtInPresets[0]?.id ?? null)
    }
    if (activePresetId === preset.id) {
      onSelectPreset(null)
    }
    setPresetPendingDelete(null)
  }

  const handleRename = (preset: PromptPreset, nextName: string) => {
    if (preset.isBuiltIn) return
    const trimmed = nextName.trim()
    if (!trimmed || trimmed === preset.name) return
    updateUserPreset(preset.id, {
      name: trimmed,
      description: preset.description,
      systemPrompt: preset.systemPrompt,
    })
  }

  const handleEditorSave = () => {
    if (!editor) return
    const name = editor.name.trim()
    if (!name) return
    const promptWithTags = ensureSystemTags(editor.systemPrompt)
    if (!promptWithTags) return

    if (editor.mode === 'create') {
      const created = createUserPreset({
        name,
        description: editor.description.trim(),
        systemPrompt: promptWithTags,
      })
      setSelectedId(created.id)
    } else if (editor.presetId) {
      updateUserPreset(editor.presetId, {
        name,
        description: editor.description.trim(),
        systemPrompt: promptWithTags,
      })
      setSelectedId(editor.presetId)
    }
    setEditor(null)
  }

  const renderPresetCard = (preset: PromptPreset) => {
    const isSelected = selectedId === preset.id
    const isActive = activePresetId === preset.id
    const Icon = preset.Icon
    return (
      <button
        type="button"
        key={preset.id}
        onClick={() => {
          setSelectedId(preset.id)
          setMobileView('detail')
        }}
        className={cn(
          'group relative flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
          isSelected
            ? 'border-brand-accent-dark/40 bg-brand-accent-dark/5 dark:border-brand-accent-light/40 dark:bg-brand-accent-light/5'
            : 'border-border-subtle bg-surface-chat-background hover:bg-surface-chat',
        )}
        aria-pressed={isActive}
      >
        <span className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-md bg-surface-chat text-content-secondary">
          <Icon className="h-4 w-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col pr-5">
          <span className="truncate text-sm font-medium text-content-primary">
            {preset.name}
          </span>
          {preset.description && (
            <span className="mt-0.5 line-clamp-2 text-xs text-content-secondary">
              {preset.description}
            </span>
          )}
        </span>
        {isActive && (
          <CheckIcon
            className="absolute right-2 top-2 h-3.5 w-3.5 text-brand-accent-dark dark:text-brand-accent-light"
            aria-label="Active"
          />
        )}
      </button>
    )
  }

  return (
    <>
      <DialogPrimitive.Root
        open
        onOpenChange={(nextOpen) => {
          if (!nextOpen) onClose()
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <div
            className="fixed inset-0 z-50 flex items-center justify-center"
            style={{ left: `${leftOffset}px`, right: `${rightOffset}px` }}
          >
            <DialogPrimitive.Content
              aria-describedby={undefined}
              onEscapeKeyDown={(e) => {
                if (editor) e.preventDefault()
              }}
              onInteractOutside={(e) => {
                if (editor) e.preventDefault()
              }}
              className="relative z-10 flex h-[85dvh] w-[92vw] max-w-5xl flex-col rounded-xl border border-border-subtle bg-surface-sidebar shadow-xl focus:outline-none"
              style={{
                maxWidth: `min(1024px, calc(92vw - ${leftOffset + rightOffset}px))`,
              }}
            >
              <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3 md:px-6 md:py-4">
                <div className="flex min-w-0 items-center gap-2">
                  {mobileView === 'detail' && (
                    <button
                      type="button"
                      onClick={() => {
                        if (editor) {
                          setEditor(null)
                        }
                        setMobileView('list')
                      }}
                      className="-ml-1 flex h-8 w-8 items-center justify-center rounded-lg text-content-secondary transition-colors hover:bg-surface-chat md:hidden"
                      aria-label="Back to library"
                    >
                      <ArrowLeftIcon className="h-5 w-5" aria-hidden="true" />
                    </button>
                  )}
                  <Squares2X2Icon
                    className="hidden h-5 w-5 text-content-secondary md:block"
                    aria-hidden="true"
                  />
                  <DialogPrimitive.Title className="truncate text-base font-semibold text-content-primary md:text-lg">
                    Prompt Library
                  </DialogPrimitive.Title>
                </div>
                <button
                  onClick={onClose}
                  className="rounded-lg p-1.5 text-content-secondary transition-colors hover:bg-surface-chat"
                  aria-label="Close prompt library"
                >
                  <XMarkIcon className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>

              <div className="flex min-h-0 flex-1 overflow-hidden">
                <div
                  className={cn(
                    'flex min-h-0 w-full flex-none flex-col md:w-[300px] md:border-r md:border-border-subtle',
                    mobileView === 'detail' ? 'hidden md:flex' : 'flex',
                  )}
                >
                  <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-8">
                    <div className="flex items-center justify-between px-4 pt-4">
                      <span className="text-xs font-medium uppercase tracking-wide text-content-muted">
                        Built-in
                      </span>
                    </div>
                    <div className="flex flex-col gap-1.5 px-3 pb-2 pt-2">
                      {builtInPresets.map(renderPresetCard)}
                    </div>

                    <div className="mt-2 flex items-center justify-between px-4 pt-2">
                      <span className="text-xs font-medium uppercase tracking-wide text-content-muted">
                        Your prompts
                      </span>
                      <button
                        type="button"
                        onClick={startCreate}
                        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-content-secondary transition-colors hover:bg-surface-chat hover:text-content-primary"
                      >
                        <PlusIcon className="h-3.5 w-3.5" />
                        New
                      </button>
                    </div>
                    <div className="flex flex-col gap-1.5 px-3 pt-2">
                      {userPresets.length === 0 ? (
                        <p className="px-1 pt-1 text-xs text-content-muted">
                          No custom prompts yet. Click &quot;New&quot; to create
                          one.
                        </p>
                      ) : (
                        userPresets.map(renderPresetCard)
                      )}
                    </div>
                  </div>
                </div>

                <div
                  className={cn(
                    'min-w-0 flex-1 flex-col',
                    mobileView === 'list' ? 'hidden md:flex' : 'flex',
                  )}
                >
                  {editor ? (
                    <PresetEditor
                      editor={editor}
                      onChange={setEditor}
                      onCancel={() => {
                        setEditor(null)
                        setMobileView('list')
                      }}
                      onSave={() => {
                        handleEditorSave()
                        setMobileView('detail')
                      }}
                    />
                  ) : selectedPreset ? (
                    <PresetDetail
                      key={selectedPreset.id}
                      preset={selectedPreset}
                      isActive={activePresetId === selectedPreset.id}
                      onUseThis={handleUseThis}
                      onClearActive={handleClearActive}
                      onEdit={() => startEdit(selectedPreset)}
                      onDuplicate={() => handleDuplicate(selectedPreset)}
                      onDelete={() => handleDelete(selectedPreset)}
                      onRename={(name) => handleRename(selectedPreset, name)}
                    />
                  ) : (
                    <div className="flex flex-1 items-center justify-center p-6">
                      <p className="text-sm text-content-muted">
                        Select a prompt to view its details.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </DialogPrimitive.Content>
          </div>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      <ConfirmDialog
        isOpen={presetPendingDelete !== null}
        title="Delete prompt?"
        description={
          presetPendingDelete
            ? `"${presetPendingDelete.name}" will be permanently removed. This cannot be undone.`
            : undefined
        }
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleConfirmDelete}
        onCancel={() => setPresetPendingDelete(null)}
      />
    </>
  )
}

type PresetDetailProps = {
  preset: PromptPreset
  isActive: boolean
  onUseThis: () => void
  onClearActive: () => void
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
  onRename: (name: string) => void
}

function PresetDetail({
  preset,
  isActive,
  onUseThis,
  onClearActive,
  onEdit,
  onDuplicate,
  onDelete,
  onRename,
}: PresetDetailProps) {
  const Icon = preset.Icon
  const [isEditingName, setIsEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(preset.name)

  const commitRename = () => {
    setIsEditingName(false)
    const trimmed = nameDraft.trim()
    if (!trimmed || trimmed === preset.name) {
      setNameDraft(preset.name)
      return
    }
    onRename(trimmed)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-start justify-between gap-4 border-b border-border-subtle px-6 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-surface-chat text-content-secondary">
            <Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            {isEditingName && !preset.isBuiltIn ? (
              <input
                type="text"
                value={nameDraft}
                autoFocus
                aria-label="Prompt name"
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    e.currentTarget.blur()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setNameDraft(preset.name)
                    setIsEditingName(false)
                  }
                }}
                className="w-full rounded-md border border-border-subtle bg-surface-chat-background px-2 py-0.5 text-base font-semibold text-content-primary outline-none focus:border-brand-accent-dark/40 dark:focus:border-brand-accent-light/40"
              />
            ) : (
              <h3
                className={cn(
                  'truncate rounded-md px-1.5 py-0.5 text-base font-semibold text-content-primary',
                  !preset.isBuiltIn && 'cursor-text hover:bg-surface-chat',
                )}
                title={preset.isBuiltIn ? undefined : 'Click to rename'}
                role={preset.isBuiltIn ? undefined : 'button'}
                tabIndex={preset.isBuiltIn ? undefined : 0}
                aria-label={preset.isBuiltIn ? undefined : 'Rename prompt'}
                onClick={() => {
                  if (preset.isBuiltIn) return
                  setNameDraft(preset.name)
                  setIsEditingName(true)
                }}
                onKeyDown={(e) => {
                  if (preset.isBuiltIn) return
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setNameDraft(preset.name)
                    setIsEditingName(true)
                  }
                }}
              >
                {preset.name}
              </h3>
            )}
            {preset.description && (
              <p className="mt-0.5 px-1.5 text-sm text-content-secondary">
                {preset.description}
              </p>
            )}
            <span className="mt-1 inline-block px-1.5 text-[11px] uppercase tracking-wide text-content-muted">
              {preset.isBuiltIn ? 'Built-in' : 'Custom'}
            </span>
          </div>
        </div>
        <div className="flex flex-none items-center gap-2">
          {isActive ? (
            <button
              type="button"
              onClick={onClearActive}
              className="rounded-lg border border-border-subtle bg-surface-chat-background px-3 py-2 text-sm font-medium text-content-primary transition-colors hover:bg-surface-chat"
            >
              Stop using
            </button>
          ) : (
            <button
              type="button"
              onClick={onUseThis}
              className="flex items-center gap-1.5 rounded-lg bg-brand-accent-dark px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-accent-dark/90"
            >
              <SparklesIcon className="h-4 w-4" />
              Use for this chat
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-none items-center gap-2 border-b border-border-subtle px-6 py-2">
        {!preset.isBuiltIn && (
          <button
            type="button"
            onClick={onEdit}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-content-secondary transition-colors hover:bg-surface-chat hover:text-content-primary"
          >
            <PencilSquareIcon className="h-3.5 w-3.5" />
            Edit
          </button>
        )}
        <button
          type="button"
          onClick={onDuplicate}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-content-secondary transition-colors hover:bg-surface-chat hover:text-content-primary"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          Duplicate
        </button>
        {!preset.isBuiltIn && (
          <button
            type="button"
            onClick={onDelete}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/10"
          >
            <TrashIcon className="h-3.5 w-3.5" />
            Delete
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
        <span className="mb-2 text-xs font-medium uppercase tracking-wide text-content-muted">
          System prompt
        </span>
        <pre className="flex-1 overflow-auto whitespace-pre-wrap rounded-lg border border-border-subtle bg-surface-chat-background p-4 font-mono text-[13px] text-content-primary">
          {preset.systemPrompt}
        </pre>
      </div>
    </div>
  )
}
