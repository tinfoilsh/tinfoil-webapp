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

// Per-unit logical edit clock: `v` is a Lamport counter, `w` the
// writing device id used as a deterministic tiebreak. Passthrough keeps
// any future clock fields written by a newer client intact on round-trip
// instead of silently dropping them.
export const EditClockSchema = z
  .object({
    v: z.number(),
    w: z.string(),
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
    // Per-row edit clock and the row version it was last maintained at.
    // Trusted for conflict arbitration only when clockVersion equals the
    // row's server etag; otherwise a clock-unaware write intervened and
    // callers fall back to updatedAt.
    clock: z.number().optional(),
    writer: z.string().optional(),
    clockVersion: z.number().optional(),
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
    favoritePromptPresetIds: z.array(z.string()).optional(),
    selectedModel: z.string().optional(),
    reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
    thinkingEnabled: z.boolean().optional(),
    webSearchEnabled: z.boolean().optional(),
    codeExecutionEnabled: z.boolean().optional(),
    piiCheckEnabled: z.boolean().optional(),
    genUIEnabled: z.boolean().optional(),
    chatFont: z.enum(['system', 'serif', 'mono', 'dyslexic']).optional(),
    projectUploadPreference: z.enum(['project', 'chat']).optional(),
    version: z.number().optional(),
    updatedAt: z.string().optional(),
    // Per-field edit clocks and the row version they were last
    // maintained at. fieldClocks is trusted for the field-level merge
    // only when clockVersion equals the profile row's server etag.
    fieldClocks: z.record(z.string(), EditClockSchema).optional(),
    clockVersion: z.number().optional(),
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
    color: z.string().optional(),
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
