import { ROUTES } from '@/services/harness/protocol'
import { harnessAPI } from '@/services/harness/runtime'

// Transcribes recorded audio. The harness transcribes without the content
// key, so a chat kept on the device can be dictated to while the key is
// locked.
export async function transcribe(audio: File): Promise<string> {
  const { text } = await harnessAPI().upload<{ text: string }>(
    ROUTES.transcriptions,
    audio,
    {},
    { keyless: true },
  )
  return text
}
