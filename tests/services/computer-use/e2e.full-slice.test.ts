// @vitest-environment node
//
// Full vertical slice E2E — the real thing: pair with the real broker, boot the
// real VM, and drive it with real Kimi K2.6 inference through the agentic loop.
// Boots a VM and spends inference budget, so it's double-gated.
//
//   ./tinfoil-broker up --auto-approve --origin http://127.0.0.1:3000
//   BROKER_E2E_FULL=1 TINFOIL_API_KEY=sk-... \
//     [BROKER_E2E_IMAGE=theo-mac] [BROKER_E2E_OS=mac] \
//     npx vitest run tests/services/computer-use/e2e.full-slice.test.ts
//
// It picks the first ready image from /status unless BROKER_E2E_IMAGE is set,
// runs a short, low-risk task, and logs every loop event (the audit trail).

import { createBrokerConnection } from '@/services/computer-use/access-token'
import { BrokerClient } from '@/services/computer-use/broker-client'
import type {
  ChatChunk,
  StreamChat,
} from '@/services/computer-use/chat-protocol'
import { runComputerUseLoop } from '@/services/computer-use/loop-controller'
import { runPairing } from '@/services/computer-use/pairing'
import type { CapabilityManifest, GuestOS } from '@/services/computer-use/types'
import { describe, expect, it } from 'vitest'

const RUN = process.env.BROKER_E2E_FULL === '1' && !!process.env.TINFOIL_API_KEY
const ORIGIN = process.env.BROKER_E2E_ORIGIN ?? 'http://127.0.0.1:3000'
const BASE = process.env.BROKER_E2E_BASE ?? 'http://127.0.0.1:8765'
const MODEL = process.env.BROKER_E2E_MODEL ?? 'kimi-k2-6'
const INFERENCE_URL =
  process.env.BROKER_E2E_INFERENCE ??
  'https://inference.tinfoil.sh/v1/chat/completions'

function originFetch(origin: string): typeof fetch {
  return ((input: any, init: any = {}) => {
    const headers = new Headers(init.headers as HeadersInit | undefined)
    headers.set('Origin', origin)
    return fetch(input, { ...init, headers })
  }) as typeof fetch
}

/**
 * A real (unattested — fine for a functional test) Tinfoil inference StreamChat:
 * POSTs the chat completion and yields parsed SSE chunks.
 */
function tinfoilStreamChat(apiKey: string, model: string): StreamChat {
  return async function* ({ messages, tools }) {
    const res = await fetch(INFERENCE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 1024,
        messages,
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
      }),
    })
    if (!res.ok || !res.body) {
      throw new Error(`inference HTTP ${res.status}: ${await res.text()}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const data = t.slice(5).trim()
        if (data === '[DONE]') return
        try {
          yield JSON.parse(data) as ChatChunk
        } catch {
          // ignore keep-alives / partials
        }
      }
    }
  }
}

const d = RUN ? describe : describe.skip

d('full-slice E2E (real broker + real VM + real Kimi)', () => {
  it('pairs, boots the VM, and drives a short task to completion', async () => {
    const fetchImpl = originFetch(ORIGIN)
    const probe = new BrokerClient({ baseUrl: BASE, fetchImpl })

    const status = await probe.getStatus()
    const image =
      process.env.BROKER_E2E_IMAGE ?? status.images.find((i) => i.ready)?.name
    expect(image, 'need a ready image (set BROKER_E2E_IMAGE)').toBeTruthy()

    const { refreshCredential } = await runPairing(probe, {
      pollIntervalMs: 300,
      timeoutMs: 20_000,
    })
    const { client, tokens } = createBrokerConnection({
      refreshCredential,
      baseUrl: BASE,
      fetchImpl,
    })

    const manifest: CapabilityManifest = {
      version: 1,
      session: {
        os: (process.env.BROKER_E2E_OS as GuestOS) ?? 'mac',
        image: image!,
        clone: true,
        idle_timeout: '10m',
      },
    }

    const result = await runComputerUseLoop({
      task: 'Take a screenshot and briefly describe what is currently on screen, then stop.',
      manifest,
      broker: client,
      tokens,
      streamChat: tinfoilStreamChat(process.env.TINFOIL_API_KEY!, MODEL),
      modelName: MODEL,
      maxSteps: 4,
      onEvent: (e) => {
        if (e.type === 'model_message') {
          console.log(
            `[model] toolCalls=${e.toolCalls.length} text=${e.content.slice(0, 80)}`,
          )
        } else if (e.type === 'action') {
          console.log(
            `[action] ${e.action.op} ${JSON.stringify(e.action.payload)}`,
          )
        } else if (e.type === 'action_result') {
          console.log(`[result] ${e.action.op} ok`)
        } else if (e.type === 'stopped') {
          console.log(`[stopped] ${e.reason}: ${e.finalText.slice(0, 200)}`)
        } else {
          console.log(`[${e.type}]`)
        }
      },
    })

    expect(['model_finished', 'max_steps', 'handoff']).toContain(result.reason)
    expect(result.steps).toBeGreaterThan(0)
  }, 180_000) // VM boot + several inference round-trips
})
