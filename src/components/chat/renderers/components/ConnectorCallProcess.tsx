import type {
  ConnectorCallStatus,
  TimelineConnectorCallBlock,
} from '@/components/chat/types'
import { memo, useId, useState } from 'react'
import { ConnectorIcon } from '../../components/connector-icon'
import { StepDetails, StepHeader } from './WorkStep'

// How a call that did not complete ended, after its name.
const ENDINGS: Partial<Record<ConnectorCallStatus, string>> = {
  failed: 'Failed',
  declined: 'Declined',
  expired: 'Not approved in time',
}

// A call as "<tool> · <connector>".
export const connectorCallName = (call: TimelineConnectorCallBlock) =>
  `${call.title || call.tool} · ${call.connector.name}`

// A call's arguments as indented JSON, or as the model wrote them when they
// are not JSON.
export function shownArguments(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

const DETAIL_CLASS_NAME =
  'max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-muted/60 p-2 font-mono text-xs text-content-primary/70'

export const ConnectorCallProcess = memo(function ConnectorCallProcess({
  call,
  inGroup = false,
}: {
  call: TimelineConnectorCallBlock
  // A step of a group shows its details in the group's box.
  inGroup?: boolean
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const detailsId = useId()
  const ending = call.approval ? 'Waiting for approval' : ENDINGS[call.status]
  return (
    <div>
      <StepHeader
        label={
          <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
            <ConnectorIcon
              url={call.connector.url}
              name={call.connector.name}
              className="h-3.5 w-3.5"
            />
            <span className="truncate font-medium">
              {connectorCallName(call)}
            </span>
            {ending && (
              <span className="shrink-0 text-content-primary/40">
                · {ending}
              </span>
            )}
          </span>
        }
        isRunning={call.status === 'running'}
        startedAt={call.startedAt}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded((open) => !open)}
        detailsId={detailsId}
        truncate
      />
      <StepDetails
        id={detailsId}
        isExpanded={isExpanded}
        inGroup={inGroup}
        boxClassName="px-3 py-2"
      >
        <div className="space-y-2">
          <div className="space-y-1">
            <div className="text-xs font-medium text-content-primary/50">
              Arguments
            </div>
            <pre className={DETAIL_CLASS_NAME}>
              {shownArguments(call.arguments) || '{}'}
            </pre>
          </div>
          {call.output !== undefined && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-content-primary/50">
                Result
              </div>
              <pre className={DETAIL_CLASS_NAME}>{call.output}</pre>
            </div>
          )}
        </div>
      </StepDetails>
    </div>
  )
})
