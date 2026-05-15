import type { ToolCallState } from '@/components/chat/types'
import { memo, useMemo, useState } from 'react'
import { PiSpinner } from 'react-icons/pi'

interface CodeExecProcessProps {
  calls: ToolCallState[]
}

function getToolLabel(call: ToolCallState): string {
  const name = call.toolName
  const path =
    typeof call.arguments?.path === 'string'
      ? (call.arguments.path as string)
      : null
  const failed = call.status === 'failed'

  switch (name) {
    case 'bash': {
      const cmd = call.arguments?.command
      if (typeof cmd === 'string') {
        const short = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
        if (failed) return `Command failed: \`${short}\``
        return call.status === 'running'
          ? `Running \`${short}\``
          : `Ran \`${short}\``
      }
      if (failed) return 'Command failed'
      return call.status === 'running' ? 'Running command' : 'Ran command'
    }
    case 'view': {
      if (path) {
        if (failed) return `Failed to read \`${path}\``
        return call.status === 'running'
          ? `Reading \`${path}\``
          : `Read \`${path}\``
      }
      if (failed) return 'Failed to read file'
      return call.status === 'running' ? 'Reading file' : 'Read file'
    }
    case 'present': {
      if (path) {
        if (failed) return `Failed to present \`${path}\``
        return call.status === 'running'
          ? `Presenting \`${path}\``
          : `Presented \`${path}\``
      }
      if (failed) return 'Failed to present file'
      return call.status === 'running' ? 'Presenting file' : 'Presented file'
    }
    case 'str_replace': {
      if (path) {
        if (failed) return `Failed to edit \`${path}\``
        return call.status === 'running'
          ? `Editing \`${path}\``
          : `Edited \`${path}\``
      }
      if (failed) return 'Failed to edit file'
      return call.status === 'running' ? 'Editing file' : 'Edited file'
    }
    case 'create': {
      if (path) {
        if (failed) return `Failed to create \`${path}\``
        return call.status === 'running'
          ? `Creating \`${path}\``
          : `Created \`${path}\``
      }
      if (failed) return 'Failed to create file'
      return call.status === 'running' ? 'Creating file' : 'Created file'
    }
    case 'insert': {
      if (path) {
        if (failed) return `Failed to insert into \`${path}\``
        return call.status === 'running'
          ? `Inserting into \`${path}\``
          : `Inserted into \`${path}\``
      }
      if (failed) return 'Failed to insert into file'
      return call.status === 'running'
        ? 'Inserting into file'
        : 'Inserted into file'
    }
    default:
      if (failed) return `${name} failed`
      return call.status === 'running' ? `Running ${name}` : `Ran ${name}`
  }
}

function getHeaderLabel(calls: ToolCallState[]): string {
  if (calls.length === 1) {
    return getToolLabel(calls[0])
  }
  const count = calls.length
  const anyRunning = calls.some((c) => c.status === 'running')
  if (anyRunning) {
    return `Running ${count} tools`
  }
  const failedCount = calls.reduce(
    (n, c) => (c.status === 'failed' ? n + 1 : n),
    0,
  )
  if (failedCount > 0) {
    return `Ran ${count} tools (${failedCount} failed)`
  }
  return `Ran ${count} tools`
}

function getDisplayContent(call: ToolCallState): string | null {
  // Failed editor tools: file_text would be misleading (action didn't happen).
  if (
    call.status === 'failed' &&
    (call.toolName === 'create' ||
      call.toolName === 'str_replace' ||
      call.toolName === 'insert' ||
      call.toolName === 'view' ||
      call.toolName === 'present')
  ) {
    return null
  }
  switch (call.toolName) {
    case 'bash':
    case 'view':
    case 'str_replace':
    case 'insert':
      return call.output || null
    case 'present':
      // Also emitted as inline assistant content — avoid duplication.
      return null
    case 'create':
      return (
        (typeof call.arguments?.file_text === 'string'
          ? call.arguments.file_text
          : null) ||
        call.output ||
        null
      )
    default:
      return call.output || null
  }
}

function ToolCallRow({ call }: { call: ToolCallState }) {
  const label = getToolLabel(call)
  const isBash = call.toolName === 'bash'
  const isFailed = call.status === 'failed'
  const displayContent =
    call.status !== 'running' ? getDisplayContent(call) : null

  return (
    <div className="flex flex-col gap-1">
      <div
        className={`flex items-start gap-2 text-sm ${isFailed ? 'text-destructive/80' : 'text-content-primary/70'}`}
      >
        {call.status === 'running' ? (
          <PiSpinner className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-content-primary/50" />
        ) : isFailed ? (
          <span className="mt-0.5 h-3.5 w-3.5 shrink-0 text-center text-xs text-destructive">
            !
          </span>
        ) : (
          <svg
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-content-primary/40"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 13l4 4L19 7"
            />
          </svg>
        )}
        <span className="min-w-0 font-medium">{label}</span>
      </div>
      {displayContent && (
        <pre
          className={`ml-6 max-h-60 overflow-auto rounded-md px-3 py-2 text-xs leading-relaxed ${
            isBash
              ? 'bg-surface-chat-background font-mono text-content-primary/70'
              : 'bg-surface-chat-background text-content-primary/70'
          } ${isFailed ? 'border border-destructive/30' : ''}`}
        >
          {displayContent}
        </pre>
      )}
    </div>
  )
}

export const CodeExecProcess = memo(function CodeExecProcess({
  calls,
}: CodeExecProcessProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const anyRunning = useMemo(
    () => calls.some((c) => c.status === 'running'),
    [calls],
  )
  const allFailed = useMemo(
    () => calls.length > 0 && calls.every((c) => c.status === 'failed'),
    [calls],
  )
  const headerLabel = useMemo(() => getHeaderLabel(calls), [calls])

  if (calls.length === 0) return null

  // Render flat (no chevron) when no call has an expandable body.
  const hasBody = (c: ToolCallState): boolean => {
    if (c.status === 'running') return c.toolName !== 'present'
    return getDisplayContent(c) !== null
  }
  if (!calls.some(hasBody)) {
    return (
      <div className="-mx-1 flex w-full items-start gap-1.5 px-1 py-1">
        <span className="mt-[5px] h-3.5 w-3.5 shrink-0" aria-hidden="true">
          {anyRunning ? (
            <PiSpinner
              className="h-3.5 w-3.5 animate-spin text-content-primary/50"
              aria-hidden="true"
              focusable="false"
            />
          ) : allFailed ? (
            <span className="block h-3.5 w-3.5 text-center text-xs leading-[14px] text-destructive">
              !
            </span>
          ) : null}
        </span>
        <span
          className={`min-w-0 text-base font-medium ${allFailed ? 'text-destructive/80' : 'text-content-primary/50'}`}
        >
          {headerLabel}
        </span>
      </div>
    )
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        className="hover:bg-surface-secondary/50 group -mx-1 flex w-full cursor-pointer items-start gap-1.5 rounded-md px-1 py-1 text-left transition-colors"
      >
        <span className="mt-[5px] h-3.5 w-3.5 shrink-0" aria-hidden="true">
          {anyRunning ? (
            <PiSpinner
              className="h-3.5 w-3.5 animate-spin text-content-primary/50"
              aria-hidden="true"
              focusable="false"
            />
          ) : (
            <svg
              className={`h-3.5 w-3.5 transform text-content-primary/40 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
              focusable="false"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5l7 7-7 7"
              />
            </svg>
          )}
        </span>
        <span
          className={`min-w-0 text-base font-medium ${allFailed ? 'text-destructive/80' : 'text-content-primary/50'}`}
        >
          {headerLabel}
        </span>
      </button>

      <div
        className="grid overflow-hidden transition-[grid-template-rows] duration-300 ease-out"
        style={{ gridTemplateRows: isExpanded ? '1fr' : '0fr' }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="ml-2 flex flex-col gap-2 border-l-2 border-border-subtle py-2 pl-3 pr-1">
            {calls.map((call) => (
              <ToolCallRow key={call.id} call={call} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
})
