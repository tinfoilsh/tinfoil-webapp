import { createContext, useContext, type ReactNode } from 'react'
import type { Attachment } from './types'

export type LoadDocumentText = (attachment: Attachment) => Promise<string>
export type LoadOriginalFile = (attachment: Attachment) => Promise<Blob>

const DocumentTextContext = createContext<LoadDocumentText | null>(null)
const OriginalFileContext = createContext<LoadOriginalFile | null>(null)

// A stored document's text stays out of its message, so the document list
// reads it to preview and open the document. The file a document was
// uploaded as is read where the chat keeps it, to download.
export function DocumentTextProvider({
  load,
  loadOriginal,
  children,
}: {
  load?: LoadDocumentText
  loadOriginal?: LoadOriginalFile
  children: ReactNode
}) {
  return (
    <DocumentTextContext.Provider value={load ?? null}>
      <OriginalFileContext.Provider value={loadOriginal ?? null}>
        {children}
      </OriginalFileContext.Provider>
    </DocumentTextContext.Provider>
  )
}

export function useDocumentText(): LoadDocumentText | null {
  return useContext(DocumentTextContext)
}

export function useOriginalFile(): LoadOriginalFile | null {
  return useContext(OriginalFileContext)
}
