import { CheckCircleIcon } from '@heroicons/react/24/outline'
import { AnimatePresence, motion } from 'framer-motion'
import { memo, useState } from 'react'
import { PiSpinner } from 'react-icons/pi'

type VerificationStep = {
  id: string
  label: string
  description: string
  status: 'pending' | 'loading' | 'success' | 'failed' | 'error'
}

type VerificationStatusDisplayProps = {
  isDarkMode: boolean
  onOpenVerifier: () => void
  verificationDocument?: {
    securityVerified?: boolean
    steps?: {
      [key: string]: {
        status: 'pending' | 'running' | 'success' | 'failed' | 'error'
        error?: string
      }
    }
  }
  isCompact?: boolean
}

export const VerificationStatusDisplay = memo(
  function VerificationStatusDisplay({
    isDarkMode,
    onOpenVerifier,
    verificationDocument,
    isCompact = false,
  }: VerificationStatusDisplayProps) {
    const [isExpanded, setIsExpanded] = useState(false)

    // Convert verification document to steps
    const steps: VerificationStep[] = []

    // Map verification document steps to display steps
    if (verificationDocument?.steps) {
      const stepMapping = {
        verifyEnclave: {
          label: 'Hardware Attestation',
          description: 'Verifying secure hardware enclave',
        },
        verifyCode: {
          label: 'Code Integrity',
          description: 'Verifying code integrity',
        },
        compareMeasurements: {
          label: 'Chat Security',
          description: 'Matching measurements',
        },
      }

      Object.entries(stepMapping).forEach(([stepId, config]) => {
        if (verificationDocument.steps?.[stepId]) {
          const step = verificationDocument.steps[stepId]
          steps.push({
            id: stepId,
            label: config.label,
            description: config.description,
            status:
              step.status === 'running'
                ? 'loading'
                : step.status === 'failed'
                  ? 'error'
                  : (step.status as VerificationStep['status']),
          })
        }
      })
    }

    // If no steps, show default pending state
    if (steps.length === 0) {
      steps.push(
        {
          id: 'verifyEnclave',
          label: 'Hardware Attestation',
          description: 'Verifying secure hardware enclave',
          status: 'pending',
        },
        {
          id: 'verifyCode',
          label: 'Code Integrity',
          description: 'Verifying code integrity',
          status: 'pending',
        },
        {
          id: 'compareMeasurements',
          label: 'Chat Security',
          description: 'Matching measurements',
          status: 'pending',
        },
      )
    }

    // Check overall status
    const isLoading = steps.some((step) => step.status === 'loading')
    const isComplete = verificationDocument?.securityVerified === true
    const hasError = verificationDocument?.securityVerified === false

    const getStepIcon = (status: VerificationStep['status']) => {
      switch (status) {
        case 'success':
          return <CheckCircleIcon className="h-5 w-5 text-emerald-500" />
        case 'error':
          return (
            <div className="relative h-5 w-5 rounded-full bg-red-500">
              <svg
                className="absolute inset-0 h-5 w-5"
                viewBox="0 0 20 20"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M6 6L14 14M14 6L6 14"
                  stroke="white"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </div>
          )
        case 'loading':
          return (
            <div
              className={`h-5 w-5 rounded-full border-2 ${
                isDarkMode ? 'border-gray-600' : 'border-gray-400'
              }`}
            />
          )
        default:
          return (
            <div
              className={`h-5 w-5 rounded-full border-2 ${
                isDarkMode ? 'border-gray-600' : 'border-gray-400'
              }`}
            />
          )
      }
    }

    // Compact mode for inline display
    if (isCompact) {
      const handleToggle = () => {
        if (isComplete) {
          setIsExpanded(!isExpanded)
        } else {
          onOpenVerifier()
        }
      }

      return (
        <motion.div
          id="verification-status"
          initial={{ opacity: 0, x: 10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className="relative mb-2 mt-2 rounded-lg border border-border-subtle bg-transparent"
        >
          <button
            id="verification-expand"
            onClick={handleToggle}
            className="hover:bg-surface-secondary/50 relative flex h-10 w-full items-center justify-between rounded-lg px-4 text-left transition-colors"
            aria-expanded={isExpanded}
          >
            <div className="flex items-center gap-2">
              {hasError ? (
                <div className="h-2 w-2 rounded-full bg-red-500 shadow-[0_0_4px_1px_rgba(239,68,68,0.6)]" />
              ) : isComplete ? (
                <div className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_4px_1px_rgba(16,185,129,0.6)]" />
              ) : (
                <PiSpinner className="h-5 w-5 animate-spin text-content-secondary" />
              )}
              <span
                role="status"
                aria-live="polite"
                className={`font-aeonik-fono ${
                  isComplete
                    ? isDarkMode
                      ? 'text-emerald-500'
                      : 'text-brand-accent-dark'
                    : hasError
                      ? 'text-red-500'
                      : 'text-content-secondary'
                }`}
              >
                {hasError
                  ? 'Security verification failed'
                  : isComplete
                    ? 'Privacy Verified'
                    : 'Verifying security...'}
              </span>
            </div>
            {isComplete && (
              <svg
                className={`h-5 w-5 transform transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            )}
          </button>

          {isComplete && (
            <div
              inert={!isExpanded}
              className="overflow-hidden rounded-b-lg transition-all duration-300 ease-out"
              style={{
                maxHeight: isExpanded ? '600px' : '0px',
              }}
            >
              <div className="relative text-sm text-content-primary">
                <div className="px-4 pt-3">
                  <p className="mb-2">
                    This conversation is private: nobody can see your messages.
                  </p>
                  <p className="mb-4">
                    Each message is end‑to‑end encrypted directly to a secure
                    hardware enclave where it is processed, and never exposed to
                    third parties.
                  </p>
                </div>
                <div className="border-t border-border-subtle" />
                <div className="px-4 pb-4 pt-4">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpenVerifier()
                    }}
                    className="w-full rounded-md bg-brand-accent-dark px-4 py-2 text-sm font-medium text-white transition-all hover:bg-brand-accent-dark/90"
                  >
                    See verification proof
                  </button>
                </div>
              </div>
            </div>
          )}
        </motion.div>
      )
    }

    // Full mode for standalone display
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut', delay: 0.6 }}
      >
        <button
          onClick={onOpenVerifier}
          className={`group text-left transition-opacity hover:opacity-100 ${
            isLoading ? 'opacity-100' : 'opacity-70'
          }`}
        >
          {/* Header */}
          <div className="mb-1 flex items-center gap-2 md:mb-3">
            {hasError ? (
              <div className="h-2 w-2 rounded-full bg-red-500 shadow-[0_0_4px_1px_rgba(239,68,68,0.6)]" />
            ) : isComplete ? (
              <div className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_4px_1px_rgba(16,185,129,0.6)]" />
            ) : (
              <PiSpinner className="h-5 w-5 animate-spin text-content-secondary" />
            )}
            <h3
              role="status"
              aria-live="polite"
              className={`text-xs font-medium ${
                isComplete
                  ? 'text-emerald-500'
                  : hasError
                    ? 'text-red-500'
                    : isDarkMode
                      ? 'text-gray-300'
                      : 'text-gray-600'
              }`}
            >
              {isComplete
                ? 'Verification complete'
                : hasError
                  ? 'Verification failed'
                  : isLoading
                    ? 'Verifying security...'
                    : 'Open verification center →'}
            </h3>
          </div>

          {/* Verification Steps - Inline - Hidden on mobile */}
          <div className="hidden flex-wrap gap-4 text-xs md:flex">
            <AnimatePresence mode="wait">
              {steps.map((step, index) => (
                <motion.div
                  key={step.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{
                    duration: 0.3,
                    delay: index * 0.05,
                  }}
                  className="flex items-center gap-1.5"
                >
                  <span className="scale-75">{getStepIcon(step.status)}</span>
                  <span
                    className={`${
                      step.status === 'success'
                        ? 'text-emerald-500'
                        : step.status === 'error'
                          ? 'text-red-500'
                          : isDarkMode
                            ? 'text-gray-400'
                            : 'text-gray-500'
                    }`}
                  >
                    {step.label}
                  </span>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </button>
      </motion.div>
    )
  },
)
