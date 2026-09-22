import type { BaseModel } from '@/config/models'
import {
  PRESET_SETTING_UNSET,
  PRESET_SETTING_UNSET_LABEL,
  PRESET_WEB_SEARCH_OFF,
  PRESET_WEB_SEARCH_ON,
  getPresetModelOptions,
  optionToWebSearch,
  webSearchToOption,
  type PresetWebSearchOption,
} from './preset-settings'
import type { PromptPresetSettings } from './types'

export type PresetEditorState = PromptPresetSettings & {
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
  models: BaseModel[]
  onChange: (editor: PresetEditorState) => void
  onCancel: () => void
  onSave: () => void
}

const FIELD_CLASS_NAME =
  'rounded-lg border border-border-subtle bg-surface-chat-background px-3 py-2 text-sm text-content-primary focus:border-brand-accent-dark focus:outline-none'

export function PresetEditor({
  editor,
  models,
  onChange,
  onCancel,
  onSave,
}: PresetEditorProps) {
  const canSave =
    editor.name.trim().length > 0 && editor.systemPrompt.trim().length > 0
  const modelOptions = getPresetModelOptions(models, editor.model)

  const handleModelChange = (value: string) => {
    const next = { ...editor }
    if (value === PRESET_SETTING_UNSET) delete next.model
    else next.model = value
    onChange(next)
  }

  const handleWebSearchChange = (value: PresetWebSearchOption) => {
    const next = { ...editor }
    const webSearchEnabled = optionToWebSearch(value)
    if (webSearchEnabled === undefined) delete next.webSearchEnabled
    else next.webSearchEnabled = webSearchEnabled
    onChange(next)
  }

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
          <span className="text-xs font-semibold text-brand-accent-dark dark:text-brand-accent-light">
            Name
          </span>
          <input
            type="text"
            value={editor.name}
            onChange={(e) => onChange({ ...editor, name: e.target.value })}
            placeholder="e.g. SQL Buddy"
            className={FIELD_CLASS_NAME}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-brand-accent-dark dark:text-brand-accent-light">
            Short description
          </span>
          <input
            type="text"
            value={editor.description}
            onChange={(e) =>
              onChange({ ...editor, description: e.target.value })
            }
            placeholder="What does this prompt do?"
            className={FIELD_CLASS_NAME}
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-brand-accent-dark dark:text-brand-accent-light">
              Model
            </span>
            <select
              value={editor.model ?? PRESET_SETTING_UNSET}
              onChange={(e) => handleModelChange(e.target.value)}
              className={FIELD_CLASS_NAME}
            >
              <option value={PRESET_SETTING_UNSET}>
                {PRESET_SETTING_UNSET_LABEL}
              </option>
              {modelOptions.map((model) => (
                <option key={model.modelName} value={model.modelName}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-brand-accent-dark dark:text-brand-accent-light">
              Web search
            </span>
            <select
              value={webSearchToOption(editor.webSearchEnabled)}
              onChange={(e) =>
                handleWebSearchChange(e.target.value as PresetWebSearchOption)
              }
              className={FIELD_CLASS_NAME}
            >
              <option value={PRESET_SETTING_UNSET}>
                {PRESET_SETTING_UNSET_LABEL}
              </option>
              <option value={PRESET_WEB_SEARCH_ON}>On</option>
              <option value={PRESET_WEB_SEARCH_OFF}>Off</option>
            </select>
          </label>
        </div>
        <span className="-mt-2 text-[11px] text-content-muted">
          Applied to the chat when this prompt is selected. You can still change
          either afterwards.
        </span>
        <label className="flex min-h-0 flex-1 flex-col gap-1">
          <span className="text-xs font-semibold text-brand-accent-dark dark:text-brand-accent-light">
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
