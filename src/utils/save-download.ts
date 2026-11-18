// How long a saved file's URL is kept for the browser to start reading it.
const DOWNLOAD_URL_LIFETIME_MS = 1000

// Saves a blob as a file, which the browser downloads under the name.
export function saveDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS)
}
