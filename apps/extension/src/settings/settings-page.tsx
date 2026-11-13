import { logError } from '@tinfoil/chat-client/logging'
import { DEFAULT_EFFORT } from '@tinfoil/chat-client/models'
import { TextureGrid } from '@tinfoil/chat-ui/texture-grid'
import { ToggleSwitch } from '@tinfoil/chat-ui/toggle-switch'
import { UserAvatar, type AvatarUser } from '@tinfoil/chat-ui/user-avatar'
import { cn } from '@tinfoil/chat-ui/utils'
import { TfLightning } from '@tinfoilsh/tinfoil-icons'
import {
  TfCpuSmileAnimated,
  TfExternalLinkAnimated,
  TfLockLockedAnimated,
  TfLockOpenedAnimated,
  TfPersonAnimated,
  TfShieldCheckAnimated,
} from '@tinfoilsh/tinfoil-icons/animated'
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { WEB_SIGN_IN_URL } from '../config'
import { turnModel } from '../model-choice'
import {
  catalog,
  chosenAutoLevel,
  chosenEffort,
  chosenModel,
  privacyVerified,
  reviewActions,
  useSetting,
} from '../settings'
import { Logo } from '../ui/logo'
import { useDarkMode } from '../ui/theme'
import { ModelPicker } from './model-picker'

const SECTIONS = [
  { id: 'account', label: 'Account', icon: TfPersonAnimated },
  { id: 'model', label: 'Model', icon: TfCpuSmileAnimated },
  { id: 'permissions', label: 'Permissions', icon: TfShieldCheckAnimated },
  { id: 'privacy', label: 'Privacy', icon: TfLockLockedAnimated },
  { id: 'shortcuts', label: 'Shortcuts', icon: TfLightning },
] as const
type SectionId = (typeof SECTIONS)[number]['id']

const REVIEW_ACTIONS_LABEL = 'Review actions before execution'
const ACCOUNT_AVATAR_SIZE_PX = 48
const NAV_AVATAR_SIZE_PX = 20
const SHORTCUTS_URL = 'chrome://extensions/shortcuts'
// The command Chrome gives every extension for its toolbar button, which has
// no description of its own.
const COMMAND_LABELS: Record<string, string> = {
  _execute_action: 'Open Tinfoil Chrome',
}
const CARD_CLASS_NAME =
  'rounded-lg border border-border-subtle bg-white p-4 dark:bg-surface-sidebar'
const DETAIL_CLASS_NAME = 'font-aeonik-fono text-xs text-content-muted'

// The account the extension is signed in to, once that is known: null while
// it is signed out.
export type Account = {
  user: AvatarUser
  name: string
  email?: string
  signOut: () => Promise<void>
}

function subscribeToHash(changed: () => void) {
  addEventListener('hashchange', changed)
  return () => removeEventListener('hashchange', changed)
}

// The section the page's address names, which is the first when it names
// none.
function useSection() {
  const hash = useSyncExternalStore(subscribeToHash, () => location.hash)
  return SECTIONS.find((section) => `#${section.id}` === hash) ?? SECTIONS[0]
}

// Settings that belong together, under what they have in common.
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3">
      <h2 className="font-aeonik text-sm font-medium text-content-secondary">
        {title}
      </h2>
      {children}
    </div>
  )
}

// One setting: what it is, and the control that sets it.
function Setting({
  label,
  detail,
  children,
}: {
  label: string
  detail: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex items-start justify-between">
      <div className="mr-3 min-w-0 flex-1">
        <div className="font-aeonik text-sm font-medium text-content-primary">
          {label}
        </div>
        <div className={DETAIL_CLASS_NAME}>{detail}</div>
      </div>
      {children}
    </div>
  )
}

function AccountSection({ account }: { account: Account | null }) {
  const [signingOut, setSigningOut] = useState(false)
  if (!account)
    return (
      <div className={CARD_CLASS_NAME}>
        <Setting
          label="Not signed in"
          detail="Sign in on Tinfoil’s website. This page updates automatically."
        >
          <a
            href={WEB_SIGN_IN_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-none rounded-lg bg-tinfoil-oak px-4 py-1.5 text-sm font-medium text-brand-dark transition-colors hover:bg-tinfoil-oak-hover"
          >
            Sign in
          </a>
        </Setting>
      </div>
    )
  return (
    <div className={CARD_CLASS_NAME}>
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <UserAvatar user={account.user} size={ACCOUNT_AVATAR_SIZE_PX} />
          <div className="min-w-0">
            <div className="truncate font-aeonik text-base font-medium text-content-primary">
              {account.name}
            </div>
            <div className="truncate text-sm text-content-muted">
              {account.email}
            </div>
          </div>
        </div>
        <button
          type="button"
          disabled={signingOut}
          onClick={() => {
            setSigningOut(true)
            account
              .signOut()
              .catch((cause) => logError('Unable to sign out', cause))
              .finally(() => setSigningOut(false))
          }}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-70 dark:border-red-500/30 dark:bg-red-950/20 dark:text-red-400 dark:hover:bg-red-950/40 md:w-auto md:border-0 md:bg-transparent md:text-red-500 md:hover:bg-red-500/10 dark:md:bg-transparent dark:md:hover:bg-red-500/10"
        >
          {signingOut ? 'Signing out...' : 'Sign out'}
        </button>
      </div>
    </div>
  )
}

function ModelSection({ isDarkMode }: { isDarkMode: boolean }) {
  const [offered] = useSetting(catalog)
  const [model, setModel] = useSetting(chosenModel)
  const [effort, setEffort] = useSetting(chosenEffort)
  const [autoLevel, setAutoLevel] = useSetting(chosenAutoLevel)
  if (offered === undefined) return null
  const turn = turnModel(offered, { model, autoLevel })
  return (
    <Group title="Model">
      <div className={CARD_CLASS_NAME}>
        {offered ? (
          <Setting
            label="Model for new messages"
            detail="Answers your messages and works in your tabs, from the next message you send."
          >
            <ModelPicker
              models={offered.models}
              autoLevels={offered.auto.levels}
              selectedModel={turn.model}
              onSelect={setModel}
              reasoningEffort={effort ?? DEFAULT_EFFORT}
              onEffortChange={setEffort}
              autoIntelligence={turn.autoIntelligence ?? offered.auto.default}
              onAutoIntelligenceChange={setAutoLevel}
              isDarkMode={isDarkMode}
            />
          </Setting>
        ) : (
          <p className={DETAIL_CLASS_NAME}>
            Open the Tinfoil side panel to load the models you can choose from.
          </p>
        )}
      </div>
    </Group>
  )
}

function PermissionsSection() {
  const [review, setReview] = useSetting(reviewActions)
  return (
    <Group title="Browser actions">
      <div className={CARD_CLASS_NAME}>
        <Setting
          label={REVIEW_ACTIONS_LABEL}
          detail="Tinfoil asks before it clicks, types, or opens a page. When off, it acts as soon as it decides to."
        >
          <ToggleSwitch
            aria-label={REVIEW_ACTIONS_LABEL}
            checked={review ?? false}
            disabled={review === undefined}
            onChange={setReview}
          />
        </Setting>
      </div>
    </Group>
  )
}

function PrivacySection() {
  const [verified] = useSetting(privacyVerified)
  const Lock = verified ? TfLockLockedAnimated : TfLockOpenedAnimated
  return (
    <>
      <Group title="Verification">
        <div className={CARD_CLASS_NAME}>
          <div className="flex items-start gap-3">
            <Lock
              className={cn(
                'h-5 w-5 shrink-0',
                verified
                  ? 'text-brand-accent-dark dark:text-brand-accent-light'
                  : 'text-content-muted',
              )}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <div
                role="status"
                className="font-aeonik text-sm font-medium text-content-primary"
              >
                {verified === undefined
                  ? ''
                  : verified
                    ? 'Privacy verified'
                    : 'Not verified yet'}
              </div>
              <div className={DETAIL_CLASS_NAME}>
                Your messages and the pages Tinfoil reads only go to a chat
                service that proves it runs inside a secure enclave. The side
                panel verifies it each time it connects, before it sends
                anything.
              </div>
            </div>
          </div>
        </div>
      </Group>
      <Group title="Your chats">
        <div className={CARD_CLASS_NAME}>
          <Setting
            label="Stored in this browser"
            detail="The chats you have in the side panel, and the record of what Tinfoil did in your tabs, stay on this device."
          />
        </div>
      </Group>
    </>
  )
}

function ShortcutsSection() {
  const [commands, setCommands] = useState<chrome.commands.Command[]>([])
  useEffect(() => {
    let current = true
    const read = () => {
      chrome.commands.getAll().then(
        (all) => {
          if (current) setCommands(all)
        },
        (cause) => logError('Unable to read keyboard shortcuts', cause),
      )
    }
    // A shortcut is changed on Chrome's own page, so they are read again
    // when the user comes back from it.
    const readWhenShown = () => {
      if (document.visibilityState === 'visible') read()
    }
    read()
    document.addEventListener('visibilitychange', readWhenShown)
    return () => {
      current = false
      document.removeEventListener('visibilitychange', readWhenShown)
    }
  }, [])
  return (
    <Group title="Keyboard shortcuts">
      <ul className="divide-y divide-border-subtle rounded-lg border border-border-subtle bg-white dark:bg-surface-sidebar">
        {commands.map((command) => (
          <li
            key={command.name}
            className="flex items-center justify-between gap-3 px-4 py-3"
          >
            <span className="min-w-0 font-aeonik text-sm font-medium text-content-primary">
              {COMMAND_LABELS[command.name ?? ''] ??
                command.description ??
                command.name}
            </span>
            {command.shortcut ? (
              <kbd className="flex-none rounded border border-border-subtle bg-surface-chat px-1.5 py-0.5 font-aeonik-fono text-xs text-content-primary">
                {command.shortcut}
              </kbd>
            ) : (
              <span className={cn('flex-none', DETAIL_CLASS_NAME)}>
                Not set
              </span>
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => {
          chrome.tabs
            .create({ url: SHORTCUTS_URL })
            .catch((cause) => logError('Unable to open shortcuts', cause))
        }}
        className={cn(
          CARD_CLASS_NAME,
          'flex w-full items-center gap-3 text-left transition-colors hover:bg-surface-chat dark:hover:bg-surface-chat',
        )}
      >
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-surface-chat text-content-secondary">
          <TfLightning className="h-5 w-5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-aeonik text-sm font-medium text-content-primary">
            Change shortcuts
          </span>
          <span className={cn('mt-0.5 block', DETAIL_CLASS_NAME)}>
            Chrome keeps the shortcuts of its extensions on one page.
          </span>
        </span>
        <TfExternalLinkAnimated
          className="h-4 w-4 flex-none text-content-muted"
          aria-hidden="true"
        />
      </button>
    </Group>
  )
}

export function SettingsPage({ account }: { account?: Account | null }) {
  const isDarkMode = useDarkMode()
  const section = useSection()
  return (
    <div className="flex min-h-dvh flex-col bg-surface-sidebar font-aeonik text-content-primary md:flex-row">
      <div className="flex flex-none flex-col border-b border-border-subtle md:w-56 md:border-b-0 md:border-r">
        <div className="flex h-14 flex-none items-center px-4 md:px-6">
          <Logo className="h-6 w-auto" dark={isDarkMode} />
        </div>
        <nav
          aria-label="Settings"
          className="flex gap-1 overflow-x-auto px-3 pb-2 md:flex-col md:overflow-visible md:py-2"
        >
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <a
              key={id}
              href={`#${id}`}
              aria-current={id === section.id ? 'page' : undefined}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring md:gap-3 md:py-2.5 md:text-sm',
                id === section.id
                  ? 'bg-primary text-primary-foreground'
                  : 'text-content-secondary hover:bg-surface-chat/50',
              )}
            >
              {id === 'account' && account ? (
                <UserAvatar user={account.user} size={NAV_AVATAR_SIZE_PX} />
              ) : (
                <Icon className="h-4 w-4 md:h-5 md:w-5" aria-hidden="true" />
              )}
              {label}
            </a>
          ))}
        </nav>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 flex-none items-center border-b border-border-subtle px-6">
          <h1 className="font-aeonik text-lg font-semibold text-content-primary">
            {section.label}
          </h1>
        </div>
        <div className="relative flex-1 p-6">
          <TextureGrid />
          <main className="relative z-10 min-w-0 max-w-3xl space-y-6">
            {section.id === 'account' && account !== undefined && (
              <AccountSection account={account} />
            )}
            {section.id === 'model' && <ModelSection isDarkMode={isDarkMode} />}
            {section.id === 'permissions' && <PermissionsSection />}
            {section.id === 'privacy' && <PrivacySection />}
            {section.id === 'shortcuts' && <ShortcutsSection />}
          </main>
        </div>
      </div>
    </div>
  )
}
