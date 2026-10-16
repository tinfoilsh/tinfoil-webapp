import { createContext, useContext, type ReactNode } from 'react'
import type { Attachment } from './types'

export type LoadDocumentText = (attachment: Attachment) => Promise<string>

const DocumentTextContext = createContext<LoadDocumentText | null>(null)

// A stored document's text stays out of its message, so the document list
// reads it when the user opens the document.
export function DocumentTextProvider({
  load,
  children,
}: {
  load?: LoadDocumentText
  children: ReactNode
}) {
  return (
    <DocumentTextContext.Provider value={load ?? null}>
      {children}
    </DocumentTextContext.Provider>
  )
}

export function useDocumentText(): LoadDocumentText | null {
  return useContext(DocumentTextContext)
}
