import * as schemas from './schemas'

type Row = Record<string, unknown>
type Cleaner = (value: unknown, index: number) => unknown
export interface NativeBackupImageCandidate {
  sourceKey: string
  chatId: string
  messageIndex: number
  attachmentIndex?: number
  attachmentId?: string
  page?: number
  legacyIndex?: number
  fileName: string
  mimeType: string
  description?: string
}
export type NativeBackupImageCollector = (
  candidate: NativeBackupImageCandidate,
) => string

export class NativeBackupDataValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NativeBackupDataValidationError'
  }
}

function row(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NativeBackupDataValidationError(
      'Native backup records must be objects',
    )
  }
  return value as Row
}
function rows(value: unknown): Row[] {
  if (value === undefined) return []
  if (!Array.isArray(value))
    throw new NativeBackupDataValidationError(
      'Native backup collections must be arrays',
    )
  return value.map(row)
}
const list = (value: unknown, clean: Cleaner) =>
  value === undefined ? undefined : rows(value).map(clean)
const keys = (value: string) => value.split(' ')
const pick = (source: Row, keys: readonly string[]): Row =>
  Object.fromEntries(
    keys
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]]),
  )
const iso = (value: unknown): string => {
  if (
    !(value instanceof Date) &&
    typeof value !== 'string' &&
    typeof value !== 'number'
  )
    throw new NativeBackupDataValidationError('Invalid backup timestamp')
  const parsed =
    value instanceof Date ? value : new Date(value as string | number)
  if (Number.isNaN(parsed.getTime()))
    throw new NativeBackupDataValidationError('Invalid backup timestamp')
  return parsed.toISOString()
}
export function sanitizeNativeBackupProject(value: unknown) {
  const source = row(value)
  return schemas.NativeBackupProjectSchema.parse({
    ...pick(source, keys('id name color')),
    description: source.description ?? '',
    systemInstructions: source.systemInstructions ?? '',
    memory: rows(source.memory).map((value) => {
      const fact = row(value)
      return {
        ...pick(fact, keys('id fact category confidence')),
        date: iso(fact.date),
      }
    }),
    createdAt: iso(source.createdAt),
    updatedAt: iso(source.updatedAt),
  })
}

export function sanitizeNativeBackupProjectDocument(value: unknown) {
  const source = row(value)
  return schemas.NativeBackupProjectDocumentSchema.parse({
    ...pick(source, keys('id projectId filename contentType sizeBytes')),
    extractedText: source.content ?? source.extractedText ?? '',
    createdAt: iso(source.createdAt),
    updatedAt: iso(source.updatedAt),
  })
}

const cleanSource = (value: unknown) =>
  pick(row(value), keys('title url snippet'))
const cleanFetch = (value: unknown) => ({
  ...pick(row(value), keys('id url status')),
  sources: list(row(value).sources, cleanSource),
})
const cleanCodeCall = (value: unknown) =>
  pick(row(value), keys('id toolName arguments status output'))
const cleanSearch = (value: unknown) => {
  const source = row(value)
  return {
    ...pick(source, keys('query status reason')),
    sources: list(source.sources, cleanSource),
  }
}
const cleanCitation = (value: unknown) => {
  const source = row(value)
  return {
    type: source.type,
    url_citation: pick(
      row(source.url_citation),
      keys('title url start_index end_index'),
    ),
  }
}
const timelineFields: Record<string, readonly string[]> = {
  thinking: keys('type id content isThinking duration'),
  web_search: keys('type id'),
  url_fetches: keys('type id'),
  content: keys('type id content'),
  code_exec: keys('type id'),
  tool_call: keys('type id toolCallId name arguments resolvedAt'),
}
function cleanTimeline(value: unknown): unknown {
  const source = row(value)
  const fields = timelineFields[String(source.type)]
  if (!fields)
    throw new NativeBackupDataValidationError(
      'Unsupported native backup timeline block',
    )
  const output = pick(source, fields)
  if (source.type === 'web_search') output.state = cleanSearch(source.state)
  if (source.type === 'url_fetches') {
    output.fetches = rows(source.fetches).map(cleanFetch)
  }
  if (source.type === 'code_exec') {
    output.calls = rows(source.calls).map(cleanCodeCall)
  }
  if (source.type === 'tool_call' && source.resolution !== undefined) {
    output.resolution = pick(row(source.resolution), keys('text data'))
  }
  return output
}

function cleanAttachments(
  value: unknown,
  chatId: string,
  messageIndex: number,
  collectImage: NativeBackupImageCollector,
) {
  return rows(value).map((attachment, attachmentIndex) => {
    const attachmentId = String(attachment.id)
    if (attachment.type === 'image') {
      return {
        ...pick(attachment, keys('id type')),
        imageId: collectImage({
          sourceKey: JSON.stringify([
            'attachment',
            chatId,
            messageIndex,
            attachmentIndex,
            attachmentId,
          ]),
          chatId,
          messageIndex,
          attachmentIndex,
          attachmentId,
          fileName: String(attachment.fileName),
          mimeType: String(attachment.mimeType ?? 'application/octet-stream'),
          description:
            typeof attachment.description === 'string'
              ? attachment.description
              : undefined,
        }),
      }
    }
    return {
      ...pick(
        attachment,
        keys('id type fileName mimeType textContent description fileSize'),
      ),
      pages: list(attachment.pages, (value, pageIndex) => {
        const page = row(value)
        const pageNumber = Number(page.page)
        return {
          ...pick(page, keys('page text is_scanned')),
          imageId: page.image
            ? collectImage({
                sourceKey: JSON.stringify([
                  'page',
                  chatId,
                  messageIndex,
                  attachmentIndex,
                  attachmentId,
                  pageIndex,
                  pageNumber,
                ]),
                chatId,
                messageIndex,
                attachmentIndex,
                attachmentId,
                page: pageNumber,
                fileName: `${attachmentId}-page-${pageNumber}.jpg`,
                mimeType: 'image/jpeg',
              })
            : undefined,
        }
      }),
    }
  })
}

const messageFields = keys(
  'role content turnId modelDisplayName documentContent multimodalText thoughts isThinking thinkingDuration isError isRateLimitError isHourlyRateLimitError webSearchBeforeThinking searchReasoning quote',
)
function cleanMessage(
  value: unknown,
  chatId: string,
  messageIndex: number,
  collectImage: NativeBackupImageCollector,
) {
  const source = row(value)
  return {
    ...pick(source, messageFields),
    attachments:
      source.attachments === undefined
        ? undefined
        : cleanAttachments(
            source.attachments,
            chatId,
            messageIndex,
            collectImage,
          ),
    documents: list(source.documents, (value) =>
      pick(row(value), keys('name')),
    ),
    imageData: list(source.imageData, (value, legacyIndex) => {
      const image = row(value)
      return {
        imageId: collectImage({
          sourceKey: `legacy:${chatId}:${messageIndex}:${legacyIndex}`,
          chatId,
          messageIndex,
          legacyIndex,
          fileName: `legacy-image-${legacyIndex}`,
          mimeType: String(image.mimeType),
        }),
        mimeType: image.mimeType,
      }
    }),
    timestamp: iso(source.timestamp),
    urlFetches: list(source.urlFetches, cleanFetch),
    webSearch:
      source.webSearch === undefined
        ? undefined
        : cleanSearch(source.webSearch),
    annotations: list(source.annotations, cleanCitation),
    timeline: list(source.timeline, cleanTimeline),
    toolCalls: list(source.toolCalls, (value) =>
      pick(row(value), keys('id name arguments')),
    ),
    codeExecCalls: list(source.codeExecCalls, cleanCodeCall),
  }
}

const missingImageCollector: NativeBackupImageCollector = () => {
  throw new NativeBackupDataValidationError(
    'Native backup image collector is required',
  )
}
export function sanitizeNativeBackupChat(
  value: unknown,
  collectImage: NativeBackupImageCollector = missingImageCollector,
) {
  const source = row(value)
  const chatId = String(source.id)
  return schemas.NativeBackupChatSchema.parse({
    ...pick(
      source,
      keys('id title titleState projectId presetId model webSearchEnabled'),
    ),
    messages: rows(source.messages).map((message, index) =>
      cleanMessage(message, chatId, index, collectImage),
    ),
    createdAt: iso(source.createdAt),
    updatedAt: iso(source.updatedAt ?? source.createdAt),
  })
}

export function classifyNativeBackupChat(
  value: unknown,
  owner: 'cloud' | 'signed_in' | 'anonymous',
): 'cloud' | 'local' | null {
  const source = row(value)
  if (source.isTemporary === true || source.isBlankChat === true) return null
  if (owner === 'cloud') return 'cloud'
  return owner === 'signed_in' ? 'local' : null
}

const cleanRelationship = (keys: readonly string[]) => (value: unknown) =>
  pick(row(value), keys)
export function sanitizeNativeBackupRelationships(value: unknown) {
  const source = row(value)
  return schemas.NativeBackupRelationshipsSchema.parse({
    projectChats: rows(source.projectChats).map(
      cleanRelationship(keys('projectId chatId')),
    ),
    projectDocuments: rows(source.projectDocuments).map(
      cleanRelationship(keys('projectId documentId')),
    ),
    chatImages: rows(source.chatImages).map(
      cleanRelationship(keys('chatId imageId')),
    ),
  })
}

export function sanitizeNativeBackupImage(value: unknown) {
  return schemas.NativeBackupImageSchema.parse(
    pick(
      row(value),
      keys(
        'id chatId messageIndex attachmentId page legacyIndex fileName mimeType sizeBytes description',
      ),
    ),
  )
}
