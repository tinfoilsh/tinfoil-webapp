interface ReadExportFilesOptions {
  /**
   * Accept a file holding one record object instead of an array. Claude
   * writes one <uuid>.json per project; conversation exports are always
   * arrays, and stray object files such as users.json must be rejected.
   */
  allowSingleRecord?: boolean
}

/**
 * ChatGPT and Claude split large exports across several JSON files
 * (conversations-1.json, conversations-2.json, ...), so the on-device
 * importer reads them all and concatenates the records before parsing.
 */
export async function readExportFiles<T extends object>(
  files: readonly File[],
  formatLabel: string,
  options: ReadExportFilesOptions = {},
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
    } else if (
      options.allowSingleRecord &&
      data !== null &&
      typeof data === 'object'
    ) {
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
