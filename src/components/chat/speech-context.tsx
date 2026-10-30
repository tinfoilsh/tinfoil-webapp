import { createContext, useContext, type ReactNode } from 'react'

// Asks the harness to read a message of the chat shown aloud.
export type Speak = (
  messageId: string,
  signal: AbortSignal,
) => Promise<Response>

const SpeechContext = createContext<Speak | null>(null)

export function SpeechProvider({
  speak,
  children,
}: {
  speak?: Speak
  children: ReactNode
}) {
  return (
    <SpeechContext.Provider value={speak ?? null}>
      {children}
    </SpeechContext.Provider>
  )
}

export function useSpeak(): Speak | null {
  return useContext(SpeechContext)
}
