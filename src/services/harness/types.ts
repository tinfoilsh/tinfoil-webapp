import type { components } from './openapi'

// The harness's wire types, as harness-protocol/openapi.yaml describes them,
// under the names this client uses.
type Schemas = components['schemas']

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json }
export type RecordValue = { [key: string]: Json }

export type ErrorCode = Schemas['ErrorCode']
export type ErrorAction = Schemas['ErrorAction']

// The codes of errors this client meets on its own, which the harness never
// sends.
export type ClientErrorCode =
  | 'CONFIGURATION'
  | 'CONNECTION'
  | 'INVALID_STREAM'
  | 'STREAM_INTERRUPTED'
  | 'LOCAL_SAVE_FAILED'

// Why a request or run failed: as the harness reports it, or as this client
// met it on its own.
export type HarnessErrorBody = Omit<Schemas['ErrorBody'], 'code'> & {
  code: ErrorCode | ClientErrorCode
}

// An attachment, in the one shape an upload returns, a turn sends, a thread
// stores and a view lists. The harness keeps nothing of an upload, so a turn
// carries an image's bytes; a view leaves out image bytes and page images.
export type AttachmentDescriptor = Schemas['Attachment']
export type ToolDisplay = Schemas['ToolDisplay']
export type Annotation = Schemas['Annotation']

// A tool's output as this client has gathered it from a run's activity
// events.
export type ToolActivity = Partial<Schemas['ToolActivity']> &
  Pick<Schemas['ToolActivity'], 'output'>
export type TimelineBlock = Schemas['Block']

// A message as this client shows it, whose attachments may hold the bytes
// this device keeps for them.
export type Message = Omit<Schemas['MessageView'], 'attachments'> & {
  attachments?: AttachmentDescriptor[]
}

export type ThreadSummary = Schemas['ThreadSummary']

// A chat as this client shows it. One kept on this device has no revision.
export type Thread = Omit<Schemas['ThreadWindow'], 'messages' | 'revision'> & {
  messages: Message[]
  revision?: string
}

export type ThreadMessage = Schemas['MessageRecord']

// A whole chat in the format the harness stores it in sync, a chat on this
// device is kept in, and a device run's final event returns. One this device
// made before its first run has no record version.
export type StoredThread = Omit<Schemas['ThreadRecord'], 'recordVersion'> & {
  recordVersion?: number
}

export type TokenBudget = Schemas['TokenBudget']
export type RateLimit = Schemas['RateLimit']
export type SessionModel = Schemas['SessionModel']
export type Session = Schemas['Session']
export type FileGroup = Schemas['FileGroup']

export type Turn = Schemas['Turn']
export type FollowInput = Schemas['FollowInput']
export type QueueItem = Schemas['QueueItem']

// A run's state as a chat shows it: no chat or quota before the run's first
// snapshot.
export type Snapshot = Omit<
  Schemas['StateSnapshotEvent']['snapshot'],
  'thread' | 'rateLimit'
> & {
  thread: ThreadSummary | null
  rateLimit?: RateLimit
}
export type StatePatch = Schemas['StatePatch']
export type ActivityPatch = Schemas['ActivityPatch']
export type RunMetadata = Schemas['RunMetadata']

// The events of a run's stream, as the harness emits them.
export type HarnessEvent = Schemas['HarnessEvent']

export type TerminalEvent = Extract<
  HarnessEvent,
  { type: 'RUN_FINISHED' | 'RUN_ERROR' }
>

export interface Frame {
  event: HarnessEvent
  id?: number
}

// A shared chat, whose attachments name the key that reads each blob.
export type SharedThread = Schemas['SharedThread']
