'use client'

import { cn } from '@/components/ui/utils'
import { useSafeguards } from '@/hooks/use-safeguards'
import { FlagIcon } from '@heroicons/react/24/solid'

interface SafeguardFlagBannerProps {
  chatId: string
  isDarkMode: boolean
  onOpenSettings?: () => void
}

export function SafeguardFlagBanner({
  chatId,
  isDarkMode,
  onOpenSettings,
}: SafeguardFlagBannerProps) {
  const { flaggedChatIds, isPreview } = useSafeguards()
  if (!flaggedChatIds[chatId]) return null

  return (
    <div
      role="alert"
      className={cn(
        'mb-2 flex items-start gap-2 rounded-2xl border px-3 py-2.5 font-aeonik shadow-sm',
        isDarkMode
          ? 'border-red-500/40 bg-red-950/60 text-red-200'
          : 'border-red-300 bg-red-50 text-red-700',
      )}
    >
      <FlagIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">
          {isPreview
            ? 'Local preview: this chat was flagged by a safeguard model.'
            : 'This chat was flagged by a safeguard model.'}
        </p>
        <p className="mt-0.5 text-xs">
          This chat is now read-only. Start a new chat to continue.
        </p>
        {isPreview && (
          <p className="mt-1 text-xs">
            This is a simulated flag. Your account is unaffected.
          </p>
        )}
        {onOpenSettings ? (
          <button
            type="button"
            onClick={onOpenSettings}
            className="mt-2 text-xs font-medium underline underline-offset-2"
          >
            Learn more in Settings → Safeguards
          </button>
        ) : (
          <p className="mt-2 text-xs">Sign in to view Settings → Safeguards.</p>
        )}
      </div>
    </div>
  )
}
