'use client'

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type ChatDragSource = 'chat-history' | 'project' | 'favorites'

interface DragContextValue {
  draggingChatId: string | null
  draggingChatFromProjectId: string | null
  draggingChatSource: ChatDragSource | null
  dropTargetProjectId: string | null
  dropTargetTab: 'cloud' | 'local' | null
  isDropTargetChatHistory: boolean

  setDraggingChat: (
    chatId: string | null,
    fromProjectId?: string | null,
    source?: ChatDragSource,
  ) => void
  setDropTargetProject: (projectId: string | null) => void
  setDropTargetTab: (tab: 'cloud' | 'local' | null) => void
  setDropTargetChatHistory: (isTarget: boolean) => void
  clearDragState: () => void
}

const DragContext = createContext<DragContextValue | null>(null)

export function DragProvider({ children }: { children: ReactNode }) {
  const [draggingChatId, setDraggingChatId] = useState<string | null>(null)
  const [draggingChatFromProjectId, setDraggingChatFromProjectId] = useState<
    string | null
  >(null)
  const [draggingChatSource, setDraggingChatSource] =
    useState<ChatDragSource | null>(null)
  const [dropTargetProjectId, setDropTargetProjectId] = useState<string | null>(
    null,
  )
  const [dropTargetTab, setDropTargetTab] = useState<'cloud' | 'local' | null>(
    null,
  )
  const [isDropTargetChatHistory, setIsDropTargetChatHistory] = useState(false)

  const setDraggingChat = useCallback(
    (
      chatId: string | null,
      fromProjectId?: string | null,
      source?: ChatDragSource,
    ) => {
      setDraggingChatId(chatId)
      setDraggingChatFromProjectId(fromProjectId ?? null)
      setDraggingChatSource(
        chatId === null
          ? null
          : (source ?? (fromProjectId ? 'project' : 'chat-history')),
      )
    },
    [],
  )

  const clearDragState = useCallback(() => {
    setDraggingChatId(null)
    setDraggingChatFromProjectId(null)
    setDraggingChatSource(null)
    setDropTargetProjectId(null)
    setDropTargetTab(null)
    setIsDropTargetChatHistory(false)
  }, [])

  // The same value while no drag changes, so the sidebars reading it do not
  // render again whenever the page does.
  const value = useMemo(
    () => ({
      draggingChatId,
      draggingChatFromProjectId,
      draggingChatSource,
      dropTargetProjectId,
      dropTargetTab,
      isDropTargetChatHistory,
      setDraggingChat,
      setDropTargetProject: setDropTargetProjectId,
      setDropTargetTab,
      setDropTargetChatHistory: setIsDropTargetChatHistory,
      clearDragState,
    }),
    [
      draggingChatId,
      draggingChatFromProjectId,
      draggingChatSource,
      dropTargetProjectId,
      dropTargetTab,
      isDropTargetChatHistory,
      setDraggingChat,
      clearDragState,
    ],
  )

  return <DragContext.Provider value={value}>{children}</DragContext.Provider>
}

export function useDrag(): DragContextValue {
  const context = useContext(DragContext)
  if (!context) {
    throw new Error('useDrag must be used within a DragProvider')
  }
  return context
}
