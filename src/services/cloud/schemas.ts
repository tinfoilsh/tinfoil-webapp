/**
 * Runtime schemas for plaintext returned by the sync enclave.
 *
 * The enclave unseals rows server-side and hands back plaintext JSON. Even
 * though that channel is attested, a malformed or tampered row must not be
 * spread/cast straight into app state — a non-array `messages`, a mistyped
 * flag, or a missing required field can crash a load pass or silently alter
 * behavior. These schemas validate the decoded shape before it is persisted
 * or applied. They use `.passthrough()` so unknown fields from a newer client
 * survive a round-trip while the fields we depend on are type-checked.
 */

import { z } from 'zod'

const MessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })
  .passthrough()

export const RemoteChatPlaintextSchema = z
  .object({
    title: z.string().optional(),
    messages: z.array(MessageSchema),
    createdAt: z.union([z.string(), z.number()]).optional(),
    updatedAt: z.union([z.string(), z.number()]).optional(),
    model: z.string().optional(),
    isLocalOnly: z.boolean().optional(),
    isBlankChat: z.boolean().optional(),
    syncVersion: z.number().optional(),
    projectId: z.string().nullable().optional(),
  })
  .passthrough()

export const ProfileDataSchema = z
  .object({
    isDarkMode: z.boolean().optional(),
    themeMode: z.enum(['light', 'dark', 'system']).optional(),
    language: z.string().optional(),
    nickname: z.string().optional(),
    profession: z.string().optional(),
    traits: z.array(z.string()).optional(),
    additionalContext: z.string().optional(),
    isUsingPersonalization: z.boolean().optional(),
    isUsingCustomPrompt: z.boolean().optional(),
    customSystemPrompt: z.string().optional(),
    customPromptPresets: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            description: z.string(),
            systemPrompt: z.string(),
            createdAt: z.number(),
            updatedAt: z.number(),
          })
          .passthrough(),
      )
      .optional(),
    selectedModel: z.string().optional(),
    reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
    thinkingEnabled: z.boolean().optional(),
    webSearchEnabled: z.boolean().optional(),
    codeExecutionEnabled: z.boolean().optional(),
    piiCheckEnabled: z.boolean().optional(),
    chatFont: z.enum(['system', 'serif', 'mono', 'dyslexic']).optional(),
    projectUploadPreference: z.enum(['project', 'chat']).optional(),
    version: z.number().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough()

const FactSchema = z
  .object({
    fact: z.string(),
  })
  .passthrough()

export const ProjectDataSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    systemInstructions: z.string().optional(),
    memory: z.array(FactSchema).optional(),
  })
  .passthrough()

export const ProjectDocumentPlaintextSchema = z
  .object({
    content: z.string(),
    filename: z.string().optional(),
    contentType: z.string().optional(),
  })
  .passthrough()
