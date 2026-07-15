import type { BaseModel } from '@/config/models'
import { useUser } from '@clerk/nextjs'
import { Dialog, Transition } from '@headlessui/react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { FaLock, FaLockOpen } from 'react-icons/fa6'
import {
  PiCamera,
  PiEyeSlash,
  PiFileText,
  PiGlobe,
  PiKey,
  PiLightning,
  PiLock,
  PiShieldCheck,
  PiWaveform,
} from 'react-icons/pi'
import { TbBrain } from 'react-icons/tb'

interface OnboardingModalProps {
  isOpen: boolean
  onComplete: (selectedModel?: string) => void
  models: BaseModel[]
  isDarkMode: boolean
}

const TOTAL_PAGES = 3

export function OnboardingModal({
  isOpen,
  onComplete,
  models,
  isDarkMode,
}: OnboardingModalProps) {
  const { user } = useUser()
  const [currentPage, setCurrentPage] = useState(0)
  const [privacyEnabled, setPrivacyEnabled] = useState(false)
  const [selectedModelName, setSelectedModelName] = useState<
    string | undefined
  >()

  const handleContinue = useCallback(() => {
    if (currentPage < TOTAL_PAGES - 1) {
      setCurrentPage((p) => p + 1)
    } else {
      // Persist to Clerk unsafeMetadata
      user
        ?.update({
          unsafeMetadata: {
            ...user.unsafeMetadata,
            has_completed_onboarding: true,
          },
        })
        .catch(() => {})
      onComplete(selectedModelName)
    }
  }, [currentPage, onComplete, user, selectedModelName])

  const handleSkip = useCallback(() => {
    user
      ?.update({
        unsafeMetadata: {
          ...user.unsafeMetadata,
          has_completed_onboarding: true,
        },
      })
      .catch(() => {})
    onComplete()
  }, [onComplete, user])

  const canContinue = currentPage !== 0 || privacyEnabled

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={() => {}}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <Dialog.Panel className="w-full max-w-md transform overflow-hidden rounded-2xl bg-surface-card shadow-2xl transition-all">
                <div className="flex max-h-[85vh] min-h-[580px] flex-col">
                  {/* Page content */}
                  <div className="relative min-h-0 flex-1 overflow-y-auto">
                    <AnimatePresence mode="wait">
                      {currentPage === 0 && (
                        <OnboardingPrivacyPage
                          key="privacy"
                          privacyEnabled={privacyEnabled}
                          onToggle={() => setPrivacyEnabled(true)}
                        />
                      )}
                      {currentPage === 1 && (
                        <OnboardingEncryptionPage key="encryption" />
                      )}
                      {currentPage === 2 && (
                        <OnboardingModelsPage
                          key="models"
                          models={models}
                          isDarkMode={isDarkMode}
                          onSelectModel={setSelectedModelName}
                        />
                      )}
                    </AnimatePresence>
                  </div>

                  {/* Bottom navigation */}
                  <div className="flex flex-col items-center gap-3 border-t border-border-subtle px-6 py-5">
                    {/* Page dots */}
                    <div className="flex gap-2">
                      {Array.from({ length: TOTAL_PAGES }).map((_, i) => (
                        <motion.div
                          key={i}
                          className={`h-1.5 rounded-full ${i === currentPage ? 'bg-brand-accent-dark dark:bg-brand-accent-light' : 'bg-border-subtle'}`}
                          animate={{ width: i === currentPage ? 20 : 8 }}
                          transition={{
                            type: 'spring',
                            stiffness: 300,
                            damping: 25,
                          }}
                        />
                      ))}
                    </div>

                    {/* Continue button */}
                    <button
                      onClick={handleContinue}
                      disabled={!canContinue}
                      className="w-full rounded-xl bg-button-send-background px-4 py-3 text-sm font-semibold text-button-send-foreground transition-all disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      {currentPage === TOTAL_PAGES - 1
                        ? 'Get Started'
                        : 'Continue'}
                    </button>

                    {/* Skip */}
                    {currentPage < TOTAL_PAGES - 1 && (
                      <button
                        onClick={handleSkip}
                        className="text-sm text-content-muted transition-colors hover:text-content-secondary"
                      >
                        Skip
                      </button>
                    )}
                  </div>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  )
}

// MARK: - Shared: Snap Carousel for compact viewports

function useIsShortViewport(threshold = 700) {
  const [isShort, setIsShort] = useState(false)
  useEffect(() => {
    const mql = window.matchMedia(`(max-height: ${threshold}px)`)
    setIsShort(mql.matches)
    const handler = (e: MediaQueryListEvent) => setIsShort(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [threshold])
  return isShort
}

function FeatureCarousel({
  items,
  renderItem,
}: {
  items: { key: string }[]
  renderItem: (item: { key: string }, index: number) => ReactNode
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const handleScroll = () => {
      const scrollLeft = el.scrollLeft
      const itemWidth = el.offsetWidth
      const index = Math.round(scrollLeft / itemWidth)
      setActiveIndex(Math.min(index, items.length - 1))
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [items.length])

  return (
    <div className="-mx-6 flex w-[calc(100%+3rem)] flex-col gap-2">
      <div
        ref={scrollRef}
        className="scrollbar-hide flex w-full snap-x snap-mandatory overflow-x-auto overflow-y-hidden px-6"
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        {items.map((item, i) => (
          <div
            key={item.key}
            className="flex w-full shrink-0 snap-start"
            style={{ paddingRight: i < items.length - 1 ? '0.75rem' : 0 }}
          >
            {renderItem(item, i)}
          </div>
        ))}
      </div>
      <div className="flex justify-center gap-1.5">
        {items.map((item, i) => (
          <motion.div
            key={item.key}
            className={`h-1.5 rounded-full ${i === activeIndex ? 'bg-content-secondary' : 'bg-border-subtle'}`}
            animate={{ width: i === activeIndex ? 16 : 6 }}
            transition={{
              type: 'spring',
              stiffness: 300,
              damping: 25,
            }}
          />
        ))}
      </div>
    </div>
  )
}

// MARK: - Page 1: Privacy

function OnboardingPrivacyPage({
  privacyEnabled,
  onToggle,
}: {
  privacyEnabled: boolean
  onToggle: () => void
}) {
  const isShort = useIsShortViewport()

  const explanationItems = [
    {
      key: 'sealed',
      icon: <PiEyeSlash className="h-4 w-4" />,
      title: 'Sealed Processing',
      description:
        'Your messages are end-to-end encrypted to AI models running inside secure hardware. Tinfoil cannot read them.',
    },
    {
      key: 'verifiable',
      icon: <PiShieldCheck className="h-4 w-4" />,
      title: 'Verifiable Privacy',
      description:
        'Our infrastructure runs on confidential computing GPUs with hardware attestation and automatic client-side verification.',
    },
    {
      key: 'protected',
      icon: <PiLock className="h-4 w-4" />,
      title: 'Everything is Protected',
      description:
        'Chats, images, documents, and voice input are all encrypted end-to-end.',
    },
  ]

  return (
    <motion.div
      className="flex flex-col items-center px-6 py-8"
      initial={{ opacity: 0, x: 40 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -40 }}
      transition={{ duration: 0.3, ease: 'easeInOut' }}
    >
      <div className="flex w-full flex-col items-center gap-5">
        {/* Lock icon in circle - hidden on short viewports */}
        {!isShort && (
          <motion.div
            className="flex h-16 w-16 items-center justify-center rounded-full border border-border-subtle bg-surface-chat"
            animate={privacyEnabled ? { scale: [1, 1.15, 1] } : {}}
            transition={{ duration: 0.4 }}
          >
            {privacyEnabled ? (
              <FaLock className="h-7 w-7 text-content-primary" />
            ) : (
              <FaLockOpen className="h-7 w-7 text-content-primary" />
            )}
          </motion.div>
        )}

        <div className="space-y-2 text-center">
          <h2 className="font-aeonik text-3xl font-bold text-content-primary">
            Privacy First
          </h2>
          <p className="text-base text-content-secondary">
            Tinfoil is built for people who believe their conversations are
            nobody else&apos;s business.
          </p>
        </div>

        {/* Toggle card with animated border */}
        <PrivacyToggleCard enabled={privacyEnabled} onToggle={onToggle} />

        {/* Explanation rows - carousel on short viewports, stacked on tall */}
        <AnimatePresence>
          {privacyEnabled && (
            <motion.div
              className="w-full"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.5, ease: 'easeInOut' }}
            >
              {isShort ? (
                <FeatureCarousel
                  items={explanationItems}
                  renderItem={(item, _i) => {
                    const data = explanationItems.find(
                      (e) => e.key === item.key,
                    )!
                    return (
                      <ExplanationRow
                        icon={data.icon}
                        title={data.title}
                        description={data.description}
                        fillHeight
                      />
                    )
                  }}
                />
              ) : (
                <div className="flex w-full flex-col gap-3">
                  {explanationItems.map((item, i) => (
                    <ExplanationRow
                      key={item.key}
                      icon={item.icon}
                      title={item.title}
                      description={item.description}
                      delay={0.1 * (i + 1)}
                    />
                  ))}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}

function PrivacyToggleCard({
  enabled,
  onToggle,
}: {
  enabled: boolean
  onToggle: () => void
}) {
  const borderRef = useRef<HTMLDivElement>(null)
  const [borderAngle, setBorderAngle] = useState(0)

  // Animated border rotation when not enabled
  useEffect(() => {
    if (enabled) return
    let raf: number
    const animate = () => {
      setBorderAngle((a) => (a + 0.8) % 360)
      raf = requestAnimationFrame(animate)
    }
    raf = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(raf)
  }, [enabled])

  return (
    <div className="relative w-full">
      {/* Animated border */}
      {!enabled && (
        <div
          ref={borderRef}
          className="absolute -inset-[1px] rounded-2xl"
          style={{
            background: `conic-gradient(from ${borderAngle}deg, transparent 0%, transparent 30%, hsl(var(--color-accent-light)) 50%, transparent 70%, transparent 100%)`,
            opacity: 0.5,
          }}
        />
      )}

      <button
        onClick={onToggle}
        className={`relative flex w-full items-center justify-between rounded-2xl border p-5 text-left transition-all duration-500 ${
          enabled
            ? 'border-brand-accent-light/30 bg-brand-accent-light/5'
            : 'border-transparent bg-surface-chat'
        }`}
      >
        <div>
          <p className="text-base font-semibold text-content-primary">
            {enabled ? 'Private' : 'Tap to enable privacy'}
          </p>
          {enabled && (
            <motion.p
              className="mt-0.5 text-sm text-content-secondary"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.2 }}
            >
              Your conversations are protected
            </motion.p>
          )}
        </div>

        {/* Toggle switch */}
        <div
          className={`flex h-7 w-12 items-center rounded-full px-1 transition-colors duration-300 ${
            enabled
              ? 'bg-brand-accent-dark dark:bg-brand-accent-light'
              : 'bg-border-subtle'
          }`}
        >
          <motion.div
            className="h-5 w-5 rounded-full bg-white shadow-sm"
            animate={{ x: enabled ? 18 : 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
          />
        </div>
      </button>
    </div>
  )
}

function ExplanationRow({
  icon,
  title,
  description,
  delay = 0,
  fillHeight = false,
}: {
  icon: React.ReactNode
  title: string
  description: string
  delay?: number
  fillHeight?: boolean
}) {
  return (
    <motion.div
      className={`flex items-start gap-3 rounded-xl border border-border-subtle bg-surface-chat p-4 ${fillHeight ? 'h-full' : ''}`}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay, ease: 'easeOut' }}
    >
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-card text-content-primary">
        {icon}
      </div>
      <div>
        <p className="font-aeonik text-sm font-semibold text-content-primary">
          {title}
        </p>
        <p className="text-sm text-content-secondary">{description}</p>
      </div>
    </motion.div>
  )
}

// MARK: - Page 2: Encryption

function OnboardingEncryptionPage() {
  const isShort = useIsShortViewport()

  return (
    <motion.div
      className="flex flex-col items-center px-6 py-8"
      initial={{ opacity: 0, x: 40 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -40 }}
      transition={{ duration: 0.3, ease: 'easeInOut' }}
    >
      <div className="flex w-full flex-col items-center gap-6">
        {/* Animated icon - hidden on short viewports */}
        {!isShort && (
          <motion.div
            className="relative"
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          >
            <div className="flex h-20 w-20 items-center justify-center rounded-full border border-border-subtle bg-surface-chat">
              <PiKey className="h-9 w-9 text-content-primary" />
            </div>
            <motion.div
              className="absolute -right-1 -top-1 flex h-7 w-7 items-center justify-center rounded-full border border-border-subtle bg-surface-card"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.3, type: 'spring', stiffness: 400 }}
            >
              <FaLock className="h-3.5 w-3.5 text-content-primary" />
            </motion.div>
          </motion.div>
        )}

        <div className="space-y-2 text-center">
          <h2 className="font-aeonik text-3xl font-bold text-content-primary">
            Your Key, Your Data
          </h2>
          <p className="text-base text-content-secondary">
            Every chat is encrypted with a key that only exists on your device.
            Nobody but you can read your conversations.
          </p>
        </div>

        <motion.div
          className="w-full overflow-hidden rounded-xl border border-border-subtle bg-surface-chat"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4, duration: 0.4 }}
        >
          <div className="flex items-start gap-3 p-4">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-card text-content-primary">
              <PiKey className="h-4 w-4" />
            </div>
            <div>
              <p className="font-aeonik text-sm font-semibold text-content-primary">
                Device-Only Key
              </p>
              <p className="text-sm text-content-secondary">
                Your encryption key never leaves your device. It&apos;s the only
                way to decrypt your conversations - don&apos;t lose it!
              </p>
            </div>
          </div>
        </motion.div>
      </div>
    </motion.div>
  )
}

// MARK: - Page 3: Models

function OnboardingModelsPage({
  models,
  isDarkMode,
  onSelectModel,
}: {
  models: BaseModel[]
  isDarkMode: boolean
  onSelectModel: (modelName: string) => void
}) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  const chatModels = models.filter(
    (m) => (m.type === 'chat' || m.type === 'code') && m.chat === true,
  )

  useEffect(() => {
    if (chatModels.length > 0) {
      onSelectModel(chatModels[0].modelName)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const getModelIcon = (model: BaseModel) => {
    if (model.image === 'openai.png')
      return `/model-icons/openai-${isDarkMode ? 'dark' : 'light'}.png`
    if (model.image === 'moonshot.png')
      return `/model-icons/moonshot-${isDarkMode ? 'dark' : 'light'}.png`
    return `/model-icons/${model.image}`
  }

  const isShort = useIsShortViewport()

  const features = [
    {
      key: 'image-upload',
      icon: <PiCamera className="h-4 w-4" />,
      label: 'Image Upload',
    },
    {
      key: 'document-processing',
      icon: <PiFileText className="h-4 w-4" />,
      label: 'Document Processing',
    },
    {
      key: 'web-search',
      icon: <PiGlobe className="h-4 w-4" />,
      label: 'Web Search',
    },
    {
      key: 'voice-input',
      icon: <PiWaveform className="h-4 w-4" />,
      label: 'Voice Input',
    },
    {
      key: 'reasoning-models',
      icon: <TbBrain className="h-4 w-4" />,
      label: 'Reasoning Models',
    },
    {
      key: 'fast-responses',
      icon: <PiLightning className="h-4 w-4" />,
      label: 'Fast Responses',
    },
  ]

  return (
    <motion.div
      className={`flex flex-col items-center px-6 ${isShort ? 'py-5' : 'py-8'}`}
      initial={{ opacity: 0, x: 40 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -40 }}
      transition={{ duration: 0.3, ease: 'easeInOut' }}
    >
      <div
        className={`flex w-full flex-col items-center ${isShort ? 'gap-3' : 'gap-5'}`}
      >
        <div className="space-y-2 text-center">
          <h2 className="font-aeonik text-3xl font-bold text-content-primary">
            Powerful Models
          </h2>
          <p className="text-base text-content-secondary">
            Access leading AI models, all running inside secure hardware
            enclaves with verified privacy.
          </p>
        </div>

        {/* Model carousel */}
        {chatModels.length > 0 && (
          <div
            ref={scrollRef}
            className={`scrollbar-hide -mx-6 flex w-[calc(100%+3rem)] gap-3 overflow-x-auto px-6 ${isShort ? 'py-1' : 'py-2'}`}
            style={{ WebkitOverflowScrolling: 'touch' }}
          >
            {chatModels.map((model, i) => (
              <button
                key={model.modelName}
                onClick={() => {
                  setSelectedIndex(i)
                  onSelectModel(model.modelName)
                }}
                className={`flex shrink-0 flex-col items-center gap-1.5 rounded-xl px-3 py-2 transition-all ${
                  i === selectedIndex
                    ? 'bg-surface-chat ring-1 ring-border-subtle'
                    : 'opacity-60 hover:opacity-100'
                }`}
              >
                <div
                  className={`flex h-12 w-12 items-center justify-center rounded-full transition-transform ${
                    i === selectedIndex ? 'scale-110' : ''
                  }`}
                >
                  <img
                    src={getModelIcon(model)}
                    alt={model.name}
                    className="h-8 w-8 object-contain"
                  />
                </div>
                <span className="max-w-[60px] truncate text-[10px] font-medium text-content-secondary">
                  {model.nameShort}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Feature grid - 4 items on short viewports, all 6 on tall */}
        <div className="grid w-full grid-cols-2 gap-2">
          {(isShort ? features.slice(0, 4) : features).map((feature, i) => (
            <motion.div
              key={feature.key}
              className="flex items-center gap-2.5 rounded-xl bg-surface-chat px-3 py-2.5"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                delay: 0.15 + i * 0.06,
                duration: 0.35,
                ease: 'easeOut',
              }}
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-card text-content-primary">
                {feature.icon}
              </div>
              <span className="text-sm font-medium text-content-primary">
                {feature.label}
              </span>
            </motion.div>
          ))}
        </div>
      </div>
    </motion.div>
  )
}
