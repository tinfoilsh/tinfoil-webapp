import { ROUTES } from './protocol'
import { harnessAPI } from './runtime'

export interface LinkMetadata {
  title: string | null
  description: string | null
  image: string | null
  siteName: string | null
}

const text = (value: unknown) =>
  typeof value === 'string' && value ? value : null

// A page's title, description, image and site name, which the harness reads
// inside the enclave.
export async function lookupLinkMetadata(url: string): Promise<LinkMetadata> {
  const data = await harnessAPI().post<Record<string, unknown>>(
    ROUTES.linkMetadata,
    { url },
    { keyless: true },
  )
  return {
    title: text(data.title),
    description: text(data.description),
    image: text(data.image),
    siteName: text(data.siteName),
  }
}
