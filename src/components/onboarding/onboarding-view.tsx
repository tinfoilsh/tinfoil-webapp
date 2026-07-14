import { Logo } from '@/components/logo'
import { Button } from '@/components/ui/button'
import { GridTexture } from '@/components/ui/grid-texture'
import { SETTINGS_HAS_SEEN_ONBOARDING } from '@/constants/storage-keys'
import { logError } from '@/utils/error-handling'
import { useUser } from '@clerk/nextjs'
import { TfLock, TfUnlockOpen } from '@tinfoilsh/tinfoil-icons'
import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useState } from 'react'

interface OnboardingViewProps {
  onComplete: () => void
  /**
   * When false, the completion flag is written neither to localStorage
   * nor to Clerk unsafeMetadata. Used by the dev harness so simulated
   * runs never touch real state.
   */
  persistCompletion?: boolean
}

const TOTAL_PAGES = 2
const PRIVACY_PAGE_INDEX = 1
const PRIVACY_CONFIRMATION_HOLD_S = 0.4
const PRIVACY_CHECK_APPEAR_S = 0.18
const PRIVACY_CONFIRMATION_SEQUENCE_S =
  PRIVACY_CHECK_APPEAR_S + PRIVACY_CONFIRMATION_HOLD_S
const PRIVACY_CHECK_REVEAL_PROGRESS =
  PRIVACY_CHECK_APPEAR_S / PRIVACY_CONFIRMATION_SEQUENCE_S

export function OnboardingView({
  onComplete,
  persistCompletion = true,
}: OnboardingViewProps) {
  const { user } = useUser()
  const [currentPage, setCurrentPage] = useState(0)
  const [privacyEnabled, setPrivacyEnabled] = useState(false)

  const markCompleted = useCallback(() => {
    if (!persistCompletion) return
    localStorage.setItem(SETTINGS_HAS_SEEN_ONBOARDING, 'true')
    user
      ?.update({
        unsafeMetadata: {
          ...user.unsafeMetadata,
          has_completed_onboarding: true,
        },
      })
      .catch((error) => {
        logError('Could not persist onboarding completion', error, {
          component: 'OnboardingView',
          action: 'markCompleted',
        })
      })
  }, [persistCompletion, user])

  const handleContinue = useCallback(() => {
    if (currentPage === PRIVACY_PAGE_INDEX && !privacyEnabled) {
      setPrivacyEnabled(true)
      return
    }
    if (currentPage < TOTAL_PAGES - 1) {
      setCurrentPage((p) => p + 1)
    } else {
      markCompleted()
      onComplete()
    }
  }, [currentPage, privacyEnabled, onComplete, markCompleted])

  return (
    <motion.div
      className="fixed inset-0 z-50 flex flex-col bg-surface-chat-background font-aeonik"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
    >
      <GridTexture opacity={0.02} />
      <div className="relative z-10 flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4">
        <div className="flex w-full max-w-md flex-col items-center">
          {/* Page content */}
          <div className="relative flex min-h-[420px] w-full flex-col items-center justify-center">
            <AnimatePresence mode="wait">
              {currentPage === 0 && <OnboardingLetterPage key="letter" />}
              {currentPage === PRIVACY_PAGE_INDEX && (
                <OnboardingPrivacyPage
                  key="privacy"
                  privacyEnabled={privacyEnabled}
                  onChange={setPrivacyEnabled}
                />
              )}
            </AnimatePresence>
          </div>

          {/* Bottom navigation */}
          <div className="flex flex-col items-center gap-3 px-6 pb-4 pt-2">
            {/* Page dots */}
            <div className="flex gap-2">
              {Array.from({ length: TOTAL_PAGES }).map((_, i) => (
                <motion.div
                  key={i}
                  className={`h-1.5 rounded-full ${i === currentPage ? 'bg-content-primary' : 'bg-border-subtle'}`}
                  animate={{ width: i === currentPage ? 20 : 8 }}
                  transition={{
                    type: 'spring',
                    stiffness: 300,
                    damping: 25,
                  }}
                />
              ))}
            </div>

            <Button
              variant="solid"
              size="landing"
              chevron
              onClick={handleContinue}
              className="w-full"
            >
              {currentPage === PRIVACY_PAGE_INDEX && privacyEnabled
                ? 'Get Started'
                : 'Continue'}
            </Button>
          </div>
        </div>
      </div>

      <p className="relative z-10 text-balance px-6 pb-4 text-center text-sm text-content-muted">
        By continuing, you agree to our{' '}
        <a
          href={TERMS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand-accent-dark underline underline-offset-2 hover:opacity-80 dark:text-brand-accent-light"
        >
          Terms
        </a>{' '}
        and have read our{' '}
        <a
          href={PRIVACY_POLICY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand-accent-dark underline underline-offset-2 hover:opacity-80 dark:text-brand-accent-light"
        >
          Privacy Policy
        </a>
      </p>
    </motion.div>
  )
}

// MARK: - Page 1: Letter from the Founders

const FOUNDERS_LETTER_PARAGRAPHS = [
  'Tinfoil Chat was built as a sanctuary for thought.',
  'At Tinfoil, we believe that AI is the most intimate technology yet created. We see AI as a space to explore, to make mistakes, to think out loud, to reflect with a beautiful and deep intelligence on the other end.',
  <>
    This is <em>your</em> space to explore ideas in private.
  </>,
]

function OnboardingLetterPage() {
  return (
    <motion.div
      className="flex flex-col px-6 py-8"
      initial={{ opacity: 0, x: 40 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -40 }}
      transition={{ duration: 0.3, ease: 'easeInOut' }}
    >
      <div className="flex w-full flex-col gap-5">
        <div className="flex justify-center">
          <Logo className="h-8 w-auto dark:hidden" />
          <Logo dark className="hidden h-8 w-auto dark:block" />
        </div>
        <div className="relative overflow-hidden rounded-xl">
          <img
            src="/onboarding/intro-banner.jpeg"
            alt="A garden seen through a porthole in a dense city"
            width={1024}
            height={338}
            className="w-full object-cover"
          />
          {/* Legibility gradient behind the overlaid title */}
          <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/70 to-transparent" />
          <h2 className="absolute bottom-3 left-4 font-aeonik text-3xl font-bold text-white">
            Why Tinfoil Chat
          </h2>
        </div>
        <div className="flex flex-col gap-4">
          {FOUNDERS_LETTER_PARAGRAPHS.map((paragraph, i) => (
            <motion.p
              key={i}
              className="text-base text-content-secondary"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.4,
                delay: 0.1 * (i + 1),
                ease: 'easeOut',
              }}
            >
              {paragraph}
            </motion.p>
          ))}
        </div>
      </div>
    </motion.div>
  )
}

// MARK: - Page 2: Privacy

const TERMS_URL = 'https://tinfoil.sh/terms'
const PRIVACY_POLICY_URL = 'https://tinfoil.sh/privacy'

function OnboardingPrivacyPage({
  privacyEnabled,
  onChange,
}: {
  privacyEnabled: boolean
  onChange: (enabled: boolean) => void
}) {
  return (
    <motion.div
      className="flex flex-col items-center px-6 py-8"
      initial={{ opacity: 0, x: 40 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -40 }}
      transition={{ duration: 0.3, ease: 'easeInOut' }}
    >
      <div className="flex w-full flex-col items-center gap-8">
        <div className="flex h-28 items-center justify-center">
          <AnimatePresence mode="wait">
            {privacyEnabled ? (
              <motion.div
                key="locked"
                initial={{ opacity: 0, scale: 0.85, rotate: 0 }}
                animate={{
                  opacity: 1,
                  scale: [0.85, 1.12, 1],
                  rotate: [0, -6, 6, -3, 3, 0],
                }}
                exit={{ opacity: 0, scale: 0.85 }}
                transition={{ duration: 0.5, ease: 'easeOut' }}
              >
                <TfLock className="h-24 w-24 text-content-primary" />
              </motion.div>
            ) : (
              <motion.div
                key="unlocked"
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.85 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
              >
                <TfUnlockOpen className="h-24 w-24 text-content-primary" />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="space-y-2 text-center">
          <h2 className="font-aeonik text-3xl font-bold text-content-primary">
            Private, by Design.
          </h2>
          <p className="text-balance text-base text-content-secondary">
            Tinfoil Chat runs every conversation inside secure enclaves, giving
            you access to powerful AI models with verifiable conversation
            privacy.{' '}
            <strong className="font-semibold text-content-primary">
              Even Tinfoil cannot access your conversations.
            </strong>
          </p>
        </div>

        <div className="relative flex min-h-24 w-full items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={() => onChange(!privacyEnabled)}
              aria-label="Toggle privacy"
              aria-pressed={privacyEnabled}
              className={`group flex h-14 w-28 items-center rounded-full p-1 shadow-inner outline-none ${
                privacyEnabled
                  ? 'justify-end bg-brand-accent-dark dark:bg-brand-accent-light'
                  : 'justify-start bg-destructive/90'
              }`}
            >
              <span className="relative flex h-12 w-12 items-center justify-center rounded-full bg-white shadow-md group-active:w-16">
                <AnimatePresence>
                  {privacyEnabled && (
                    <motion.svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={3}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-5 w-5 text-brand-accent-dark"
                      initial={{ scale: 0, opacity: 0 }}
                      animate={{
                        scale: [0, 1, 1],
                        opacity: [0, 1, 1],
                      }}
                      transition={{
                        duration: PRIVACY_CONFIRMATION_SEQUENCE_S,
                        times: [0, PRIVACY_CHECK_REVEAL_PROGRESS, 1],
                        ease: 'easeOut',
                      }}
                    >
                      <path d="M5 13l5 5L20 7" />
                    </motion.svg>
                  )}
                </AnimatePresence>
              </span>
            </button>

            <span
              className={`text-base font-semibold ${
                privacyEnabled
                  ? 'text-brand-accent-dark dark:text-brand-accent-light'
                  : 'text-destructive'
              }`}
            >
              {privacyEnabled ? 'Private' : 'Enable Privacy'}
            </span>
          </div>
        </div>
      </div>
    </motion.div>
  )
}
