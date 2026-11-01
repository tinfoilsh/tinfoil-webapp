import { ROUTES } from './protocol'
import { harnessAPI } from './runtime'

const FAVICON_TYPE = /^image\//i

// A site's favicon as a data URL, which the harness fetches inside the
// enclave; null when the site has none, or its icon is not an image.
export async function lookupFavicon(url: string): Promise<string | null> {
  const data = await harnessAPI().post<{
    status: string
    favicon_bytes: string
    favicon_content_type: string
  }>(ROUTES.favicon, { url }, { keyless: true })
  if (data.status !== 'found' || !FAVICON_TYPE.test(data.favicon_content_type))
    return null
  return `data:${data.favicon_content_type};base64,${data.favicon_bytes}`
}
