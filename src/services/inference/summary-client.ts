import { logError } from '@/utils/error-handling'
import { SecureClient } from 'tinfoil'

const SUMMARIZER_ENCLAVE = 'https://summarizer.tinfoil.sh'
const SUMMARIZER_CONFIG_REPO = 'tinfoilsh/confidential-summarizer'

let cachedClient: SecureClient | null = null

function getClient(): SecureClient {
  if (!cachedClient) {
    cachedClient = new SecureClient({
      enclaveURL: SUMMARIZER_ENCLAVE,
      configRepo: SUMMARIZER_CONFIG_REPO,
    })
  }
  return cachedClient
}

interface SummarizeRequest {
  content: string
  style: 'default' | 'thoughts_summary' | 'title_summary'
}

interface SummarizeResponse {
  summary: string
}

export async function summarize(request: SummarizeRequest): Promise<string> {
  const client = getClient()

  const response = await client.fetch(`${SUMMARIZER_ENCLAVE}/summarize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const errorText = await response.text()
    logError(
      `Summarize request failed with status: ${response.status}`,
      undefined,
      {
        component: 'summary-client',
        action: 'summarize',
        metadata: {
          status: response.status,
          error: errorText,
          style: request.style,
        },
      },
    )
    throw new Error(`Summarize request failed: ${response.status}`)
  }

  const data: SummarizeResponse = await response.json()
  return data.summary
}
