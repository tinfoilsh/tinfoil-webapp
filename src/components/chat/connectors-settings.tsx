import { Modal, ModalDescription, ModalTitle } from '@/components/ui/modal'
import { cn } from '@/components/ui/utils'
import { useConnectors, type ConnectorList } from '@/hooks/use-connectors'
import {
  describeConnectorError,
  isConnected,
} from '@/services/harness/connectors'
import { useHarness } from '@/services/harness/provider'
import type {
  Connector,
  ConnectorTool,
  ToolPermission,
} from '@/services/harness/types'
import {
  TfBoxCheckmark,
  TfMagnifyingGlass,
  TfWarning,
} from '@tinfoilsh/tinfoil-icons'
import {
  TfChevronDownAnimated,
  TfPlusAnimated,
  TfRefreshTwoArrowsAnimated,
} from '@tinfoilsh/tinfoil-icons/animated'
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import { PiSpinner } from 'react-icons/pi'
import { ConfirmDialog } from './components/confirm-dialog'
import { ConnectorIcon } from './components/connector-icon'

// A server the catalog lists, as src/constants/connector-catalog.json holds
// it.
interface CatalogEntry {
  id: string
  name: string
  url: string
  vendor: string
  website: string
  description: string
  categories: string[]
}

// How many catalog servers show at first, and how many more each "Show
// more" adds.
const CATALOG_PAGE = 24
// The longest name a connector may have.
const MAX_NAME_LENGTH = 64
const ALL_CATEGORIES = 'All'

const PERMISSIONS: { value: ToolPermission; label: string }[] = [
  { value: 'allow', label: 'Always allow' },
  { value: 'ask', label: 'Ask first' },
  { value: 'off', label: 'Off' },
]
// A permission this client does not know shows as ask.
const shownPermission = (permission: ToolPermission): ToolPermission =>
  PERMISSIONS.some(({ value }) => value === permission) ? permission : 'ask'

const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

const SWITCH_CLASS_NAME =
  "peer h-5 w-9 rounded-full border border-border-subtle bg-content-muted/40 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-content-muted/70 after:shadow-sm after:transition-all after:content-[''] peer-checked:bg-primary peer-checked:after:translate-x-full peer-checked:after:bg-primary-foreground peer-focus:outline-none peer-disabled:opacity-50"
const SECONDARY_BUTTON_CLASS_NAME =
  'inline-flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-content-primary transition-colors hover:bg-surface-chat disabled:cursor-not-allowed disabled:opacity-50'
const PRIMARY_BUTTON_CLASS_NAME =
  'inline-flex items-center justify-center gap-1.5 rounded-lg bg-tinfoil-oak px-3 py-1.5 text-xs font-medium text-brand-dark transition-colors hover:bg-tinfoil-oak-hover disabled:cursor-not-allowed disabled:opacity-50'

function ToolRow({
  tool,
  disabled,
  onChange,
}: {
  tool: ConnectorTool
  disabled: boolean
  onChange: (permission: ToolPermission) => void
}) {
  const labelId = useId()
  const permission = shownPermission(tool.permission)
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            id={labelId}
            className="truncate font-aeonik text-sm text-content-primary"
          >
            {tool.title || tool.name}
          </span>
          {tool.readOnly && (
            <span className="shrink-0 rounded border border-border-subtle px-1.5 font-aeonik-fono text-[10px] uppercase text-content-muted">
              Read-only
            </span>
          )}
        </div>
        {tool.description && (
          <p className="line-clamp-2 font-aeonik-fono text-xs text-content-muted">
            {tool.description}
          </p>
        )}
      </div>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="flex shrink-0 rounded-lg border border-border-subtle p-0.5"
      >
        {PERMISSIONS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={permission === value}
            disabled={disabled}
            onClick={() => {
              if (permission !== value) onChange(value)
            }}
            className={cn(
              'rounded-md px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed',
              permission === value
                ? 'bg-primary text-primary-foreground'
                : 'text-content-secondary hover:bg-surface-chat',
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </li>
  )
}

function ConnectorRow({
  connector,
  website,
  list,
}: {
  connector: Connector
  website?: string
  list: ConnectorList
}) {
  const detailsId = useId()
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState<'signIn' | 'refresh' | 'remove' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmingRemoval, setConfirmingRemoval] = useState(false)
  const connected = isConnected(connector)

  const run = async (
    action: 'signIn' | 'refresh' | 'remove' | null,
    change: () => Promise<unknown>,
  ) => {
    setError(null)
    setBusy(action)
    try {
      await change()
    } catch (cause) {
      setError(describeConnectorError(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <li>
      <div className="flex items-center gap-3 px-4 py-3">
        <ConnectorIcon
          url={website ?? connector.url}
          name={connector.name}
          className="h-6 w-6"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-aeonik text-sm font-medium text-content-primary">
            {connector.name}
          </div>
          <div className="flex items-center gap-1.5 font-aeonik-fono text-xs text-content-muted">
            <span
              className={cn(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                connected ? 'bg-emerald-500' : 'bg-orange-500',
              )}
              aria-hidden="true"
            />
            <span>{connected ? 'Connected' : 'Sign in needed'}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate">{hostOf(connector.url)}</span>
          </div>
        </div>
        {!connected && (
          <button
            type="button"
            onClick={() => void run('signIn', () => list.signIn(connector.id))}
            disabled={busy !== null}
            className={PRIMARY_BUTTON_CLASS_NAME}
          >
            {busy === 'signIn' && (
              <PiSpinner className="h-3.5 w-3.5 animate-spin" aria-hidden />
            )}
            Sign in
          </button>
        )}
        <label className="relative inline-flex shrink-0 cursor-pointer items-center">
          <input
            type="checkbox"
            checked={connector.enabled}
            aria-label={`Use ${connector.name} in chats`}
            onChange={(event) => {
              const enabled = event.target.checked
              void run(null, () => list.update(connector.id, { enabled }))
            }}
            className="peer sr-only"
          />
          <div className={SWITCH_CLASS_NAME} />
        </label>
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-controls={detailsId}
          aria-label={`${connector.name} details`}
          className="rounded-md p-1 text-content-muted transition-colors hover:bg-surface-chat hover:text-content-primary"
        >
          <TfChevronDownAnimated
            className={cn(
              'h-4 w-4 transition-transform',
              expanded && 'rotate-180',
            )}
            aria-hidden="true"
          />
        </button>
      </div>
      {error && (
        <p role="alert" className="px-4 pb-3 text-xs text-red-600">
          {error}
        </p>
      )}
      {expanded && (
        <div
          id={detailsId}
          className="border-t border-border-subtle bg-surface-muted/40"
        >
          {connector.tools.length > 0 ? (
            <ul
              aria-label={`${connector.name} tools`}
              className="divide-y divide-border-subtle"
            >
              {connector.tools.map((tool) => (
                <ToolRow
                  key={tool.name}
                  tool={tool}
                  disabled={busy !== null}
                  onChange={(permission) =>
                    void run(null, () =>
                      list.update(connector.id, {
                        tools: { [tool.name]: permission },
                      }),
                    )
                  }
                />
              ))}
            </ul>
          ) : (
            <p className="px-4 py-3 text-xs text-content-muted">
              {connected
                ? 'This server offers no tools.'
                : 'Sign in to see the tools this server offers.'}
            </p>
          )}
          <div className="flex flex-wrap gap-2 border-t border-border-subtle px-4 py-3">
            {connector.signIn && connected && (
              <button
                type="button"
                onClick={() =>
                  void run('signIn', () => list.signIn(connector.id))
                }
                disabled={busy !== null}
                className={SECONDARY_BUTTON_CLASS_NAME}
              >
                {busy === 'signIn' && (
                  <PiSpinner className="h-3.5 w-3.5 animate-spin" aria-hidden />
                )}
                Sign in again
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                void run('refresh', () => list.refreshTools(connector.id))
              }
              disabled={busy !== null || !connected}
              className={SECONDARY_BUTTON_CLASS_NAME}
            >
              {busy === 'refresh' ? (
                <PiSpinner className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <TfRefreshTwoArrowsAnimated
                  className="h-3.5 w-3.5"
                  aria-hidden="true"
                />
              )}
              Refresh tools
            </button>
            <button
              type="button"
              onClick={() => setConfirmingRemoval(true)}
              disabled={busy !== null}
              className={cn(
                SECONDARY_BUTTON_CLASS_NAME,
                'text-red-600 hover:text-red-700',
              )}
            >
              {busy === 'remove' && (
                <PiSpinner className="h-3.5 w-3.5 animate-spin" aria-hidden />
              )}
              Remove
            </button>
          </div>
        </div>
      )}
      <ConfirmDialog
        isOpen={confirmingRemoval}
        title={`Remove ${connector.name}?`}
        description="Chats will no longer use its tools, and Tinfoil Chat will sign out of it."
        confirmLabel="Remove"
        variant="destructive"
        onConfirm={() => {
          setConfirmingRemoval(false)
          void run('remove', () => list.remove(connector.id))
        }}
        onCancel={() => setConfirmingRemoval(false)}
      />
    </li>
  )
}

function CatalogCard({
  entry,
  added,
  list,
}: {
  entry: CatalogEntry
  added: boolean
  list: ConnectorList
}) {
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const connect = async () => {
    setError(null)
    setConnecting(true)
    try {
      await list.add(entry.name, entry.url)
    } catch (cause) {
      setError(describeConnectorError(cause))
    } finally {
      setConnecting(false)
    }
  }
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-raised p-3">
      <div className="flex items-start gap-3">
        <ConnectorIcon
          url={entry.website}
          name={entry.name}
          className="h-8 w-8"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-aeonik text-sm font-medium text-content-primary">
            {entry.name}
          </div>
          <div className="truncate font-aeonik-fono text-xs text-content-muted">
            {entry.vendor}
          </div>
        </div>
        {added ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-content-muted">
            <TfBoxCheckmark className="h-4 w-4" aria-hidden="true" />
            Added
          </span>
        ) : (
          <button
            type="button"
            onClick={() => void connect()}
            disabled={connecting}
            aria-label={`Connect ${entry.name}`}
            className={PRIMARY_BUTTON_CLASS_NAME}
          >
            {connecting ? (
              <PiSpinner className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <TfPlusAnimated className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Connect
          </button>
        )}
      </div>
      <p className="line-clamp-2 text-xs text-content-secondary">
        {entry.description}
      </p>
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </li>
  )
}

function matches(entry: CatalogEntry, query: string) {
  if (!query) return true
  return [entry.name, entry.vendor, entry.description, ...entry.categories]
    .join('\n')
    .toLowerCase()
    .includes(query)
}

function Discover({
  catalog,
  connectors,
  list,
}: {
  catalog: CatalogEntry[] | null
  connectors: Connector[]
  list: ConnectorList
}) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState(ALL_CATEGORIES)
  const [shownCount, setShownCount] = useState(CATALOG_PAGE)
  const categories = useMemo(
    () =>
      [...new Set((catalog ?? []).flatMap((entry) => entry.categories))].sort(
        (a, b) => a.localeCompare(b),
      ),
    [catalog],
  )
  const found = useMemo(() => {
    const term = query.trim().toLowerCase()
    return (catalog ?? []).filter(
      (entry) =>
        (category === ALL_CATEGORIES || entry.categories.includes(category)) &&
        matches(entry, term),
    )
  }, [catalog, query, category])
  const added = new Set(connectors.map((connector) => connector.url))

  return (
    <div className="space-y-3">
      <h3 className="font-aeonik text-sm font-medium text-content-secondary">
        Discover
      </h3>
      <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-raised px-3 py-2">
        <TfMagnifyingGlass
          className="h-4 w-4 flex-none text-content-muted"
          aria-hidden="true"
        />
        <input
          type="text"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setShownCount(CATALOG_PAGE)
          }}
          placeholder="Search connectors"
          aria-label="Search connectors"
          className="min-w-0 flex-1 bg-surface-raised font-aeonik text-sm text-content-primary placeholder:text-content-muted focus:outline-none"
        />
      </div>
      {categories.length > 0 && (
        <div
          role="group"
          aria-label="Categories"
          className="flex flex-wrap gap-1.5"
        >
          {[ALL_CATEGORIES, ...categories].map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={category === name}
              onClick={() => {
                setCategory(name)
                setShownCount(CATALOG_PAGE)
              }}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                category === name
                  ? 'border-transparent bg-primary text-primary-foreground'
                  : 'border-border-subtle text-content-secondary hover:bg-surface-chat',
              )}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      {catalog === null ? (
        <p role="status" className="text-sm text-content-muted">
          Loading connectors…
        </p>
      ) : found.length === 0 ? (
        <p className="text-sm text-content-muted">
          No connectors match your search.
        </p>
      ) : (
        <>
          <ul
            aria-label="Connectors you can add"
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            {found.slice(0, shownCount).map((entry) => (
              <CatalogCard
                key={entry.id}
                entry={entry}
                added={added.has(entry.url)}
                list={list}
              />
            ))}
          </ul>
          {found.length > shownCount && (
            <button
              type="button"
              onClick={() => setShownCount((count) => count + CATALOG_PAGE)}
              className={SECONDARY_BUTTON_CLASS_NAME}
            >
              Show more ({found.length - shownCount} left)
            </button>
          )}
        </>
      )}
    </div>
  )
}

// Why a custom connector's fields cannot be sent, if they cannot.
function customFieldsProblem(name: string, url: string): string | null {
  if (!name) return 'Enter a name.'
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'Enter the server’s full address, starting with https://.'
  }
  return parsed.protocol === 'https:'
    ? null
    : 'The address must start with https://.'
}

function AddCustomConnector({
  isOpen,
  onClose,
  list,
}: {
  isOpen: boolean
  onClose: () => void
  list: ConnectorList
}) {
  const nameId = useId()
  const urlId = useId()
  const urlHelpId = useId()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    setName('')
    setUrl('')
    setError(null)
    onClose()
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmedName = name.trim()
    const trimmedUrl = url.trim()
    const problem = customFieldsProblem(trimmedName, trimmedUrl)
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    setAdding(true)
    try {
      await list.add(trimmedName, trimmedUrl)
      close()
    } catch (cause) {
      setError(describeConnectorError(cause))
    } finally {
      setAdding(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={adding ? () => {} : close}>
      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        <ModalTitle>Add custom connector</ModalTitle>
        <ModalDescription>
          Connect an MCP server so chats can use its tools.
        </ModalDescription>
        <div className="space-y-1.5">
          <label
            htmlFor={nameId}
            className="block font-aeonik text-sm font-medium text-content-primary"
          >
            Name
          </label>
          <input
            id={nameId}
            value={name}
            maxLength={MAX_NAME_LENGTH}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-lg border border-border-subtle bg-surface-raised px-3 py-2 text-sm text-content-primary focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor={urlId}
            className="block font-aeonik text-sm font-medium text-content-primary"
          >
            MCP server URL (HTTPS)
          </label>
          <input
            id={urlId}
            type="url"
            inputMode="url"
            value={url}
            placeholder="https://"
            aria-describedby={urlHelpId}
            onChange={(event) => setUrl(event.target.value)}
            className="w-full rounded-lg border border-border-subtle bg-surface-raised px-3 py-2 text-sm text-content-primary focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <p id={urlHelpId} className="text-xs text-content-muted">
            The HTTPS address where the server accepts MCP requests, for example
            https://mcp.example.com/mcp.
          </p>
        </div>
        <div className="flex gap-2 rounded-lg border border-orange-500/30 bg-orange-500/10 p-3 text-xs text-content-secondary">
          <TfWarning
            className="h-4 w-4 shrink-0 text-orange-600"
            aria-hidden="true"
          />
          <p>
            Only use connectors from developers you trust. Tinfoil does not
            control which tools developers make available and cannot verify that
            they will work as intended or that they won&apos;t change.
          </p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={close}
            disabled={adding}
            className={SECONDARY_BUTTON_CLASS_NAME}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={adding}
            className={PRIMARY_BUTTON_CLASS_NAME}
          >
            {adding && (
              <PiSpinner className="h-3.5 w-3.5 animate-spin" aria-hidden />
            )}
            Add
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function ConnectorsSettings({ isDarkMode }: { isDarkMode: boolean }) {
  const { cloud, keyLocked } = useHarness()
  const { connectors, loading, listed, error, list } = useConnectors()
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null)
  const [addingCustom, setAddingCustom] = useState(false)
  const cardClass = cn(
    'rounded-lg border border-border-subtle',
    isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
  )

  // The list is read again as the tab opens, and as the user comes back to
  // the page, as from a sign-in that finished in its own window.
  useEffect(() => {
    void list.refresh()
    const refresh = () => void list.refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [list, cloud, keyLocked])

  // The catalog loads with this tab, apart from the rest of the app.
  useEffect(() => {
    let current = true
    void import('@/constants/connector-catalog.json').then((loaded) => {
      if (current) setCatalog(loaded.default as CatalogEntry[])
    })
    return () => {
      current = false
    }
  }, [])
  const websites = useMemo(
    () => new Map((catalog ?? []).map((entry) => [entry.url, entry.website])),
    [catalog],
  )

  if (!cloud)
    return (
      <p className={cn(cardClass, 'p-4 text-sm text-content-secondary')}>
        Connectors work in chats saved to the cloud. Turn on Cloud Sync to use
        them.
      </p>
    )
  if (keyLocked)
    return (
      <p className="rounded-lg border border-orange-500/30 bg-orange-500/10 p-4 font-aeonik-fono text-xs text-content-secondary">
        Unlock your encryption key in Cloud Sync to manage connectors.
      </p>
    )

  return (
    <>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-aeonik text-sm font-medium text-content-secondary">
            Your connectors
          </h3>
          <button
            type="button"
            onClick={() => setAddingCustom(true)}
            className={SECONDARY_BUTTON_CLASS_NAME}
          >
            <TfPlusAnimated className="h-3.5 w-3.5" aria-hidden="true" />
            Add custom connector
          </button>
        </div>
        <p className="text-xs text-content-muted">
          Connectors let chats use tools from apps you sign in to. Tinfoil never
          sees what they return or what you sign in with.
        </p>
        <div className={cardClass}>
          {error ? (
            <div role="alert" className="space-y-2 p-4 text-sm">
              <p className="text-content-muted">{error}</p>
              <button
                type="button"
                onClick={() => void list.refresh()}
                className="text-brand-accent-dark hover:underline dark:text-brand-accent-light"
              >
                Try again
              </button>
            </div>
          ) : !listed && loading ? (
            <p role="status" className="p-4 text-sm text-content-muted">
              Loading your connectors…
            </p>
          ) : connectors.length === 0 ? (
            <p className="p-4 text-sm text-content-muted">
              No connectors yet. Connect one below.
            </p>
          ) : (
            <ul
              aria-label="Your connectors"
              className="divide-y divide-border-subtle"
            >
              {connectors.map((connector) => (
                <ConnectorRow
                  key={connector.id}
                  connector={connector}
                  website={websites.get(connector.url)}
                  list={list}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      <Discover catalog={catalog} connectors={connectors} list={list} />

      <AddCustomConnector
        isOpen={addingCustom}
        onClose={() => setAddingCustom(false)}
        list={list}
      />
    </>
  )
}
