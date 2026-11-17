import type { components, operations } from './openapi'

// The harness's wire types, as harness-protocol/openapi.yaml describes them,
// under the names this client uses.
type Schemas = components['schemas']
type ProfileUpdate =
  operations['profileUpdate']['requestBody']['content']['application/json']
type MessageAnswer =
  operations['messageAnswer']['requestBody']['content']['application/json']

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
  | 'INVALID_RESPONSE'
  | 'STREAM_INTERRUPTED'
  | 'LOCAL_SAVE_FAILED'
  | 'LOCAL_CHAT_UNREADABLE'
  | 'PROFILE_LOADING'
  | 'SIGN_IN_UNCONFIRMED'

// Why a request or run failed: as the harness reports it, or as this client
// met it on its own.
export type HarnessErrorBody = Omit<Schemas['ErrorBody'], 'code'> & {
  code: ErrorCode | ClientErrorCode
}

// An attachment, in the one shape an upload returns, a turn sends, a thread
// stores and a view lists. The harness keeps nothing of an upload but, for a
// stored chat, the file as it was uploaded, which `original` names and the
// turn sends back; so a turn carries an image's bytes. A view leaves out
// image bytes and page images.
export type AttachmentDescriptor = Schemas['Attachment']
export type ToolDisplay = Schemas['ToolDisplay']
export type Annotation = Schemas['Annotation']

// A tool's output as this client has gathered it from a run's activity
// events.
export type ToolActivity = Partial<Schemas['ToolActivity']> &
  Pick<Schemas['ToolActivity'], 'output'>
export type TimelineBlock = Schemas['Block']

// The options the user picked in a questions widget, by question id; what a
// question sent the model of them; and the change a save makes to them.
export type SavedAnswers = NonNullable<TimelineBlock['answers']>
export type WidgetAnswers = Schemas['WidgetAnswers']
export type AnswerChanges = MessageAnswer['answers']

// An attachment of a message as this client shows it. A device chat's may
// hold the bytes this device keeps for it, and a stored chat's says whether
// the harness keeps the file as it was uploaded.
export type MessageAttachment = AttachmentDescriptor &
  Pick<
    Schemas['AttachmentView'],
    'hasOriginal' | 'originalFileName' | 'originalMimeType'
  >

// A message as this client shows it, whose attachments may hold the bytes
// this device keeps for them.
export type Message = Omit<Schemas['MessageView'], 'attachments'> & {
  attachments?: MessageAttachment[]
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

// Changes to saved prompts and favorites by id, which the harness applies to
// the profile as it stores it.
export type PromptEdits = Pick<
  ProfileUpdate,
  | 'savePromptPresets'
  | 'updatePromptPresets'
  | 'deletePromptPresetIds'
  | 'addFavoritePromptPresetIds'
  | 'removeFavoritePromptPresetIds'
>
export type PresetUpdate = Schemas['PresetUpdate']

export type TokenBudget = Schemas['TokenBudget']
export type RateLimit = Schemas['RateLimit']
export type SessionModel = Schemas['SessionModel']
export type Session = Schemas['Session']
export type RemoteImage = Schemas['RemoteImage']
export type FileGroup = Schemas['FileGroup']
export type KeyOrigin = Schemas['KeyOrigin']

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

// A project's document as the harness stores it.
export type StoredProjectDocument = Schemas['ProjectDocument']

// An artifact a reply in a stored chat drew, as a list names it, without its
// source; a page of them; and one opened, with the arguments its reply drew
// it with.
export type Artifact = Schemas['Artifact']
export type ArtifactPage =
  operations['artifactsList']['responses'][200]['content']['application/json']
export type OpenedArtifact =
  operations['artifactGet']['responses'][200]['content']['application/json']
