export type PresetEditorState = {
  mode: 'create' | 'edit'
  presetId: string | null
  name: string
  description: string
  systemPrompt: string
}

export const EMPTY_PRESET_EDITOR_STATE: PresetEditorState = {
  mode: 'create',
  presetId: null,
  name: '',
  description: '',
  systemPrompt: '',
}

export const stripSystemTags = (prompt: string): string =>
  prompt
    .replace(/^<system>\s*\n?/, '')
    .replace(/\n?<\/system>\s*$/, '')
    .trim()

export const ensureSystemTags = (prompt: string): string => {
  const trimmed = prompt.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('<system>') && trimmed.endsWith('</system>')) {
    return trimmed
  }
  return `<system>\n${trimmed}\n</system>`
}

type PresetEditorProps = {
  editor: PresetEditorState
  onChange: (editor: PresetEditorState) => void
  onCancel: () => void
  onSave: () => void
}

export function PresetEditor({
  editor,
  onChange,
  onCancel,
  onSave,
}: PresetEditorProps) {
  const canSave =
    editor.name.trim().length > 0 && editor.systemPrompt.trim().length > 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center justify-between gap-4 border-b border-border-subtle px-6 py-4">
        <h3 className="text-base font-semibold text-content-primary">
          {editor.mode === 'create' ? 'New prompt' : 'Edit prompt'}
        </h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-border-subtle bg-surface-chat-background px-3 py-2 text-sm font-medium text-content-primary transition-colors hover:bg-surface-chat"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!canSave}
            className="rounded-lg bg-brand-accent-dark px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-accent-dark/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-content-muted">
            Name
          </span>
          <input
            type="text"
            value={editor.name}
            onChange={(e) => onChange({ ...editor, name: e.target.value })}
            placeholder="e.g. SQL Buddy"
            className="rounded-lg border border-border-subtle bg-surface-chat-background px-3 py-2 text-sm text-content-primary focus:border-brand-accent-dark focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-content-muted">
            Short description
          </span>
          <input
            type="text"
            value={editor.description}
            onChange={(e) =>
              onChange({ ...editor, description: e.target.value })
            }
            placeholder="What does this prompt do?"
            className="rounded-lg border border-border-subtle bg-surface-chat-background px-3 py-2 text-sm text-content-primary focus:border-brand-accent-dark focus:outline-none"
          />
        </label>
        <label className="flex min-h-0 flex-1 flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-content-muted">
            System prompt
          </span>
          <textarea
            value={editor.systemPrompt}
            onChange={(e) =>
              onChange({ ...editor, systemPrompt: e.target.value })
            }
            placeholder="You are a helpful assistant that..."
            className="min-h-[240px] flex-1 resize-y rounded-lg border border-border-subtle bg-surface-chat-background p-3 font-mono text-[13px] text-content-primary focus:border-brand-accent-dark focus:outline-none"
          />
          <span className="text-[11px] text-content-muted">
            Placeholders supported: {`{USER_PREFERENCES}`}, {`{LANGUAGE}`},{' '}
            {`{TIMEZONE}`}. The current time is always provided to the model
            automatically.
          </span>
        </label>
      </div>
    </div>
  )
}
