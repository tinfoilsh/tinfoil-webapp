/**
 * Default inference seam for the computer-use loop: stream a chat completion
 * through the webapp's existing **attested** client (`getTinfoilClient` →
 * `SecureClient`). Inference therefore stays browser↔enclave and attested
 * exactly as the rest of the chat does — the loop adds nothing to that path; it
 * only relays the model's emitted actions to the local driver.
 *
 * Note: unlike `code_execution`, there is no backend-issued token to thread
 * here — execution is browser-mediated, so the access JWT authenticates the
 * *browser to the driver*, not the request to the enclave. The model is given
 * the `computer` tool via `tools`; that's all it needs to emit actions.
 */

import { getTinfoilClient } from '@/services/inference/tinfoil-client'
import type { ChatChunk, StreamChat } from './chat-protocol'

/**
 * Build a {@link StreamChat} bound to a model, backed by the attested client.
 * Tests inject their own `StreamChat` instead of this.
 */
export function createTinfoilStreamChat(modelName: string): StreamChat {
  return async ({ messages, tools, signal }) => {
    const client = await getTinfoilClient()
    // The local ChatMessage/ToolSchema subset is structurally compatible with
    // the SDK's request types; cast at this single boundary.
    const stream = await (client.chat.completions.create as Function)(
      {
        model: modelName,
        messages,
        stream: true,
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
      },
      { signal },
    )
    return stream as AsyncIterable<ChatChunk>
  }
}
