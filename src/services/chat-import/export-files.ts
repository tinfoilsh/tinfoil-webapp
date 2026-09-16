/**
 * ChatGPT and Claude split large exports across several JSON files. A file
 * holds either an array of records (conversations-1.json, ...) or a single
 * record (Claude writes one <uuid>.json per project), so the on-device
 * importer reads them all and concatenates the records before parsing.
 */
export async function readExportFiles<T extends object>(
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
    if (Array.isArray(data)) {
      records.push(...(data as T[]))
    } else if (data !== null && typeof data === 'object') {
      records.push(data as T)
    } else {
      throw new Error(`${file.name} is not a ${formatLabel} export`)
    }
  }
  return records
}

export function isZipFile(file: File): boolean {
  return (
    file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip'
  )
}
