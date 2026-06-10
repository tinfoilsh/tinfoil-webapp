'use client'

import { ChatList, type ChatItemData } from '@/components/chat/chat-list'
import { formatRelativeTime } from '@/components/chat/chat-list-utils'
import { useDocumentUploader } from '@/components/chat/document-uploader'
import { useDrag } from '@/components/chat/drag-context'
import { TypingAnimation } from '@/components/chat/typing-animation'
import { PiSpinnerThin } from '@/components/icons/lazy-icons'
import { Link } from '@/components/link'
import { Logo } from '@/components/logo'
import { cn } from '@/components/ui/utils'
import { UI_EXPAND_PROJECT_DOCUMENTS } from '@/constants/storage-keys'
import { toast } from '@/hooks/use-toast'
import type { Fact } from '@/types/memory'
import type { Project } from '@/types/project'
import { useAuth } from '@clerk/nextjs'
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  Cog6ToothIcon,
  DocumentIcon,
  DocumentPlusIcon,
  FolderIcon,
  PencilSquareIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'
import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BsFile,
  BsFiletypeCss,
  BsFiletypeCsv,
  BsFiletypeDoc,
  BsFiletypeDocx,
  BsFiletypeGif,
  BsFiletypeHtml,
  BsFiletypeJpg,
  BsFiletypeJs,
  BsFiletypeJson,
  BsFiletypeJsx,
  BsFiletypeMd,
  BsFiletypeMov,
  BsFiletypeMp3,
  BsFiletypeMp4,
  BsFiletypePdf,
  BsFiletypePng,
  BsFiletypePpt,
  BsFiletypePptx,
  BsFiletypeTsx,
  BsFiletypeTxt,
  BsFiletypeWav,
  BsFiletypeXls,
  BsFiletypeXlsx,
  BsFiletypeXml,
} from 'react-icons/bs'
import { GoSidebarCollapse, GoSidebarExpand } from 'react-icons/go'
import { PiNotePencilLight } from 'react-icons/pi'
import { CONSTANTS } from '../chat/constants'
import { useProject } from './project-context'

const MOBILE_BREAKPOINT = 1024

interface ProjectChat {
  id: string
  title: string
  messageCount: number
  createdAt: Date
  projectId?: string
  isBlankChat?: boolean
}

interface ProjectOption {
  id: string
  name: string
}

interface ProjectSidebarProps {
  isOpen: boolean
  setIsOpen: (isOpen: boolean) => void
  project: Project | null
  projectName?: string
  isLoading?: boolean
  isDarkMode: boolean
  onExitProject: () => void
  onExitProjectWhileDragging?: () => void
  onNewChat: () => void
  onSelectChat: (chatId: string) => void
  currentChatId?: string
  isClient: boolean
  chats?: ProjectChat[]
  deleteChat?: (chatId: string) => void
  updateChatTitle?: (chatId: string, newTitle: string) => void
  onEncryptionKeyClick?: () => void
  onRemoveChatFromProject?: (chatId: string) => Promise<void>
  onAddChatToProject?: (chatId: string) => Promise<void>
  onMoveChatToProject?: (chatId: string, projectId: string) => Promise<void>
  projects?: ProjectOption[]
  onSettingsClick?: () => void
  windowWidth: number
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function Shimmer({ className }: { className?: string }) {
  return (
    <div
      className={cn('animate-pulse rounded bg-content-muted/20', className)}
    />
  )
}

function getFileIcon(filename: string, className: string) {
  const extension = filename.toLowerCase().split('.').pop() || ''

  switch (extension) {
    case 'pdf':
      return <BsFiletypePdf className={className} />
    case 'doc':
      return <BsFiletypeDoc className={className} />
    case 'docx':
      return <BsFiletypeDocx className={className} />
    case 'xls':
      return <BsFiletypeXls className={className} />
    case 'xlsx':
      return <BsFiletypeXlsx className={className} />
    case 'csv':
      return <BsFiletypeCsv className={className} />
    case 'ppt':
      return <BsFiletypePpt className={className} />
    case 'pptx':
      return <BsFiletypePptx className={className} />
    case 'html':
    case 'htm':
    case 'xhtml':
      return <BsFiletypeHtml className={className} />
    case 'css':
      return <BsFiletypeCss className={className} />
    case 'js':
      return <BsFiletypeJs className={className} />
    case 'jsx':
      return <BsFiletypeJsx className={className} />
    case 'ts':
    case 'tsx':
      return <BsFiletypeTsx className={className} />
    case 'json':
      return <BsFiletypeJson className={className} />
    case 'md':
      return <BsFiletypeMd className={className} />
    case 'xml':
      return <BsFiletypeXml className={className} />
    case 'txt':
      return <BsFiletypeTxt className={className} />
    case 'png':
      return <BsFiletypePng className={className} />
    case 'jpg':
    case 'jpeg':
      return <BsFiletypeJpg className={className} />
    case 'gif':
      return <BsFiletypeGif className={className} />
    case 'mp3':
      return <BsFiletypeMp3 className={className} />
    case 'wav':
      return <BsFiletypeWav className={className} />
    case 'mp4':
      return <BsFiletypeMp4 className={className} />
    case 'mov':
      return <BsFiletypeMov className={className} />
    default:
      return <BsFile className={className} />
  }
}

export function ProjectSidebar({
  isOpen,
  setIsOpen,
  project,
  projectName,
  isLoading,
  isDarkMode,
  onExitProject,
  onExitProjectWhileDragging,
  onNewChat,
  onSelectChat,
  currentChatId,
  isClient,
  chats: chatsProp,
  deleteChat,
  updateChatTitle,
  onEncryptionKeyClick,
  onRemoveChatFromProject,
  onAddChatToProject,
  onMoveChatToProject,
  projects = [],
  onSettingsClick,
  windowWidth,
}: ProjectSidebarProps) {
  const { isSignedIn } = useAuth()
  const { setDraggingChat, clearDragState } = useDrag()
  const {
    projectDocuments,
    uploadDocument,
    removeDocument,
    updateProject,
    updateProjectMemory,
    deleteProject,
    refreshDocuments,
    loading: contextLoading,
    uploadingFiles: contextUploadingFiles,
    addUploadingFile,
    removeUploadingFile,
  } = useProject()
  const { handleDocumentUpload: processDocument, isDocumentUploading } =
    useDocumentUploader()
  const [settingsExpanded, setSettingsExpanded] = useState(false)
  const [documentsExpanded, setDocumentsExpanded] = useState(false)
  const [memoryExpanded, setMemoryExpanded] = useState(false)
  const [memoryText, setMemoryText] = useState('')
  const [memoryEdited, setMemoryEdited] = useState(false)

  const [editedName, setEditedName] = useState(project?.name ?? '')
  const [editedDescription, setEditedDescription] = useState(
    project?.description ?? '',
  )
  const [editedInstructions, setEditedInstructions] = useState(
    project?.systemInstructions ?? '',
  )
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const [isEditingProjectName, setIsEditingProjectName] = useState(false)
  const [editingProjectName, setEditingProjectName] = useState(
    project?.name ?? '',
  )

  const [displayProjectName, setDisplayProjectName] = useState(
    project?.name ?? '',
  )
  const [isAnimatingName, setIsAnimatingName] = useState(false)
  const [animationFromName, setAnimationFromName] = useState('')
  const [animationToName, setAnimationToName] = useState('')
  const prevProjectNameRef = useRef(project?.name ?? '')
  // Track manual edits to skip animation when the project prop updates
  const skipNextAnimationRef = useRef(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const exitHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isExitButtonDragHover, setIsExitButtonDragHover] = useState(false)
  const [isDropTargetChatList, setIsDropTargetChatList] = useState(false)

  const [isMac, setIsMac] = useState(false)
  useEffect(() => {
    setIsMac(/Mac|iPod|iPhone|iPad/.test(navigator.platform))
  }, [])
  const modKey = isMac ? '⌘' : 'Ctrl+'

  useEffect(() => {
    if (project) {
      setEditedName(project.name)
      setEditedDescription(project.description)
      setEditedInstructions(project.systemInstructions)
      setEditingProjectName(project.name)

      const shouldAnimate =
        prevProjectNameRef.current !== project.name &&
        prevProjectNameRef.current !== '' &&
        !skipNextAnimationRef.current

      if (shouldAnimate) {
        setAnimationFromName(prevProjectNameRef.current)
        setAnimationToName(project.name)
        setIsAnimatingName(true)
      } else {
        setDisplayProjectName(project.name)
        prevProjectNameRef.current = project.name
      }
      skipNextAnimationRef.current = false
    }
  }, [project])

  useEffect(() => {
    refreshDocuments()
  }, [refreshDocuments])

  // Expand documents section when signal is set (from file upload to project context)
  useEffect(() => {
    if (isOpen) {
      const shouldExpandDocs = sessionStorage.getItem(
        UI_EXPAND_PROJECT_DOCUMENTS,
      )
      if (shouldExpandDocs === 'true') {
        setDocumentsExpanded(true)
        sessionStorage.removeItem(UI_EXPAND_PROJECT_DOCUMENTS)
      }
    }
  }, [isOpen])

  // Sync memory text with project memory
  const projectId = project?.id
  const projectMemory = project?.memory
  useEffect(() => {
    if (projectId && !memoryEdited) {
      setMemoryText((projectMemory || []).map((f) => f.fact).join('\n\n'))
    }
  }, [projectId, projectMemory, memoryEdited])

  const handleMemoryChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setMemoryText(e.target.value)
      setMemoryEdited(true)
    },
    [],
  )

  const handleMemorySave = useCallback(async () => {
    if (!memoryEdited || !project) return

    const newLines = memoryText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

    const existingFacts = project.memory || []
    const existingByFact = new Map(existingFacts.map((f) => [f.fact, f]))

    const updatedFacts: Fact[] = newLines.map((line) => {
      const existing = existingByFact.get(line)
      if (existing) {
        return existing
      }
      return {
        id: crypto.randomUUID(),
        fact: line,
        date: new Date().toISOString(),
        category: 'other',
        confidence: 1,
      }
    })

    await updateProjectMemory(updatedFacts)
    setMemoryEdited(false)
  }, [memoryEdited, memoryText, project, updateProjectMemory])

  const handleSaveSettings = useCallback(async () => {
    if (!project) return
    setIsSaving(true)
    try {
      await updateProject(project.id, {
        name: editedName,
        description: editedDescription,
        systemInstructions: editedInstructions,
      })
    } catch {
      toast({
        title: 'Failed to save project settings',
        description:
          'The project settings could not be saved. Please try again.',
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }, [
    project,
    editedName,
    editedDescription,
    editedInstructions,
    updateProject,
  ])

  const handleSaveProjectName = useCallback(async () => {
    if (!project || isSaving) return
    if (editingProjectName.trim() && editingProjectName !== project.name) {
      setIsSaving(true)
      const newName = editingProjectName.trim()
      // Skip animation when the project prop updates after save
      skipNextAnimationRef.current = true
      try {
        await updateProject(project.id, {
          name: newName,
        })
        setEditedName(newName)
      } catch {
        // Reset the skip flag on failure since no update will occur
        skipNextAnimationRef.current = false
        toast({
          title: 'Failed to save project name',
          description: 'The project name could not be saved. Please try again.',
          variant: 'destructive',
        })
      } finally {
        setIsSaving(false)
      }
    }
    setIsEditingProjectName(false)
  }, [editingProjectName, isSaving, project, updateProject])

  const handleNameAnimationComplete = useCallback(() => {
    if (project) {
      setDisplayProjectName(project.name)
      setIsAnimatingName(false)
      prevProjectNameRef.current = project.name
    }
  }, [project])

  const handleDeleteProject = useCallback(async () => {
    if (!project) return
    setIsDeleting(true)
    try {
      await deleteProject(project.id)
      onExitProject()
    } catch {
      toast({
        title: 'Failed to delete project',
        description: 'The project could not be deleted. Please try again.',
        variant: 'destructive',
      })
    } finally {
      setIsDeleting(false)
      setShowDeleteConfirm(false)
    }
  }, [project, deleteProject, onExitProject])

  const handleFileUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files || files.length === 0) return

      const fileArray = Array.from(files)
      const uploadIds = fileArray.map(() => crypto.randomUUID())

      fileArray.forEach((file, i) => {
        addUploadingFile({
          id: uploadIds[i],
          name: file.name,
          size: file.size,
        })
      })

      await Promise.all(
        fileArray.map(async (file, i) => {
          return new Promise<void>((resolve) => {
            processDocument(
              file,
              async (content) => {
                try {
                  await uploadDocument(file, content)
                } catch {
                  toast({
                    title: 'Upload failed',
                    description:
                      'Failed to upload the document. Please try again.',
                    variant: 'destructive',
                  })
                } finally {
                  removeUploadingFile(uploadIds[i])
                  resolve()
                }
              },
              (error) => {
                toast({
                  title: 'Upload failed',
                  description: error.message,
                  variant: 'destructive',
                })
                removeUploadingFile(uploadIds[i])
                resolve()
              },
            )
          })
        }),
      )

      e.target.value = ''
    },
    [uploadDocument, processDocument, addUploadingFile, removeUploadingFile],
  )

  const handleChatSelect = useCallback(
    (chatId: string) => {
      onSelectChat(chatId)
      if (windowWidth < MOBILE_BREAKPOINT) {
        setIsOpen(false)
      }
    },
    [onSelectChat, windowWidth, setIsOpen],
  )

  const handleNewChat = useCallback(() => {
    onNewChat()
    if (windowWidth < MOBILE_BREAKPOINT) {
      setIsOpen(false)
    }
  }, [onNewChat, windowWidth, setIsOpen])

  const handleRemoveDocument = useCallback(
    async (docId: string) => {
      try {
        await removeDocument(docId)
      } catch {
        toast({
          title: 'Failed to delete document',
          description: 'The document could not be deleted. Please try again.',
          variant: 'destructive',
        })
      }
    },
    [removeDocument],
  )

  const handleDeleteChat = useCallback(
    (chatId: string) => {
      if (deleteChat) {
        deleteChat(chatId)
      }
    },
    [deleteChat],
  )

  const hasUnsavedChanges = project
    ? editedName !== project.name ||
      editedDescription !== project.description ||
      editedInstructions !== project.systemInstructions
    : false

  const blankChat: ChatItemData = {
    id: '',
    title: 'New Chat',
    messageCount: 0,
    updatedAt: new Date().toISOString(),
    isBlankChat: true,
  }

  // Convert chatsProp to ChatItemData format and sort by createdAt descending
  const projectChats: ChatItemData[] = (chatsProp || [])
    .filter((c) => !c.isBlankChat)
    .map((c) => ({
      id: c.id,
      title: c.title,
      messageCount: c.messageCount,
      updatedAt:
        c.createdAt instanceof Date
          ? c.createdAt.toISOString()
          : new Date(c.createdAt).toISOString(),
    }))
    .sort(
      (a, b) =>
        new Date(b.updatedAt!).getTime() - new Date(a.updatedAt!).getTime(),
    )

  const chatsWithBlank: ChatItemData[] = [blankChat, ...projectChats]

  const isMobile = windowWidth < MOBILE_BREAKPOINT

  return (
    <>
      {/* Collapsed sidebar rail - always visible on desktop when sidebar is closed */}
      {!isMobile && !isOpen && (
        <div
          className={cn(
            'fixed left-0 top-0 z-40 flex h-dvh flex-col border-r',
            'border-border-subtle bg-surface-sidebar text-content-primary',
          )}
          style={{ width: `${CONSTANTS.CHAT_SIDEBAR_COLLAPSED_WIDTH_PX}px` }}
        >
          {/* Folder icon - shows expand icon on hover */}
          <div className="flex h-16 flex-none items-center justify-center">
            <button
              onClick={() => setIsOpen(true)}
              className="group/logo relative rounded p-2"
              aria-label="Expand sidebar"
            >
              <FolderIcon className="h-6 w-6 text-content-secondary transition-opacity group-hover/logo:opacity-0" />
              <GoSidebarCollapse className="absolute inset-0 m-auto h-5 w-5 text-content-secondary opacity-0 transition-opacity group-hover/logo:opacity-100" />
            </button>
          </div>

          {/* Action buttons */}
          <div className="flex flex-col items-center gap-1 px-2">
            {/* New chat button */}
            <div className="group relative">
              <button
                onClick={onNewChat}
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
                  'text-content-secondary hover:bg-surface-chat hover:text-content-primary',
                )}
                aria-label="New chat"
              >
                <PiNotePencilLight className="h-5 w-5" />
              </button>
              <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                New chat{' '}
                <span className="text-content-muted">
                  {modKey}
                  {isMac ? '⇧' : 'Shift+'}O
                </span>
              </span>
            </div>
          </div>
        </div>
      )}

      <div
        inert={!isOpen}
        className={cn(
          'fixed z-40 flex h-dvh w-[85vw] flex-col overflow-hidden border-r',
          isOpen ? 'translate-x-0' : '-translate-x-full',
          'border-border-subtle bg-surface-sidebar text-content-primary',
          'transition-all duration-200 ease-in-out',
        )}
        style={{ maxWidth: `${CONSTANTS.CHAT_SIDEBAR_WIDTH_PX}px` }}
      >
        {/* Header */}
        <div className="flex h-16 flex-none items-center justify-between border-b border-border-subtle p-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                window.location.href = window.location.origin
              }}
              title="Home"
              className="flex items-center"
            >
              <Logo className="h-6 w-auto" dark={isDarkMode} />
            </button>
            {/* Settings button */}
            <div className="group relative flex items-center">
              <button
                type="button"
                onClick={onSettingsClick}
                className="rounded p-1.5 text-content-muted transition-all duration-200 hover:text-content-secondary"
              >
                <Cog6ToothIcon className="h-5 w-5" />
              </button>
              <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-1 -translate-x-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                Settings
              </span>
            </div>
          </div>
          {/* Close sidebar button */}
          <div className="group relative flex items-center">
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="rounded p-1.5 text-content-muted transition-all duration-200 hover:bg-surface-chat hover:text-content-secondary"
              aria-label="Close sidebar"
            >
              <GoSidebarExpand className="h-5 w-5" />
            </button>
            <span className="pointer-events-none absolute right-full top-1/2 z-50 mr-2 -translate-y-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
              Close sidebar{' '}
              <span className="text-content-muted">{modKey}.</span>
            </span>
          </div>
        </div>

        {/* Main sidebar content */}
        <div className="relative flex h-full flex-col overflow-hidden">
          {/* Project header with exit button and editable title */}
          <div className="relative z-10 flex-none p-3">
            <button
              onClick={onExitProject}
              onDragEnter={(e) => {
                if (e.dataTransfer.types.includes('application/x-chat-id')) {
                  e.preventDefault()
                  setIsExitButtonDragHover(true)
                  if (exitHoverTimerRef.current) {
                    clearTimeout(exitHoverTimerRef.current)
                  }
                  exitHoverTimerRef.current = setTimeout(() => {
                    onExitProjectWhileDragging?.()
                  }, 400)
                }
              }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('application/x-chat-id')) {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                }
              }}
              onDragLeave={() => {
                setIsExitButtonDragHover(false)
                if (exitHoverTimerRef.current) {
                  clearTimeout(exitHoverTimerRef.current)
                  exitHoverTimerRef.current = null
                }
              }}
              onDrop={(e) => {
                e.preventDefault()
                setIsExitButtonDragHover(false)
                if (exitHoverTimerRef.current) {
                  clearTimeout(exitHoverTimerRef.current)
                  exitHoverTimerRef.current = null
                }
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg p-2 text-sm transition-colors',
                isExitButtonDragHover
                  ? isDarkMode
                    ? 'border border-white/30 bg-white/10'
                    : 'border border-gray-400 bg-gray-200/30'
                  : isDarkMode
                    ? 'text-content-secondary hover:bg-surface-chat'
                    : 'text-content-secondary hover:bg-surface-sidebar',
              )}
            >
              <ArrowLeftIcon className="h-4 w-4" />
              <span className="font-aeonik font-medium">Exit Project</span>
            </button>
            <div className="mt-2 px-2">
              {isLoading ? (
                <div className="space-y-2">
                  <h2 className="truncate font-aeonik text-lg font-semibold text-content-primary">
                    {projectName || 'Loading...'}
                  </h2>
                  <Shimmer className="h-3 w-32" />
                </div>
              ) : isEditingProjectName && project ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    handleSaveProjectName()
                  }}
                  className="flex items-center gap-2"
                >
                  <input
                    type="text"
                    value={editingProjectName}
                    onChange={(e) => setEditingProjectName(e.target.value)}
                    onBlur={handleSaveProjectName}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setEditingProjectName(project.name)
                        setIsEditingProjectName(false)
                      }
                    }}
                    autoFocus
                    className={cn(
                      'w-full rounded-md border px-2 py-1 font-aeonik text-lg font-semibold',
                      isDarkMode
                        ? 'border-border-strong bg-surface-chat text-content-primary'
                        : 'border-border-subtle bg-white text-content-primary',
                      'focus:outline-none focus:ring-1 focus:ring-border-strong',
                    )}
                  />
                </form>
              ) : project ? (
                <>
                  <div
                    className="group flex cursor-pointer items-center gap-2"
                    onClick={() => setIsEditingProjectName(true)}
                  >
                    <h2 className="truncate font-aeonik text-lg font-semibold text-content-primary">
                      {isAnimatingName ? (
                        <TypingAnimation
                          fromText={animationFromName}
                          toText={animationToName}
                          onComplete={handleNameAnimationComplete}
                        />
                      ) : (
                        displayProjectName
                      )}
                    </h2>
                    <PencilSquareIcon className="h-4 w-4 text-content-muted opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                  <p className="mt-0.5 font-aeonik-fono text-xs text-content-muted">
                    Updated {formatRelativeTime(new Date(project.updatedAt))}
                  </p>
                </>
              ) : null}
            </div>
          </div>

          {/* New Chat button */}
          <div className="relative z-10 mt-3 flex-none px-2 py-2">
            <button
              onClick={handleNewChat}
              disabled={!currentChatId}
              className={cn(
                'flex w-full items-center justify-between rounded-lg border px-2 py-2 text-sm transition-colors',
                !currentChatId
                  ? 'cursor-default border-transparent bg-transparent text-content-muted'
                  : isDarkMode
                    ? 'border-border-strong bg-surface-chat text-content-primary hover:bg-surface-chat/80'
                    : 'border-border-subtle bg-white text-content-primary hover:bg-gray-50',
              )}
            >
              <span className="flex items-center gap-2">
                <PiNotePencilLight className="h-4 w-4" />
                <span className="font-aeonik font-medium">New chat</span>
              </span>
              <span className="text-xs text-content-muted">
                {modKey}
                {isMac ? '⇧' : 'Shift+'}O
              </span>
            </button>
          </div>

          {/* Project Settings Dropdown */}
          <div className="relative z-10 flex-none border-y border-border-subtle">
            <button
              onClick={() =>
                !isLoading && setSettingsExpanded(!settingsExpanded)
              }
              disabled={isLoading}
              className={cn(
                'flex w-full items-center justify-between bg-surface-sidebar px-4 py-3 text-sm transition-colors',
                isLoading
                  ? 'cursor-default opacity-50'
                  : isDarkMode
                    ? 'text-content-secondary hover:bg-surface-chat'
                    : 'text-content-secondary hover:bg-white',
              )}
            >
              <span className="flex items-center gap-2">
                <Cog6ToothIcon className="h-4 w-4" />
                <span className="font-aeonik font-medium">
                  Project Settings
                </span>
              </span>
              {settingsExpanded && !isLoading ? (
                <ChevronUpIcon className="h-4 w-4" />
              ) : (
                <ChevronDownIcon className="h-4 w-4" />
              )}
            </button>

            <AnimatePresence initial={false}>
              {settingsExpanded && !isLoading && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: 'easeInOut' }}
                  className="overflow-hidden"
                >
                  <div className="px-4 py-4">
                    <div className="space-y-3">
                      {/* Description */}
                      <div className="space-y-2">
                        <div className="font-aeonik text-sm font-medium text-content-secondary">
                          Project description
                        </div>
                        <textarea
                          value={editedDescription}
                          onChange={(e) => setEditedDescription(e.target.value)}
                          placeholder="Describe your project and goals..."
                          rows={5}
                          className={cn(
                            'w-full resize-none rounded-md border px-3 py-2 text-sm',
                            isDarkMode
                              ? 'border-border-strong bg-surface-chat text-content-secondary placeholder:text-content-muted'
                              : 'border-border-subtle bg-surface-sidebar text-content-primary placeholder:text-content-muted',
                            'focus:outline-none focus:ring-1 focus:ring-border-strong',
                          )}
                        />
                      </div>

                      {/* Response Instructions */}
                      <div className="space-y-2">
                        <div className="font-aeonik text-sm font-medium text-content-secondary">
                          Response instructions
                        </div>
                        <textarea
                          value={editedInstructions}
                          onChange={(e) =>
                            setEditedInstructions(e.target.value)
                          }
                          placeholder="Specific response preferences or instructions..."
                          rows={5}
                          className={cn(
                            'w-full resize-none rounded-md border px-3 py-2 text-sm',
                            isDarkMode
                              ? 'border-border-strong bg-surface-chat text-content-secondary placeholder:text-content-muted'
                              : 'border-border-subtle bg-surface-sidebar text-content-primary placeholder:text-content-muted',
                            'focus:outline-none focus:ring-1 focus:ring-border-strong',
                          )}
                        />
                      </div>

                      {/* Save button */}
                      {hasUnsavedChanges && (
                        <button
                          onClick={handleSaveSettings}
                          disabled={isSaving}
                          className={cn(
                            'w-full rounded-lg px-3 py-2 font-aeonik text-sm font-medium transition-colors',
                            'bg-emerald-600 text-white hover:bg-emerald-700',
                            isSaving && 'cursor-not-allowed opacity-50',
                          )}
                        >
                          {isSaving ? 'Saving...' : 'Save Changes'}
                        </button>
                      )}

                      {/* Delete Project */}
                      {showDeleteConfirm ? (
                        <div className="rounded-lg bg-red-600 p-3">
                          <p className="mb-3 font-aeonik-fono text-xs text-white">
                            Delete this project? This cannot be undone.
                          </p>
                          <div className="flex gap-2">
                            <button
                              onClick={handleDeleteProject}
                              disabled={isDeleting}
                              className={cn(
                                'flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                                isDarkMode
                                  ? 'bg-red-200 text-red-900 hover:bg-red-300'
                                  : 'bg-white text-red-600 hover:bg-red-50',
                                isDeleting && 'cursor-not-allowed opacity-50',
                              )}
                            >
                              {isDeleting ? 'Deleting...' : 'Delete'}
                            </button>
                            <button
                              onClick={() => setShowDeleteConfirm(false)}
                              className="flex-1 rounded-lg bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => setShowDeleteConfirm(true)}
                          className={cn(
                            'flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors',
                            isDarkMode
                              ? 'border-red-500/30 bg-red-950/20 text-red-400 hover:bg-red-950/40'
                              : 'border-red-300 bg-red-50 text-red-600 hover:bg-red-100',
                          )}
                        >
                          <TrashIcon className="h-3.5 w-3.5" />
                          Delete Project
                        </button>
                      )}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Documents Section */}
          <div className="relative z-10 flex-none border-b border-border-subtle">
            <button
              onClick={() =>
                !isLoading && setDocumentsExpanded(!documentsExpanded)
              }
              disabled={isLoading}
              className={cn(
                'flex w-full items-center justify-between bg-surface-sidebar px-4 py-3 text-sm transition-colors',
                isLoading
                  ? 'cursor-default opacity-50'
                  : isDarkMode
                    ? 'text-content-secondary hover:bg-surface-chat'
                    : 'text-content-secondary hover:bg-white',
              )}
            >
              <span className="flex items-center gap-2">
                <DocumentIcon className="h-4 w-4" />
                <span className="font-aeonik font-medium">
                  Documents {isLoading ? '' : `(${projectDocuments.length})`}
                </span>
              </span>
              {documentsExpanded && !isLoading ? (
                <ChevronUpIcon className="h-4 w-4" />
              ) : (
                <ChevronDownIcon className="h-4 w-4" />
              )}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileUpload}
              disabled={contextLoading}
              accept=".pdf,.docx,.xlsx,.pptx,.md,.html,.xhtml,.csv,.png,.jpg,.jpeg,.tiff,.bmp,.webp,.txt"
            />

            <AnimatePresence initial={false}>
              {documentsExpanded && !isLoading && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: 'easeInOut' }}
                  className="overflow-hidden"
                >
                  <div className="max-h-64 overflow-y-auto px-2 py-2">
                    {/* Drag and drop zone - at top */}
                    <div
                      onClick={() =>
                        !contextLoading && fileInputRef.current?.click()
                      }
                      className={cn(
                        'flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 transition-colors',
                        contextLoading
                          ? 'cursor-not-allowed opacity-50'
                          : 'cursor-pointer',
                        projectDocuments.length > 0 ||
                          contextUploadingFiles.length > 0
                          ? 'mb-2 py-3'
                          : 'py-6',
                        isDarkMode
                          ? 'border-border-strong hover:border-emerald-500/50 hover:bg-surface-chat'
                          : 'border-border-subtle hover:border-emerald-500/50 hover:bg-surface-sidebar',
                      )}
                    >
                      <DocumentPlusIcon
                        className={cn(
                          'h-5 w-5',
                          projectDocuments.length === 0 &&
                            contextUploadingFiles.length === 0 &&
                            'mb-2 h-6 w-6',
                          isDarkMode
                            ? 'text-content-muted'
                            : 'text-content-muted',
                        )}
                      />
                      {projectDocuments.length === 0 &&
                        contextUploadingFiles.length === 0 && (
                          <>
                            <p className="text-center font-aeonik-fono text-xs text-content-muted">
                              Click to upload
                            </p>
                            <p className="mt-1 text-center font-aeonik-fono text-[10px] text-content-muted">
                              PDF, TXT, MD, DOCX, XLSX, PPTX, HTML, CSV, images
                            </p>
                          </>
                        )}
                    </div>

                    {/* Document list */}
                    {(projectDocuments.length > 0 ||
                      contextUploadingFiles.length > 0) && (
                      <div className="space-y-1">
                        {/* Uploading placeholder documents - newest at top */}
                        {[...contextUploadingFiles].reverse().map((file) => (
                          <div
                            key={file.id}
                            className={cn(
                              'flex items-center gap-2 rounded-md px-2 py-1.5 opacity-70',
                              isDarkMode
                                ? 'bg-surface-chat'
                                : 'bg-surface-sidebar',
                            )}
                          >
                            <PiSpinnerThin
                              className={cn(
                                'h-4 w-4 flex-shrink-0 animate-spin',
                                isDarkMode
                                  ? 'text-emerald-400'
                                  : 'text-emerald-600',
                              )}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-aeonik-fono text-xs text-content-primary">
                                {file.name}
                              </div>
                              <div className="font-aeonik-fono text-[10px] text-content-muted">
                                Uploading...
                              </div>
                            </div>
                          </div>
                        ))}
                        {/* Existing documents - newest at top */}
                        {[...projectDocuments].reverse().map((doc) => (
                          <div
                            key={doc.id}
                            className={cn(
                              'flex items-center gap-2 rounded-md px-2 py-1.5',
                              isDarkMode
                                ? 'bg-surface-chat'
                                : 'bg-surface-sidebar',
                            )}
                          >
                            {getFileIcon(
                              doc.filename,
                              cn(
                                'h-4 w-4 flex-shrink-0',
                                isDarkMode
                                  ? 'text-emerald-400'
                                  : 'text-emerald-600',
                              ),
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-aeonik-fono text-xs text-content-primary">
                                {doc.filename}
                              </div>
                              <div className="font-aeonik-fono text-[10px] text-content-muted">
                                {formatFileSize(doc.sizeBytes)}
                              </div>
                            </div>
                            <button
                              onClick={() => handleRemoveDocument(doc.id)}
                              disabled={contextLoading}
                              className={cn(
                                'rounded p-0.5 transition-colors',
                                isDarkMode
                                  ? 'text-content-muted hover:text-red-400'
                                  : 'text-content-muted hover:text-red-600',
                                contextLoading &&
                                  'cursor-not-allowed opacity-50',
                              )}
                            >
                              <TrashIcon className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Chat History Header */}
          <div className="relative z-10 flex-none border-b border-border-subtle px-3 py-2 sm:px-4 sm:py-3">
            <h3 className="truncate font-aeonik-fono text-sm font-medium text-content-primary">
              Project Chats
            </h3>
            <p className="font-aeonik-fono text-xs text-content-muted">
              Chats in this project share context and documents.
            </p>
          </div>

          {/* Scrollable Chat List */}
          <div
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('application/x-chat-id')) {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setIsDropTargetChatList(true)
              }
            }}
            onDragEnter={(e) => {
              if (e.dataTransfer.types.includes('application/x-chat-id')) {
                e.preventDefault()
                setIsDropTargetChatList(true)
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setIsDropTargetChatList(false)
              }
            }}
            onDrop={async (e) => {
              e.preventDefault()
              setIsDropTargetChatList(false)
              const chatId = e.dataTransfer.getData('application/x-chat-id')
              if (chatId && onAddChatToProject) {
                await onAddChatToProject(chatId)
              }
              clearDragState()
            }}
            className={cn(
              'relative z-10 flex-1 overflow-y-auto',
              isDropTargetChatList &&
                (isDarkMode
                  ? 'border border-white/30 bg-white/10'
                  : 'border border-gray-400 bg-gray-200/30'),
            )}
          >
            <ChatList
              chats={chatsWithBlank}
              currentChatId={currentChatId}
              currentChatIsBlank={!currentChatId}
              isDarkMode={isDarkMode}
              isLoading={isLoading}
              enableTitleAnimation={true}
              animatedDeleteConfirmation={false}
              isDraggable={!!onRemoveChatFromProject}
              showMoveToProject={!!onMoveChatToProject && projects.length > 0}
              projects={projects.filter((p) => p.id !== project?.id)}
              onSelectChat={(chatId) => {
                if (chatId.startsWith('blank-') || chatId === '') {
                  handleNewChat()
                } else {
                  handleChatSelect(chatId)
                }
              }}
              onUpdateTitle={updateChatTitle}
              onDeleteChat={handleDeleteChat}
              onDragStart={(chatId) =>
                setDraggingChat(chatId, project?.id ?? null)
              }
              onDragEnd={() => clearDragState()}
              onMoveToProject={onMoveChatToProject}
              onRemoveFromProject={onRemoveChatFromProject}
            />
          </div>

          {/* Terms and privacy policy */}
          <div className="relative z-10 flex h-[56px] flex-none items-center justify-center border-t border-border-subtle bg-surface-sidebar p-3">
            <p className="text-center text-xs leading-relaxed text-content-secondary">
              By using this service, you agree to Tinfoil&apos;s{' '}
              <Link
                href="https://tinfoil.sh/terms"
                className={
                  isDarkMode
                    ? 'text-white underline hover:text-content-secondary'
                    : 'text-brand-accent-dark underline hover:text-brand-accent-dark/80'
                }
              >
                Terms of Service
              </Link>{' '}
              and{' '}
              <Link
                href="https://tinfoil.sh/privacy"
                className={
                  isDarkMode
                    ? 'text-white underline hover:text-content-secondary'
                    : 'text-brand-accent-dark underline hover:text-brand-accent-dark/80'
                }
              >
                Privacy Policy
              </Link>
            </p>
          </div>
        </div>
      </div>

      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}
    </>
  )
}
