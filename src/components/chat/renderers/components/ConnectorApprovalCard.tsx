import { cn } from '@/components/ui/utils'
import { toast } from '@/hooks/use-toast'
import { describeConnectorError } from '@/services/harness/connectors'
import { ERROR_CODES } from '@/services/harness/protocol'
import { HarnessError } from '@/services/harness/sse'
import { logError } from '@/utils/error-handling'
import { createContext, useContext, useState } from 'react'
import { PiSpinner } from 'react-icons/pi'
import { ConnectorIcon } from '../../components/connector-icon'
import type { TimelineConnectorCallBlock } from '../../types'
import { shownArguments } from './ConnectorCallProcess'

// What the open chat lets a reply's calls that wait for the user's approval
// do. Only the run streaming now takes answers; without it, as in a stored
// or shared chat, a call shows how it ended.
export interface ConnectorApproving {
  approve(approvalId: string, approved: boolean): Promise<void>
  // Lets the connector's tool run without asking from now on.
  allowTool(connectorId: string, tool: string): Promise<void>
}

export const ConnectorApprovalsContext =
  createContext<ConnectorApproving | null>(null)

type Choice = 'once' | 'always' | 'decline'

const BUTTON_CLASS_NAME =
  'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50'

// Asks the user whether a connector may run a tool call the reply waits on.
export function ConnectorApprovalCard({
  call,
}: {
  call: TimelineConnectorCallBlock
}) {
  const approving = useContext(ConnectorApprovalsContext)
  const [sending, setSending] = useState<Choice | null>(null)
  // The answer was taken: the reply goes on, and the card leaves once its
  // stream says so.
  const [answered, setAnswered] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { approval } = call
  if (!approving || !approval) return null
  // The harness no longer waits for an answer once the approval expires.
  if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now())
    return null

  const name = call.title || call.tool
  const answer = async (choice: Choice) => {
    setError(null)
    setSending(choice)
    try {
      await approving.approve(approval.id, choice !== 'decline')
      setAnswered(true)
    } catch (cause) {
      // The call was answered already, as from another tab, or no longer
      // waits: the reply's stream shows how it went.
      if (
        cause instanceof HarnessError &&
        cause.code === ERROR_CODES.revisionConflict
      )
        setAnswered(true)
      else setError(describeConnectorError(cause))
      return
    } finally {
      setSending(null)
    }
    if (choice !== 'always') return
    try {
      await approving.allowTool(call.connector.id, call.tool)
    } catch (cause) {
      logError('Failed to always allow a connector tool', cause, {
        component: 'ConnectorApprovalCard',
        action: 'allowTool',
      })
      toast({
        title: `${name} will still ask first`,
        description: describeConnectorError(cause),
        variant: 'destructive',
      })
    }
  }
  const disabled = sending !== null || answered

  return (
    <div
      role="group"
      aria-label={`${call.connector.name} wants to run ${name}`}
      className="space-y-3 rounded-lg border border-border-subtle bg-surface-raised p-3 shadow-sm"
    >
      <div className="flex items-center gap-2">
        <ConnectorIcon url={call.connector.url} name={call.connector.name} />
        <p className="min-w-0 text-sm text-content-primary">
          <span className="font-medium">{call.connector.name}</span> wants to
          run <span className="font-medium">{name}</span>
        </p>
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-muted/60 p-2 font-mono text-xs text-content-primary/70">
        {shownArguments(call.arguments) || '{}'}
      </pre>
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={() => void answer('decline')}
          disabled={disabled}
          className={cn(
            BUTTON_CLASS_NAME,
            'border border-border-subtle text-content-primary hover:bg-surface-chat',
          )}
        >
          {sending === 'decline' && (
            <PiSpinner className="h-3.5 w-3.5 animate-spin" aria-hidden />
          )}
          Decline
        </button>
        <button
          type="button"
          onClick={() => void answer('always')}
          disabled={disabled}
          className={cn(
            BUTTON_CLASS_NAME,
            'border border-border-subtle text-content-primary hover:bg-surface-chat',
          )}
        >
          {sending === 'always' && (
            <PiSpinner className="h-3.5 w-3.5 animate-spin" aria-hidden />
          )}
          Always allow
        </button>
        <button
          type="button"
          onClick={() => void answer('once')}
          disabled={disabled}
          className={cn(
            BUTTON_CLASS_NAME,
            'bg-tinfoil-oak text-brand-dark hover:bg-tinfoil-oak-hover',
          )}
        >
          {sending === 'once' && (
            <PiSpinner className="h-3.5 w-3.5 animate-spin" aria-hidden />
          )}
          Allow once
        </button>
      </div>
    </div>
  )
}
