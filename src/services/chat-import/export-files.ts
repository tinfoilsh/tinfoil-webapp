/**
 * ChatGPT and Claude split large exports across several JSON files
 * (conversations-1.json, conversations-2.json, ...), so the on-device
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
      for (const record of data as T[]) {
        records.push(record)
      }
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
