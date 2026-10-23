import { ROUTES } from './protocol'
import { harnessAPI } from './runtime'

export interface LinkMetadata {
  title: string | null
  description: string | null
  image: string | null
  siteName: string | null
}

const trimmed = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : null

// An image shows only from a web address.
function webUrl(value: unknown): string | null {
  const url = trimmed(value)
  if (!url) return null
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

// A page's details as a preview shows them, whether its widget stored them
// or they were read later.
export function linkMetadataOf(value: unknown): LinkMetadata {
  const data =
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    title: trimmed(data.title),
    description: trimmed(data.description),
    image: webUrl(data.image),
    siteName: trimmed(data.siteName),
  }
}

// A page's title, description, image and site name, which the harness reads
// inside the enclave.
export async function lookupLinkMetadata(url: string): Promise<LinkMetadata> {
  return linkMetadataOf(
    await harnessAPI().post<unknown>(
      ROUTES.linkMetadata,
      { url },
      { keyless: true },
    ),
  )
}
