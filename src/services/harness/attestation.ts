import { harnessAPI } from './runtime'

// Verifies the chat service's enclave, which every request does before it
// is sent; the first verification is shared.
export function verifyChatService(): Promise<void> {
  return harnessAPI().client.ready()
}

// The document the chat service's verification produced, for the
// verification center to show.
export async function verificationDocument() {
  const { client } = harnessAPI()
  await client.ready()
  return client.verification
}
