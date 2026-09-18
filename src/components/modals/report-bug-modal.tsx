'use client'

import { Modal, ModalDescription, ModalTitle } from '@/components/ui/modal'
import { cn } from '@/components/ui/utils'
import { APP_VERSION } from '@/config'
import { SUPPORT_EMAIL } from '@/constants/external-links'
import { useToast } from '@/hooks/use-toast'
import { CheckIcon, ClipboardIcon } from '@heroicons/react/24/outline'
import { useEffect, useState } from 'react'

const COPIED_FEEDBACK_MS = 2000
const DESCRIPTION_MAX_LENGTH = 4000
const REPORT_SUBJECT = 'Tinfoil Chat bug report'
const CONTEXT_SEPARATOR = '---'

interface ReportBugModalProps {
  isOpen: boolean
  onClose: () => void
  isDarkMode: boolean
  /** Model currently selected in the chat, attached to the report for context. */
  selectedModel?: string
}

function buildReportBody(description: string, selectedModel?: string): string {
  const context = [
    `App version: ${APP_VERSION}`,
    selectedModel ? `Model: ${selectedModel}` : null,
    `Browser: ${navigator.userAgent}`,
  ].filter((line): line is string => line !== null)

  return [description.trim(), '', CONTEXT_SEPARATOR, ...context].join('\n')
}

// RFC 6068: mailto query values must be percent-encoded, which
// encodeURIComponent produces. URLSearchParams would emit "+" for spaces,
// which some mail clients render literally.
function buildMailtoUrl(subject: string, body: string): string {
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

export function ReportBugModal({
  isOpen,
  onClose,
  isDarkMode,
  selectedModel,
}: ReportBugModalProps) {
  const { toast } = useToast()
  const [description, setDescription] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!isOpen) {
      setDescription('')
      setCopied(false)
    }
  }, [isOpen])

  useEffect(() => {
    if (!copied) return
    const timeout = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
    return () => clearTimeout(timeout)
  }, [copied])

  const handleOpenEmail = () => {
    const body = buildReportBody(description, selectedModel)
    // Assigning to location.href hands the mailto: URL to the OS. Browsers
    // give no signal about whether a mail client picked it up, so the
    // fallback address stays visible in the modal rather than closing it.
    window.location.href = buildMailtoUrl(REPORT_SUBJECT, body)
    toast({
      title: 'Opening your email client',
      description: `If nothing opens, email us at ${SUPPORT_EMAIL}.`,
    })
  }

  const handleCopyEmail = async () => {
    try {
      await navigator.clipboard.writeText(SUPPORT_EMAIL)
      setCopied(true)
    } catch {
      toast({
        title: 'Copy failed',
        description: `Email us at ${SUPPORT_EMAIL}.`,
        variant: 'destructive',
      })
    }
  }

  const canSend = description.trim().length > 0

  return (
    <Modal isOpen={isOpen} onClose={onClose}>
      <ModalTitle>Report a bug</ModalTitle>
      <ModalDescription className="mt-1">
        Tell us what happened.
      </ModalDescription>

      <label className="mt-4 block">
        <span className="sr-only">Bug description</span>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={DESCRIPTION_MAX_LENGTH}
          rows={5}
          placeholder="What went wrong? What did you expect to happen?"
          autoFocus
          className={cn(
            'w-full resize-none rounded-lg border px-3 py-2 text-sm text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-border-strong',
            isDarkMode
              ? 'border-border-subtle bg-surface-sidebar'
              : 'border-border-subtle bg-white',
          )}
        />
      </label>
      <p className="mt-1 font-aeonik-fono text-xs text-content-muted">
        Your app version, browser, and current model are attached automatically.
        No chat content is included.
      </p>

      <button
        type="button"
        onClick={handleOpenEmail}
        disabled={!canSend}
        className="mt-4 flex w-full items-center justify-center rounded-lg bg-brand-accent-dark px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-accent-dark/90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        Open email client
      </button>

      <div className="mt-3 flex items-center justify-center gap-1.5 text-xs text-content-secondary">
        <span>No email client?</span>
        <button
          type="button"
          onClick={() => void handleCopyEmail()}
          className="inline-flex items-center gap-1 rounded px-1 font-medium text-content-primary transition-colors hover:text-content-secondary"
          aria-label={copied ? 'Email address copied' : `Copy ${SUPPORT_EMAIL}`}
        >
          <span className="underline decoration-content-muted underline-offset-2">
            {SUPPORT_EMAIL}
          </span>
          {copied ? (
            <CheckIcon className="h-3.5 w-3.5 text-green-500" aria-hidden />
          ) : (
            <ClipboardIcon className="h-3.5 w-3.5" aria-hidden />
          )}
        </button>
      </div>
    </Modal>
  )
}
