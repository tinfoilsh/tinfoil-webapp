import { TextureGrid } from '@/components/texture-grid'
import { useToast } from '@/hooks/use-toast'
import {
  deleteSharedChat,
  getShareStatus,
  uploadSharedChat,
} from '@/services/share-api'
import { shareSeal as enclaveShareSeal } from '@/services/sync-enclave/sync-api'
import type { ShareableChatData } from '@/utils/share-payload'
import {
  CheckIcon,
  DocumentDuplicateIcon,
  GlobeAltIcon,
  LinkIcon,
  LockClosedIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useEffect, useRef, useState } from 'react'
import { Card, CardContent } from '../ui/card'
import {
  getMessageAttachments,
  hasMessageAttachments,
} from './attachment-helpers'
import { CONSTANTS } from './constants'
import type { Message } from './types'

type ShareModalProps = {
  isOpen: boolean
  onClose: () => void
  messages: Message[]
  isDarkMode: boolean
  isSidebarOpen?: boolean
  isRightSidebarOpen?: boolean
  chatTitle?: string
  chatCreatedAt?: Date
  chatId?: string
}

export function ShareModal(props: ShareModalProps) {
  return <ShareModalContent key={props.chatId} {...props} />
}

function ShareModalContent({
  isOpen,
  onClose,
  messages,
  isDarkMode,
  isSidebarOpen = false,
  isRightSidebarOpen = false,
  chatTitle,
  chatCreatedAt,
  chatId,
}: ShareModalProps) {
  const { toast } = useToast()
  const [isCopied, setIsCopied] = useState(false)
  const [isLinkCopied, setIsLinkCopied] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [isRevoking, setIsRevoking] = useState(false)
  const [isCheckingShare, setIsCheckingShare] = useState(true)
  const [hasShare, setHasShare] = useState<boolean | null>(null)
  const [statusRetry, setStatusRetry] = useState(0)
  const [isShareEnabled, setIsShareEnabled] = useState(false)
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const contentRef = useRef<HTMLPreElement>(null)
  const shareLinkInputRef = useRef<HTMLInputElement>(null)
  const previousShareUrlRef = useRef<string | null>(null)
  const isMountedRef = useRef(false)
  const isBusy = isUploading || isRevoking
  const canChangeSharing = !isBusy && !isCheckingShare && hasShare !== null

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!isOpen || isBusy) return
    if (!chatId) {
      setHasShare(false)
      setIsCheckingShare(false)
      return
    }

    let ignore = false
    setHasShare(null)
    setIsCheckingShare(true)
    getShareStatus(chatId)
      .then((shared) => {
        if (ignore) return
        setHasShare(shared)
        setIsShareEnabled(shared)
        if (!shared) setShareUrl(null)
      })
      .catch(() => {
        if (!ignore) setHasShare(null)
      })
      .finally(() => {
        if (!ignore) setIsCheckingShare(false)
      })
    return () => {
      ignore = true
    }
  }, [chatId, isOpen, isBusy, statusRetry])

  // Reset modal state when chatId changes (different chat)
  useEffect(() => {
    setShareUrl(null)
    setIsShareEnabled(false)
    setIsLinkCopied(false)
    previousShareUrlRef.current = null
  }, [chatId])

  // Reset transient state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setIsLinkCopied(false)
      setShareUrl(null)
    }
  }, [isOpen, isBusy])

  useEffect(() => {
    if (!shareUrl || !hasShare || isCheckingShare) {
      previousShareUrlRef.current = null
      return
    }
    if (previousShareUrlRef.current !== shareUrl) {
      const frame = requestAnimationFrame(() => {
        shareLinkInputRef.current?.focus()
        previousShareUrlRef.current = shareUrl
      })
      return () => cancelAnimationFrame(frame)
    }
  }, [shareUrl, hasShare, isCheckingShare])

  // Handle keyboard shortcuts
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      // Handle Escape key to close modal
      if (e.key === 'Escape') {
        e.preventDefault()
        if (!isBusy) onClose()
        return
      }

      // Intercept Cmd+A (Mac) or Ctrl+A (Windows/Linux)
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === 'a' &&
        !(
          e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement ||
          (e.target as HTMLElement)?.isContentEditable
        )
      ) {
        e.preventDefault()
        e.stopPropagation()

        // Select all text in the modal content
        if (contentRef.current) {
          const selection = window.getSelection()
          const range = document.createRange()
          range.selectNodeContents(contentRef.current)
          selection?.removeAllRanges()
          selection?.addRange(range)
        }
      }
    }

    // Add event listener
    document.addEventListener('keydown', handleKeyDown)

    // Cleanup
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onClose, isBusy])

  if (!isOpen) return null

  // Convert messages to markdown format
  const convertToMarkdown = () => {
    let markdown = ''

    messages.forEach((message) => {
      if (message.role === 'user') {
        markdown += '## User\n\n'
      } else if (message.role === 'assistant') {
        markdown += '## Assistant\n\n'
      }

      // Add the message content (raw, without processing)
      if (message.content) {
        markdown += message.content + '\n\n'
      }

      // Add attachment references if any
      if (hasMessageAttachments(message)) {
        const allAttachments = getMessageAttachments(message)
        markdown += '**Attachments:**\n'
        allAttachments.forEach((a) => {
          markdown += `- ${a.fileName}\n`
        })
        markdown += '\n'

        // Add document text content if any
        const docTexts = allAttachments
          .filter((a) => a.type === 'document' && a.textContent)
          .map((a) => `Document title: ${a.fileName}\n${a.textContent}`)
        if (docTexts.length > 0) {
          markdown += '**Document Content:**\n'
          markdown += '```\n'
          markdown += docTexts.join('\n\n')
          markdown += '\n```\n\n'
        }
      }

      markdown += '---\n\n'
    })

    return markdown.trim()
  }

  const handleCopy = async () => {
    try {
      const markdown = convertToMarkdown()
      await navigator.clipboard.writeText(markdown)
      setIsCopied(true)
      setTimeout(() => setIsCopied(false), 2000)
    } catch (error) {
      toast({
        title: 'Copy failed',
        description: 'Failed to copy to clipboard',
        variant: 'destructive',
        position: 'top-left',
      })
    }
  }

  const handleCopyShareUrl = async () => {
    if (!shareUrl) return
    try {
      await navigator.clipboard.writeText(shareUrl)
      setIsLinkCopied(true)
      setTimeout(() => setIsLinkCopied(false), 2000)
    } catch {
      toast({
        title: 'Copy failed',
        description: 'Failed to copy link to clipboard',
        variant: 'destructive',
        position: 'top-left',
      })
    }
  }

  const handleShareLink = async () => {
    if (!canChangeSharing) return
    if (!chatId) {
      toast({
        title: 'Share failed',
        description: 'Chat must be saved before sharing',
        variant: 'destructive',
        position: 'top-left',
      })
      return
    }

    setIsUploading(true)
    try {
      const shareableData: ShareableChatData = {
        v: 1,
        title: chatTitle || 'Shared Chat',
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
          modelDisplayName: m.modelDisplayName,
          documentContent:
            m.documentContent ??
            (m.attachments
              ?.filter((a) => a.type === 'document' && a.textContent)
              .map(
                (a) =>
                  `Document title: ${a.fileName}\nDocument contents:\n${a.textContent}`,
              )
              .join('\n\n') ||
              undefined),
          documents:
            m.documents ??
            (m.attachments?.map((a) => ({ name: a.fileName })) || undefined),
          timestamp:
            m.timestamp instanceof Date
              ? m.timestamp.getTime()
              : typeof m.timestamp === 'string'
                ? Date.parse(m.timestamp)
                : m.timestamp,
          thoughts: m.thoughts,
          thinkingDuration: m.thinkingDuration,
          isError: m.isError,
          attachments: m.attachments?.length
            ? m.attachments.map((a) => ({
                id: a.id,
                type: a.type,
                fileName: a.fileName,
                mimeType: a.mimeType,
                thumbnailBase64: a.thumbnailBase64,
                encryptionKey: a.encryptionKey,
                textContent: a.textContent,
                description: a.description,
              }))
            : undefined,
          timeline: m.timeline,
          annotations: m.annotations,
          webSearch: m.webSearch,
          webSearchBeforeThinking: m.webSearchBeforeThinking,
          urlFetches: m.urlFetches,
        })),
        createdAt: chatCreatedAt ? chatCreatedAt.getTime() : Date.now(),
      }

      // Seal through the sync enclave: the enclave generates a fresh
      // share key, gzips, AES-GCM-seals, and returns key + ciphertext.
      // The owner uploads ciphertext to controlplane and embeds the
      // key in the URL fragment with a `v2:` prefix so the recipient
      // can tell which decryption path to use.
      const plaintext = new TextEncoder().encode(JSON.stringify(shareableData))
      let sealed: { share_key: string; ciphertext: string }
      try {
        sealed = await enclaveShareSeal({ plaintext })
      } catch (e) {
        throw new Error(
          `Share seal failed: ${e instanceof Error ? e.message : String(e)}`,
        )
      }

      try {
        if (!isMountedRef.current) return
        const bin = Uint8Array.from(atob(sealed.ciphertext), (c) =>
          c.charCodeAt(0),
        )
        await uploadSharedChat(chatId, bin)
      } catch (e) {
        throw new Error(
          `Upload failed: ${e instanceof Error ? e.message : String(e)}`,
        )
      }

      const url = `${window.location.origin}/share/${chatId}#v2:${sealed.share_key}`
      setShareUrl(url)
      setHasShare(true)
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to create share link'
      toast({
        title: 'Share failed',
        description: errorMessage,
        variant: 'destructive',
        position: 'top-left',
      })
    } finally {
      setIsUploading(false)
    }
  }

  const handleShareEnabledChange = async (enabled: boolean) => {
    if (!canChangeSharing) return
    if (enabled || !chatId) {
      setIsShareEnabled(enabled)
      return
    }

    setIsRevoking(true)
    try {
      await deleteSharedChat(chatId)
      setIsShareEnabled(false)
      setHasShare(false)
      setShareUrl(null)
      setIsLinkCopied(false)
    } catch {
      toast({
        title: 'Could not disable sharing',
        description: 'The link may still be active. Please try again.',
        variant: 'destructive',
        position: 'top-left',
      })
    } finally {
      setIsRevoking(false)
    }
  }

  const markdown = convertToMarkdown()
  const shareStatus = isRevoking
    ? 'Revoking share link'
    : isCheckingShare
      ? 'Checking share status'
      : isLinkCopied
        ? 'Share link copied'
        : shareUrl
          ? 'Share link ready'
          : isUploading
            ? 'Creating share link'
            : ''

  // Calculate the positioning to center within the chat area
  const leftOffset = isSidebarOpen ? CONSTANTS.CHAT_SIDEBAR_WIDTH_PX : 0
  const rightOffset = isRightSidebarOpen
    ? CONSTANTS.SETTINGS_SIDEBAR_WIDTH_PX
    : 0

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isBusy) onClose()
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <DialogPrimitive.Content
          aria-modal="true"
          aria-describedby={undefined}
          className="fixed left-[50%] top-[50%] z-50 flex h-[80vh] w-[90vw] max-w-4xl translate-x-[-50%] translate-y-[-50%] flex-col rounded-site-lg border border-border-subtle bg-surface-card shadow-xl focus:outline-none"
          style={{
            maxWidth: `min(896px, calc(90vw - ${leftOffset + rightOffset}px))`,
            marginLeft: `${(leftOffset - rightOffset) / 2}px`,
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
            <DialogPrimitive.Title className="text-lg font-semibold text-content-primary">
              Share Conversation
            </DialogPrimitive.Title>
            <span className="sr-only" role="status" aria-live="polite">
              {shareStatus}
            </span>
            <button
              onClick={onClose}
              disabled={isBusy}
              aria-label="Close share dialog"
              className="rounded-lg p-1.5 text-content-secondary transition-colors hover:bg-surface-chat"
            >
              <XMarkIcon className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          {/* Content */}
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden p-6">
            <TextureGrid />
            <div className="relative z-10 flex min-h-0 flex-1 flex-col space-y-4">
              {/* Shareable Link Access Card */}
              <div className="flex-none">
                <Card className="overflow-hidden border-border-subtle bg-surface-sidebar">
                  <CardContent className="p-0">
                    <div className="flex items-start gap-4 p-4">
                      <div className="mt-1 rounded-full bg-surface-chat p-2 text-content-secondary">
                        {isShareEnabled ? (
                          <GlobeAltIcon className="h-5 w-5" />
                        ) : (
                          <LockClosedIcon className="h-5 w-5" />
                        )}
                      </div>
                      <div className="flex-1 space-y-4">
                        <div className="space-y-1">
                          <h3 className="text-sm font-medium text-content-primary">
                            {isCheckingShare
                              ? 'Checking share status...'
                              : hasShare === null
                                ? 'Share status unavailable'
                                : hasShare
                                  ? 'Shareable link access'
                                  : 'Private'}
                          </h3>
                          <p className="text-sm text-content-secondary">
                            {hasShare === null
                              ? 'Confirming whether an existing link is active'
                              : hasShare
                                ? 'Anyone with the link can view'
                                : 'Only you have access'}
                          </p>
                          {!isCheckingShare && hasShare === null && (
                            <button
                              onClick={() =>
                                setStatusRetry((value) => value + 1)
                              }
                              className="text-sm underline"
                            >
                              Retry share status
                            </button>
                          )}
                        </div>

                        <label className="group flex cursor-pointer items-center gap-3">
                          <div className="relative flex items-center">
                            <input
                              type="checkbox"
                              checked={isShareEnabled}
                              disabled={!canChangeSharing}
                              onChange={(e) =>
                                void handleShareEnabledChange(e.target.checked)
                              }
                              aria-label="Make this conversation shareable with anyone who has the link"
                              className="peer h-5 w-5 cursor-pointer appearance-none rounded border border-border-subtle bg-surface-chat transition-all checked:border-brand-accent-dark checked:bg-brand-accent-dark"
                            />
                            <CheckIcon className="pointer-events-none absolute left-1/2 top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 text-white opacity-0 peer-checked:opacity-100" />
                          </div>
                          <span className="text-sm font-medium text-content-primary">
                            Make this conversation shareable with anyone who has
                            the link
                          </span>
                        </label>

                        <p className="text-sm text-content-secondary">
                          {isRevoking
                            ? 'Revoking share link...'
                            : 'Disabling sharing deactivates existing links. Copies already saved by recipients cannot be removed.'}
                        </p>

                        {hasShare && !shareUrl && (
                          <p className="text-sm text-content-secondary">
                            An existing link is active. Creating a new link will
                            replace it and invalidate the previous link.
                          </p>
                        )}

                        {isShareEnabled && !shareUrl && (
                          <div className="flex justify-start pt-2">
                            <button
                              onClick={handleShareLink}
                              disabled={!canChangeSharing || !chatId}
                              className="flex items-center justify-center gap-2 rounded-lg bg-brand-accent-dark px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-accent-dark/90 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {isUploading ? (
                                <>
                                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                                  Uploading...
                                </>
                              ) : (
                                <>
                                  <LinkIcon className="h-4 w-4" />
                                  {hasShare
                                    ? 'Replace share link'
                                    : 'Create share link'}
                                </>
                              )}
                            </button>
                          </div>
                        )}

                        {isShareEnabled && hasShare && shareUrl && (
                          <div className="flex items-center gap-2 pt-2">
                            <input
                              ref={shareLinkInputRef}
                              type="text"
                              readOnly
                              value={shareUrl}
                              aria-label="Share link"
                              className="flex-1 rounded-lg border border-border-subtle bg-surface-chat px-3 py-2 text-sm text-content-primary"
                              onClick={(e) => e.currentTarget.select()}
                            />
                            <button
                              onClick={handleCopyShareUrl}
                              disabled={!canChangeSharing}
                              className="flex items-center justify-center gap-2 rounded-lg bg-brand-accent-dark px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-accent-dark/90"
                            >
                              {isLinkCopied ? (
                                <>
                                  <CheckIcon className="h-4 w-4" />
                                  Copied!
                                </>
                              ) : (
                                <>
                                  <DocumentDuplicateIcon className="h-4 w-4" />
                                  Copy
                                </>
                              )}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Raw Markdown Card */}
              <Card className="flex min-h-0 flex-1 flex-col overflow-hidden border-border-subtle bg-surface-sidebar">
                <div className="flex flex-none items-center justify-between border-b border-border-subtle/50 p-4">
                  <h3 className="text-sm font-medium text-content-primary">
                    Raw Markdown
                  </h3>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleCopy}
                      className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-chat px-3 py-1.5 text-xs font-medium text-content-primary transition-colors hover:bg-surface-chat/80"
                    >
                      {isCopied ? (
                        <>
                          <CheckIcon className="h-3 w-3" />
                          Copied!
                        </>
                      ) : (
                        <>
                          <DocumentDuplicateIcon className="h-3 w-3" />
                          Copy to Clipboard
                        </>
                      )}
                    </button>
                  </div>
                </div>
                <div className="flex min-h-0 flex-1 flex-col p-4">
                  <pre
                    ref={contentRef}
                    tabIndex={0}
                    aria-label="Raw conversation markdown"
                    className="flex-1 overflow-auto whitespace-pre-wrap font-mono text-[13px] text-content-primary"
                  >
                    {markdown}
                  </pre>
                </div>
              </Card>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
