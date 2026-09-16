/**
 * ChatGPT and Claude split large exports into several numbered JSON files
 * (conversations-1.json, conversations-2.json, ...). Each file is a JSON
 * array of the same record type, so the on-device importer reads them all
 * and concatenates the records before parsing.
 */
export async function readExportFiles<T>(
  files: readonly File[],
  formatLabel: string,
): Promise<T[]> {
  const records: T[] = []
  for (const file of files) {
    const text = await file.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`${file.name} is not valid JSON`, { cause: error })
      }
      throw error
    }
    if (!Array.isArray(data)) {
      throw new Error(`${file.name} is not a ${formatLabel} export`)
    }
    records.push(...(data as T[]))
  }
  return records
}

export function isZipFile(file: File): boolean {
  return (
    file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip'
  )
}
