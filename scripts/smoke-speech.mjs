import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { TinfoilAI } from 'tinfoil'

// Synthetic input only. Never print credentials, response bodies, or user text.
const CONTROLPLANE = 'https://api.tinfoil.sh'
const MODEL = 'qwen3-tts'
const VOICE = 'aiden'
const SAMPLE_RATE = 24000
const BYTES_PER_SAMPLE = 2
const TIMEOUT_MS = 120000
const INPUTS = [
  'This is the first buffered speech test.',
  'This is the second buffered speech test.',
]

async function measure(client, input) {
  const start = performance.now()
  const response = await client.audio.speech.create(
    {
      model: MODEL,
      voice: VOICE,
      input,
      stream_format: 'audio',
      response_format: 'pcm',
    },
    { signal: AbortSignal.timeout(TIMEOUT_MS), maxRetries: 0 },
  )
  assert.equal(response.headers.get('content-type')?.split(';')[0], 'audio/pcm')
  let bytes = 0
  let chunks = 0
  let firstByteMs = null
  for await (const chunk of response.body) {
    if (!chunk.length) continue
    firstByteMs ??= Math.round(performance.now() - start)
    bytes += chunk.length
    chunks++
  }
  assert.ok(bytes > 0)
  assert.equal(bytes % BYTES_PER_SAMPLE, 0)
  return {
    firstByteMs,
    totalMs: Math.round(performance.now() - start),
    chunks,
    audioSeconds: bytes / (SAMPLE_RATE * BYTES_PER_SAMPLE),
  }
}

async function main() {
  const keyResponse = await fetch(`${CONTROLPLANE}/api/keys/chat`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  assert.equal(keyResponse.status, 200)
  const { key } = await keyResponse.json()
  assert.equal(typeof key, 'string')
  const client = new TinfoilAI({ apiKey: key, transport: 'ehbp' })
  for (const concurrency of [1, 2]) {
    const start = performance.now()
    const results =
      concurrency === 1
        ? [await measure(client, INPUTS[0]), await measure(client, INPUTS[1])]
        : await Promise.all(INPUTS.map((input) => measure(client, input)))
    process.stdout.write(
      `${JSON.stringify({ concurrency, elapsedMs: Math.round(performance.now() - start), results })}\n`,
    )
  }
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({ error: 'Speech smoke test failed', name: error.name, status: error.status })}\n`,
  )
  process.exitCode = 1
})
