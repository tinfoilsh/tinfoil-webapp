'use client'

import { DEFAULT_CHAT_TITLE } from '@/constants/chat'
import { useArtifacts } from '@/hooks/use-artifacts'
import { artifactKey, getArtifact } from '@/services/harness/artifacts'
import { useHarness } from '@/services/harness/provider'
import { HarnessError } from '@/services/harness/sse'
import type { Artifact } from '@/services/harness/types'
import { logError } from '@/utils/error-handling'
import {
  TfChat2,
  TfCode,
  TfDocument,
  TfDocumentWithCode,
  TfLink,
  type IconType,
} from '@tinfoilsh/tinfoil-icons'
import { useEffect, useRef, useState } from 'react'
import { PiSpinner } from 'react-icons/pi'
import { formatRelativeTime } from './chat-list-utils'
import {
  artifactPreviewFromArguments,
  artifactSourceLabel,
  openArtifactPreviewSidebar,
} from './genui/widgets/ArtifactPreview'

const UNTITLED_ARTIFACT = 'Untitled artifact'
const OPEN_FAILED = 'This artifact could not be opened.'
const NOT_PREVIEWABLE =
  'This artifact cannot be previewed here. Open its chat to see it.'

// The icon of each kind of source this client knows.
const SOURCE_ICONS: Record<string, IconType> = {
  url: TfLink,
  html: TfCode,
  markdown: TfDocument,
}

// When the reply that drew an artifact was written, or nothing when the chat
// records no time this client can read.
function createdLabel(createdAt: string): string | null {
  const time = Date.parse(createdAt)
  return Number.isNaN(time) ? null : formatRelativeTime(new Date(time))
}

interface ArtifactListProps {
  // The project whose chats' artifacts are listed. Without one, the
  // artifacts of every stored chat are.
  projectId?: string
  onOpenChat: (threadId: string) => void
  // An artifact opened in the preview panel.
  onOpenArtifact?: () => void
}

/**
 * The artifacts the replies of stored chats drew. A row opens its artifact
 * in the artifact sidebar, as the artifact's card in its chat does, and
 * offers the chat itself.
 */
export function ArtifactList({
  projectId,
  onOpenChat,
  onOpenArtifact,
}: ArtifactListProps) {
  const { api } = useHarness()
  const { artifacts, loading, error, hasMore, loadingMore, loadMore, retry } =
    useArtifacts(projectId)
  // The artifact being opened, and the one that could not be.
  const [opening, setOpening] = useState<string | null>(null)
  const [unopened, setUnopened] = useState<{
    key: string
    message: string
  } | null>(null)
  // Only the artifact asked for last opens.
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])

  const open = async (artifact: Artifact) => {
    const key = artifactKey(artifact)
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setOpening(key)
    setUnopened(null)
    try {
      const opened = await getArtifact(api, artifact, controller.signal)
      if (controller.signal.aborted) return
      const preview = artifactPreviewFromArguments(opened.arguments)
      if (!preview) {
        setUnopened({ key, message: NOT_PREVIEWABLE })
        return
      }
      openArtifactPreviewSidebar(preview, 'open', artifact.toolCallId)
      onOpenArtifact?.()
    } catch (cause) {
      if (controller.signal.aborted) return
      logError('Failed to open an artifact', cause, {
        component: 'ArtifactList',
        action: 'open',
      })
      setUnopened({
        key,
        message: cause instanceof HarnessError ? cause.message : OPEN_FAILED,
      })
    } finally {
      if (request.current === controller) setOpening(null)
    }
  }

  if (loading)
    return (
      <p
        role="status"
        className="flex items-center justify-center gap-2 px-3 py-4 text-sm text-content-muted"
      >
        <PiSpinner className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading artifacts…
      </p>
    )

  const listFailed = !!error && artifacts.length === 0 && !hasMore

  return (
    <div>
      {artifacts.length > 0 && (
        <ul className="space-y-1">
          {artifacts.map((artifact) => {
            const key = artifactKey(artifact)
            const Icon = Object.hasOwn(SOURCE_ICONS, artifact.sourceType)
              ? SOURCE_ICONS[artifact.sourceType]
              : TfDocumentWithCode
            const chatTitle = artifact.threadTitle || DEFAULT_CHAT_TITLE
            const created = createdLabel(artifact.createdAt)
            return (
              <li key={key}>
                <div className="flex items-center gap-1 rounded-md transition-colors hover:bg-surface-chat">
                  <button
                    type="button"
                    onClick={() => void open(artifact)}
                    aria-busy={opening === key || undefined}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
                  >
                    {opening === key ? (
                      <PiSpinner
                        className="h-4 w-4 flex-none animate-spin text-content-muted"
                        aria-hidden="true"
                      />
                    ) : (
                      <Icon
                        className="h-4 w-4 flex-none text-content-muted"
                        aria-hidden="true"
                      />
                    )}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm text-content-primary">
                        {artifact.title || UNTITLED_ARTIFACT}
                      </span>
                      <span className="truncate font-aeonik-fono text-[10px] text-content-muted">
                        {[
                          artifactSourceLabel(artifact.sourceType),
                          chatTitle,
                          created,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenChat(artifact.threadId)}
                    aria-label={`Open the chat ${chatTitle}`}
                    title="Open chat"
                    className="mr-1 flex-none rounded p-1 text-content-muted transition-colors hover:text-content-primary"
                  >
                    <TfChat2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
                {unopened?.key === key && (
                  <p
                    role="alert"
                    className="px-2 pb-1 font-aeonik-fono text-[10px] text-content-muted"
                  >
                    {unopened.message}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {artifacts.length === 0 && !hasMore && !error && (
        <p className="px-3 py-4 text-center text-sm text-content-muted">
          No artifacts yet.
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="px-3 py-2 text-center text-xs text-content-muted"
        >
          {error}
        </p>
      )}
      {listFailed && (
        <div className="flex justify-center pb-2">
          <button
            type="button"
            onClick={retry}
            className="rounded-md border border-border-subtle px-3 py-1 text-xs text-content-secondary transition-colors hover:bg-surface-chat hover:text-content-primary"
          >
            Try again
          </button>
        </div>
      )}
      {hasMore && (
        <button
          type="button"
          disabled={loadingMore}
          onClick={() => void loadMore()}
          className="w-full px-4 py-3 text-xs text-content-secondary hover:text-content-primary disabled:opacity-50"
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}
