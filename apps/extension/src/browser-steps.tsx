import type { BrowserAction, TimelineBlock } from '@tinfoil/chat-client/types'
import { ThinkingLabel, ThoughtProcess } from '@tinfoil/chat-ui/ThoughtProcess'
import { StepDetails, StepHeader } from '@tinfoil/chat-ui/WorkStep'
import { useId, useState, type ReactNode } from 'react'
import { actionSchema } from './browser/schema'

export const BROWSER_TOOL = 'browser_action'

// What a browser step's header says of it, while it runs and once it ends.
const ACTION_LABELS: Record<
  BrowserAction['action'],
  { running: string; done: string }
> = {
  tabs: { running: 'Checking open tabs', done: 'Checked open tabs' },
  read: { running: 'Reading the page', done: 'Read the page' },
  screenshot: { running: 'Taking a screenshot', done: 'Took a screenshot' },
  click: { running: 'Clicking', done: 'Clicked' },
  hover: { running: 'Pointing at the page', done: 'Pointed at the page' },
  fill: { running: 'Typing', done: 'Typed' },
  select: { running: 'Choosing an option', done: 'Chose an option' },
  press: { running: 'Pressing', done: 'Pressed' },
  scroll: { running: 'Scrolling', done: 'Scrolled' },
  navigate: { running: 'Going to', done: 'Went to' },
  back: { running: 'Going back', done: 'Went back' },
  forward: { running: 'Going forward', done: 'Went forward' },
  open: { running: 'Opening', done: 'Opened' },
  switch: { running: 'Switching tabs', done: 'Switched tabs' },
  close: { running: 'Closing a tab', done: 'Closed a tab' },
  wait: { running: 'Waiting for the page', done: 'Waited for the page' },
}
const UNKNOWN_ACTION = {
  running: 'Using the browser',
  done: 'Used the browser',
}
const ACTION_LIST = new Intl.ListFormat('en', {
  style: 'long',
  type: 'conjunction',
})

export type BrowserStepView = {
  running: string
  done: string
  // What the step acts on, as its header says after the label.
  detail?: string
}

function parsedJSON(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function hostname(url: string | undefined): string | undefined {
  return url && URL.canParse(url)
    ? new URL(url).hostname.replace(/^www\./, '')
    : undefined
}

// A browser step as its header names it, from the arguments of its call.
// Arguments still streaming, or of an action this client does not know, name
// no action.
export function describeBrowserStep(args: string | undefined): BrowserStepView {
  const parsed = actionSchema.safeParse(parsedJSON(args ?? ''))
  if (!parsed.success) return UNKNOWN_ACTION
  const action = parsed.data
  const labels = ACTION_LABELS[action.action]
  const detail =
    action.action === 'navigate' || action.action === 'open'
      ? hostname(action.url)
      : action.action === 'press'
        ? action.key
        : action.action === 'scroll'
          ? action.direction
          : undefined
  return { ...labels, detail }
}

// Why a browser step failed, as the extension answered its call.
export function browserStepFailure(result: unknown): string | undefined {
  const text =
    typeof result === 'object' && result !== null && 'text' in result
      ? result.text
      : undefined
  const answer = typeof text === 'string' ? parsedJSON(text) : undefined
  if (
    typeof answer !== 'object' ||
    answer === null ||
    !('error' in answer) ||
    typeof answer.error !== 'string'
  )
    return undefined
  return 'message' in answer && typeof answer.message === 'string'
    ? answer.message
    : answer.error
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result
  if (
    typeof result === 'object' &&
    result !== null &&
    'text' in result &&
    typeof result.text === 'string'
  )
    return result.text
  return JSON.stringify(result, null, 2)
}

function BrowserStepLabel({
  view,
  running,
  failure,
}: {
  view: BrowserStepView
  running: boolean
  failure?: string
}) {
  return (
    <span>
      <span className="font-medium">{running ? view.running : view.done}</span>
      {view.detail && <span className="font-normal"> {view.detail}</span>}
      {failure && <span className="font-normal"> — {failure}</span>}
    </span>
  )
}

// A browser action the reply took: what it did, and what it saw of the page
// afterwards.
export function BrowserStep({
  block,
  running,
  inGroup = false,
}: {
  block: TimelineBlock
  running: boolean
  // A step of a group shows its details in the group's box.
  inGroup?: boolean
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const detailsId = useId()
  const view = describeBrowserStep(block.arguments)
  const failure = browserStepFailure(block.result)
  const hasResult = block.result !== undefined && !failure
  return (
    <div>
      <StepHeader
        label={
          <BrowserStepLabel view={view} running={running} failure={failure} />
        }
        isRunning={running}
        startedAt={block.startedAt}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded((value) => !value)}
        detailsId={hasResult ? detailsId : undefined}
        labelClassName={failure ? 'text-destructive/80' : undefined}
      />
      {hasResult && (
        <StepDetails id={detailsId} isExpanded={isExpanded} inGroup={inGroup}>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-content-primary/70">
            {resultText(block.result)}
          </pre>
        </StepDetails>
      )}
    </div>
  )
}

export type WorkBlock = {
  block: TimelineBlock
  // The reply is still thinking in this block, or still taking its action.
  running: boolean
}

const actionsNoun = (count: number) =>
  count === 1 ? 'a browser action' : `${count} browser actions`

// What the steps did, in the order each kind first appears, as "Thought and
// took 3 browser actions".
export function describeWork(blocks: WorkBlock[]): string {
  const actions = blocks.filter(
    ({ block }) => block.type === 'tool_call',
  ).length
  const kinds = new Map<string, string>()
  for (const { block } of blocks) {
    if (kinds.has(block.type)) continue
    kinds.set(
      block.type,
      block.type === 'thinking' ? 'thought' : `took ${actionsNoun(actions)}`,
    )
  }
  const description = ACTION_LIST.format(kinds.values())
  return description.charAt(0).toUpperCase() + description.slice(1)
}

function liveLabel(blocks: WorkBlock[], isDarkMode: boolean): ReactNode {
  const last = blocks[blocks.length - 1]
  if (last?.running && last.block.type === 'thinking')
    return <ThinkingLabel summary="" isDarkMode={isDarkMode} />
  if (last?.running)
    return (
      <BrowserStepLabel
        view={describeBrowserStep(last.block.arguments)}
        running
      />
    )
  return <span className="font-medium">Working</span>
}

// Consecutive thinking and browser steps of a reply, behind one row that
// says what the reply is doing while it works, and what it did afterwards.
export function WorkSteps({
  blocks,
  isActive,
  isDarkMode,
}: {
  blocks: WorkBlock[]
  // The reply is still inside this run of steps.
  isActive: boolean
  isDarkMode: boolean
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const detailsId = useId()
  const starts = blocks.flatMap(({ block }) =>
    block.startedAt === undefined ? [] : [block.startedAt],
  )
  return (
    <div>
      <StepHeader
        label={
          isActive ? (
            liveLabel(blocks, isDarkMode)
          ) : (
            <span className="font-medium">{describeWork(blocks)}</span>
          )
        }
        isRunning={isActive}
        startedAt={starts.length > 0 ? Math.min(...starts) : undefined}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded((value) => !value)}
        detailsId={detailsId}
      />
      <StepDetails
        id={detailsId}
        isExpanded={isExpanded}
        boxClassName="divide-y divide-border-subtle"
      >
        {blocks.map(({ block, running }) => (
          <div key={block.id} className="px-3 py-1">
            {block.type === 'thinking' ? (
              <ThoughtProcess
                thoughts={block.content ?? ''}
                isDarkMode={isDarkMode}
                isThinking={running}
                thinkingDuration={block.duration}
                startedAt={block.startedAt}
                inGroup
              />
            ) : (
              <BrowserStep block={block} running={running} inGroup />
            )}
          </div>
        ))}
      </StepDetails>
    </div>
  )
}
