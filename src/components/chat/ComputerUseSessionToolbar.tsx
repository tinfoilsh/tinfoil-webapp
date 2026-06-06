/**
 * Toolbar shared by the live session card and the static history card.
 *
 * Layout (left → center → right):
 *   - Traffic lights — red stops, yellow collapses, green expands/contracts.
 *   - Title block — OS glyph + image name + VM play/pause control + status
 *     label. A bug icon (popover) sits next to the title when errors exist.
 *   - Action icons — terminal toggle, agent activity history, sandbox config.
 */

'use client'

import { cn } from '@/components/ui/utils'
import {
  type CapabilityManifest,
  type LoopEvent,
} from '@/services/computer-use'
import {
  BugAntIcon,
  Cog6ToothIcon,
  CommandLineIcon,
} from '@heroicons/react/24/outline'
import { PauseIcon, PlayIcon } from '@heroicons/react/24/solid'
import { PiRobot } from 'react-icons/pi'
import { OSBadge } from './ComputerUseOSBadge'
import {
  AgentHistoryPopover,
  ConfigPopover,
  ErrorPopover,
  type SessionError,
} from './ComputerUseSessionPopovers'

export type VmStatus = 'running' | 'paused' | 'stopped' | 'error'

interface ToolbarProps {
  imageName?: string
  /** Guest OS — drives the OS glyph rendered to the left of the image name. */
  imageOS?: 'mac' | 'linux'
  /** Lifecycle dot — running, paused (user toggled), stopped, errored. */
  vmStatus: VmStatus
  /** Errors aggregated across the session. The popover auto-opens on first arrival. */
  errors: SessionError[]
  /** All loop events — surfaced in the agent activity popover. */
  frames: LoopEvent[]
  manifest?: CapabilityManifest
  onClose?: () => void
  onMinimize?: () => void
  onExpand?: () => void
  expanded?: boolean
  /** Show + control the embedded terminal. */
  terminalVisible?: boolean
  onToggleTerminal?: () => void
  /**
   * Toggle the VM dispatch pause (the agent's queued tool calls hold until
   * resumed). Live cards wire this; terminal-state cards omit it.
   */
  onTogglePause?: () => void
  /** Lights render at half opacity when true — used by terminal-state cards. */
  disabled?: boolean
}

export function ComputerUseSessionToolbar({
  imageName,
  imageOS,
  vmStatus,
  errors,
  frames,
  manifest,
  onClose,
  onMinimize,
  onExpand,
  expanded,
  terminalVisible,
  onToggleTerminal,
  onTogglePause,
  disabled,
}: ToolbarProps) {
  return (
    <div className="group/lights flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-2">
      <div className="flex items-center gap-1.5">
        <TrafficLight
          color="red"
          symbol="×"
          onClick={onClose}
          disabled={disabled}
          aria-label="Stop session"
        />
        <TrafficLight
          color="yellow"
          symbol="−"
          onClick={onMinimize}
          disabled={disabled}
          aria-label="Minimize session card"
        />
        <TrafficLight
          color="green"
          symbol={expanded ? '↙' : '↗'}
          onClick={onExpand}
          disabled={disabled || !onExpand}
          aria-label={
            expanded ? 'Contract session card' : 'Expand session card'
          }
        />
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-center gap-2 text-sm font-medium text-content-secondary">
        {imageOS && <OSBadge os={imageOS} />}
        {imageName && (
          <span className="truncate text-content-primary" title={imageName}>
            {imageName}
          </span>
        )}
        <span aria-hidden className="text-content-muted">
          ·
        </span>
        <VmStatusControl status={vmStatus} onToggle={onTogglePause} />
        {errors.length > 0 && (
          <ErrorPopover errors={errors}>
            <button
              type="button"
              aria-label={`${errors.length} error${errors.length === 1 ? '' : 's'} — click to view`}
              className="ml-0.5 inline-flex size-5 items-center justify-center rounded-md text-red-500 hover:bg-red-500/10"
            >
              <BugAntIcon className="size-3.5" />
            </button>
          </ErrorPopover>
        )}
      </div>

      <div className="flex items-center gap-1">
        {onToggleTerminal && (
          <button
            type="button"
            aria-label={terminalVisible ? 'Hide terminal' : 'Show terminal'}
            aria-pressed={terminalVisible}
            onClick={onToggleTerminal}
            className={cn(
              'inline-flex size-7 items-center justify-center rounded-md hover:bg-surface-chat hover:text-content-primary',
              terminalVisible
                ? 'bg-surface-chat text-content-primary'
                : 'text-content-secondary',
            )}
          >
            <CommandLineIcon className="size-4" />
          </button>
        )}
        <AgentHistoryPopover frames={frames}>
          <button
            type="button"
            aria-label="Agent activity"
            className="inline-flex size-7 items-center justify-center rounded-md text-content-secondary hover:bg-surface-chat hover:text-content-primary"
          >
            <PiRobot className="size-4" />
          </button>
        </AgentHistoryPopover>
        {manifest && (
          <ConfigPopover manifest={manifest}>
            <button
              type="button"
              aria-label="Sandbox configuration"
              className="inline-flex size-7 items-center justify-center rounded-md text-content-secondary hover:bg-surface-chat hover:text-content-primary"
            >
              <Cog6ToothIcon className="size-4" />
            </button>
          </ConfigPopover>
        )}
      </div>
    </div>
  )
}

/**
 * Transparent play/pause toggle next to the image name. The glyph is the
 * affordance — coloured to match the lifecycle (green = running, amber =
 * paused, red = error, muted = stopped). Hover swaps the glyph to its
 * opposite so the click reads as a toggle.
 */
function VmStatusControl({
  status,
  onToggle,
}: {
  status: VmStatus
  onToggle?: () => void
}) {
  // Per-glyph colour (so Pause is always amber regardless of which side
  // of the toggle surfaces it); container colour is just a fallback for
  // the non-interactive cases.
  const playCls = 'size-3.5 text-green-500'
  const pauseCls = 'size-3.5 text-amber-500'
  const interactive =
    Boolean(onToggle) && (status === 'running' || status === 'paused')
  const Idle = status === 'paused' ? PauseIcon : PlayIcon
  const Hover = status === 'paused' ? PlayIcon : PauseIcon
  const idleCls = status === 'paused' ? pauseCls : playCls
  const hoverCls = status === 'paused' ? playCls : pauseCls
  if (!interactive) {
    const fallback: Record<VmStatus, string> = {
      running: 'text-green-500',
      paused: 'text-amber-500',
      stopped: 'text-content-muted',
      error: 'text-red-500',
    }
    return (
      <span
        aria-hidden
        className={cn(
          'inline-flex items-center justify-center',
          fallback[status],
          status === 'running' && 'animate-pulse',
        )}
      >
        <Idle className="size-3.5" />
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={status === 'paused' ? 'Resume VM' : 'Pause VM'}
      className="group/vm relative inline-flex items-center justify-center"
    >
      <Idle className={cn(idleCls, 'group-hover/vm:opacity-0')} />
      <Hover
        className={cn(
          hoverCls,
          'absolute opacity-0 group-hover/vm:opacity-100',
        )}
      />
    </button>
  )
}

function TrafficLight({
  color,
  symbol,
  onClick,
  disabled,
  'aria-label': ariaLabel,
}: {
  color: 'red' | 'yellow' | 'green'
  symbol: string
  onClick?: () => void
  disabled?: boolean
  'aria-label': string
}) {
  const palette = {
    red: 'bg-[#ff5f57] text-black/70',
    yellow: 'bg-[#febc2e] text-black/70',
    green: 'bg-[#28c840] text-black/70',
  }[color]
  const interactive = !disabled && Boolean(onClick)
  return (
    <button
      type="button"
      onClick={interactive ? onClick : undefined}
      disabled={!interactive}
      aria-label={ariaLabel}
      className={cn(
        'relative inline-flex size-3 items-center justify-center rounded-full',
        palette,
        interactive
          ? 'cursor-pointer hover:brightness-95'
          : 'cursor-default opacity-50',
      )}
    >
      {interactive && (
        <span
          aria-hidden
          className="pointer-events-none text-[10px] font-bold leading-none opacity-0 group-hover/lights:opacity-100"
        >
          {symbol}
        </span>
      )}
    </button>
  )
}
