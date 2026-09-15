import { z } from 'zod'

const id = z.string().min(1).max(256)
const date = z.string().datetime({ offset: true })
const optionalString = z.string().optional()
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict()

export const NATIVE_BACKUP_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
] as const
export const NativeBackupImageMimeSchema = z.enum(
  NATIVE_BACKUP_IMAGE_MIME_TYPES,
)

export const NativeBackupJsonSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(NativeBackupJsonSchema),
    z.record(z.string(), NativeBackupJsonSchema),
  ]),
)

const source = strict({
  title: z.string(),
  url: z.string(),
  snippet: optionalString,
})
const search = strict({
  query: optionalString,
  status: z.enum(['searching', 'completed', 'failed', 'blocked']),
  sources: z.array(source).optional(),
  reason: optionalString,
})
const fetchState = strict({
  id,
  url: z.string(),
  status: z.enum(['fetching', 'completed', 'failed']),
  sources: z.array(source).optional(),
})
const citation = strict({
  type: z.literal('url_citation'),
  url_citation: strict({
    title: z.string(),
    url: z.string(),
    start_index: z.number().int().nonnegative().optional(),
    end_index: z.number().int().nonnegative().optional(),
  }),
})
const codeCall = strict({
  id,
  toolName: z.string(),
  arguments: z.record(z.string(), NativeBackupJsonSchema).optional(),
  status: z.enum(['running', 'completed', 'failed']),
  output: optionalString,
})
const timeline = z.discriminatedUnion('type', [
  strict({
    type: z.literal('thinking'),
    id,
    content: z.string(),
    isThinking: z.boolean(),
    duration: z.number().nonnegative().optional(),
  }),
  strict({ type: z.literal('web_search'), id, state: search }),
  strict({
    type: z.literal('url_fetches'),
    id,
    fetches: z.array(fetchState),
  }),
  strict({ type: z.literal('content'), id, content: z.string() }),
  strict({
    type: z.literal('tool_call'),
    id,
    toolCallId: id,
    name: z.string(),
    arguments: z.string(),
    resolvedAt: z.number().finite().optional(),
    resolution: strict({
      text: z.string(),
      data: NativeBackupJsonSchema.optional(),
    }).optional(),
  }),
  strict({ type: z.literal('code_exec'), id, calls: z.array(codeCall) }),
])
const documentPage = strict({
  page: z.number().int().nonnegative(),
  text: z.string(),
  is_scanned: z.boolean(),
  imageId: id.optional(),
})
const attachment = z.discriminatedUnion('type', [
  strict({
    id,
    type: z.literal('document'),
    fileName: z.string(),
    mimeType: optionalString,
    textContent: optionalString,
    description: optionalString,
    fileSize: z.number().int().nonnegative().optional(),
    pages: z.array(documentPage).optional(),
  }),
  strict({ id, type: z.literal('image'), imageId: id }),
])

export const NativeBackupMessageSchema = strict({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  turnId: optionalString,
  modelDisplayName: optionalString,
  attachments: z.array(attachment).optional(),
  documentContent: optionalString,
  multimodalText: optionalString,
  documents: z.array(strict({ name: z.string() })).optional(),
  imageData: z.array(strict({ imageId: id, mimeType: z.string() })).optional(),
  timestamp: date,
  thoughts: optionalString,
  isThinking: z.boolean().optional(),
  thinkingDuration: z.number().nonnegative().optional(),
  isError: z.boolean().optional(),
  isRateLimitError: z.boolean().optional(),
  isHourlyRateLimitError: z.boolean().optional(),
  urlFetches: z.array(fetchState).optional(),
  webSearch: search.optional(),
  webSearchBeforeThinking: z.boolean().optional(),
  annotations: z.array(citation).optional(),
  searchReasoning: optionalString,
  quote: optionalString,
  timeline: z.array(timeline).optional(),
  toolCalls: z
    .array(strict({ id, name: z.string(), arguments: z.string() }))
    .optional(),
  codeExecCalls: z.array(codeCall).optional(),
})

export const NativeBackupProjectSchema = strict({
  id,
  name: z.string(),
  description: z.string(),
  systemInstructions: z.string(),
  color: optionalString,
  memory: z.array(
    strict({
      id,
      fact: z.string(),
      date,
      category: z.string(),
      confidence: z.number().min(0).max(1),
    }),
  ),
  createdAt: date,
  updatedAt: date,
})
export const NativeBackupProjectDocumentSchema = strict({
  id,
  projectId: id,
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  extractedText: z.string(),
  createdAt: date,
  updatedAt: date,
})
export const NativeBackupChatSchema = strict({
  id,
  title: z.string(),
  titleState: z.enum(['placeholder', 'generated', 'manual']).optional(),
  messages: z.array(NativeBackupMessageSchema),
  createdAt: date,
  updatedAt: date,
  projectId: id.nullable().optional(),
  presetId: id.optional(),
  model: optionalString,
  webSearchEnabled: z.boolean().optional(),
})
export const NativeBackupRelationshipsSchema = strict({
  projectChats: z.array(strict({ projectId: id, chatId: id })),
  projectDocuments: z.array(strict({ projectId: id, documentId: id })),
  chatImages: z.array(strict({ chatId: id, imageId: id })),
})
export const NativeBackupImageSchema = strict({
  id,
  chatId: id,
  messageIndex: z.number().int().nonnegative(),
  attachmentId: id.optional(),
  page: z.number().int().nonnegative().optional(),
  legacyIndex: z.number().int().nonnegative().optional(),
  fileName: z.string(),
  mimeType: NativeBackupImageMimeSchema,
  sizeBytes: z.number().int().nonnegative().optional(),
  description: optionalString,
})

export type NativeBackupProject = z.infer<typeof NativeBackupProjectSchema>
export type NativeBackupProjectDocument = z.infer<
  typeof NativeBackupProjectDocumentSchema
>
export type NativeBackupMessage = z.infer<typeof NativeBackupMessageSchema>
export type NativeBackupChat = z.infer<typeof NativeBackupChatSchema>
export type NativeBackupRelationships = z.infer<
  typeof NativeBackupRelationshipsSchema
>
export type NativeBackupImage = z.infer<typeof NativeBackupImageSchema>
