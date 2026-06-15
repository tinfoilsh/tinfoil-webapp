import { cn } from '@/components/ui/utils'
import { Squares2X2Icon } from '@heroicons/react/24/outline'
import { BUILT_IN_PROMPT_PRESETS } from '../prompts/built-in-presets'
import type { PromptPreset } from '../prompts/types'

const SUGGESTION_COUNT = 3

type PromptPresetSuggestionsProps = {
  activePreset: PromptPreset | null
  onSetActive: (presetId: string | null) => void
  onOpenLibrary: () => void
}

export function PromptPresetSuggestions({
  activePreset,
  onSetActive,
  onOpenLibrary,
}: PromptPresetSuggestionsProps) {
  const suggested = BUILT_IN_PROMPT_PRESETS.slice(0, SUGGESTION_COUNT)
  const pillBase =
    'inline-flex h-14 w-full items-center justify-center gap-1.5 rounded-lg border px-3 text-sm transition-colors md:h-auto md:w-auto md:py-1.5'

  const renderSuggestions = () => (
    <>
      {suggested.map((preset) => {
        const Icon = preset.Icon
        const isActive = activePreset?.id === preset.id
        return (
          <button
            type="button"
            key={preset.id}
            onClick={() => onSetActive(isActive ? null : preset.id)}
            aria-pressed={isActive}
            className={cn(
              pillBase,
              isActive
                ? 'border-brand-accent-dark/40 bg-brand-accent-dark/10 text-brand-accent-dark dark:border-brand-accent-light/40 dark:bg-brand-accent-light/10 dark:text-brand-accent-light'
                : 'border-border-subtle bg-surface-chat-background text-content-secondary hover:bg-surface-chat hover:text-content-primary',
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{preset.name}</span>
          </button>
        )
      })}
      <button
        type="button"
        onClick={onOpenLibrary}
        className={cn(
          pillBase,
          'border-border-subtle bg-surface-chat-background text-content-secondary hover:bg-surface-chat hover:text-content-primary',
        )}
      >
        <Squares2X2Icon className="h-3.5 w-3.5" aria-hidden="true" />
        <span>More</span>
      </button>
    </>
  )

  return (
    <>
      <div className="md:hidden">
        <button
          type="button"
          onClick={onOpenLibrary}
          className="flex h-14 w-full items-center justify-center gap-1.5 rounded-lg border border-border-subtle bg-surface-chat-background px-4 text-sm text-content-secondary transition-colors hover:bg-surface-chat hover:text-content-primary"
        >
          <Squares2X2Icon className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Prompts</span>
        </button>
      </div>
      <div className="hidden auto-rows-fr grid-cols-1 gap-2 md:flex md:flex-wrap md:items-center md:justify-center">
        {renderSuggestions()}
      </div>
    </>
  )
}
