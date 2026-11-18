import { ROUTES } from './protocol'
import type { HarnessAPI } from './runtime'
import type { Artifact, ArtifactPage, OpenedArtifact } from './types'

// The artifacts the replies in the account's stored chats drew, which the
// harness reads from the chats themselves. It lists none of a chat kept on
// this device.

// What tells one artifact from another: its chat, the reply that drew it and
// the call it was drawn with.
export const artifactKey = ({
  threadId,
  messageId,
  toolCallId,
}: Pick<Artifact, 'threadId' | 'messageId' | 'toolCallId'>) =>
  JSON.stringify([threadId, messageId, toolCallId])

// A page of the artifacts of every stored chat, or of a project's chats: the
// chats in the order the chat list shows them, each chat's artifacts newest
// first. The page after the last has an empty cursor.
export const listArtifacts = (
  api: HarnessAPI,
  { projectId, cursor }: { projectId?: string; cursor?: string },
  signal?: AbortSignal,
) =>
  api.post<ArtifactPage>(
    ROUTES.artifactsList,
    { ...(projectId ? { projectId } : {}), ...(cursor ? { cursor } : {}) },
    { signal },
  )

// The pages read so far with another after them. The harness may list a chat
// again on a later page when the chat list files it again between the two,
// so an artifact already read is left out.
export function withArtifactPage(
  read: readonly Artifact[],
  page: readonly Artifact[],
): Artifact[] {
  const known = new Set(read.map(artifactKey))
  const merged = [...read]
  for (const artifact of page) {
    const key = artifactKey(artifact)
    if (known.has(key)) continue
    known.add(key)
    merged.push(artifact)
  }
  return merged
}

// An artifact with the arguments its reply drew it with, as the chat's
// timeline holds them.
export const getArtifact = (
  api: HarnessAPI,
  { threadId, messageId, toolCallId }: Artifact,
  signal?: AbortSignal,
) =>
  api.post<OpenedArtifact>(
    ROUTES.artifactGet,
    { threadId, messageId, toolCallId },
    { signal },
  )
