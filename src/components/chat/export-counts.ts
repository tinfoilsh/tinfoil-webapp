export interface ClaudeProjectExportCounts {
  exportedProjects: number
  skippedProjects: number
  exportedDocuments: number
  skippedDocuments: number
  failedDocumentListings: number
}
export function formatClaudeProjectExportCounts(
  counts: ClaudeProjectExportCounts,
): string {
  const count = (value: number, noun: string) =>
    `${value} ${noun}${value === 1 ? '' : 's'}`
  const exported = `Exported ${count(counts.exportedProjects, 'project')} and ${count(counts.exportedDocuments, 'document')}.`
  if (counts.failedDocumentListings === 0) {
    return `${exported} Skipped ${count(counts.skippedProjects, 'project')} and ${count(counts.skippedDocuments, 'document')}.`
  }

  const failedListings = count(counts.failedDocumentListings, 'project')
  const knownSkippedDocuments =
    counts.skippedDocuments > 0
      ? ` Of the documents that were listed, ${count(counts.skippedDocuments, 'document')} ${counts.skippedDocuments === 1 ? 'was' : 'were'} skipped.`
      : ''
  return `${exported} Skipped ${count(counts.skippedProjects, 'project')}. The skipped document total is unknown because document listing failed for ${failedListings}.${knownSkippedDocuments}`
}
