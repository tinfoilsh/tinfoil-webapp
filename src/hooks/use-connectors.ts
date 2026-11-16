import type { SettingsTab } from '@/constants/settings-tabs'
import { toast } from '@/hooks/use-toast'
import {
  awaitPopupAnswer,
  finishSignIn,
  openSignIn,
  type CallbackAnswer,
} from '@/services/connectors/sign-in'
import {
  addConnector,
  authorizeConnector,
  deleteConnector,
  describeConnectorError,
  listConnectors,
  refreshConnector,
  updateConnector,
} from '@/services/harness/connectors'
import { CONNECTORS_FEATURE } from '@/services/harness/protocol'
import { useHarness, useSessionFeature } from '@/services/harness/provider'
import { getView, type HarnessAPI } from '@/services/harness/runtime'
import type {
  Connector,
  ConnectorAnswer,
  ConnectorChanges,
} from '@/services/harness/types'
import { logError } from '@/utils/error-handling'
import { stripMessageMarkers } from '@/utils/redirect-url'
import { useEffect, useSyncExternalStore } from 'react'

const CONNECTORS_TAB: SettingsTab = 'connectors'

interface ConnectorListState {
  connectors: Connector[]
  loading: boolean
  // A listing of the account's connectors has finished, so an empty list
  // means it has none.
  listed: boolean
  error: string | null
}

const UNLISTED: ConnectorListState = {
  connectors: [],
  loading: false,
  listed: false,
  error: null,
}

// Where a sign-in that takes this whole tab brings the user back: this
// page, with the settings' Connectors tab open.
function returnAddress(): string {
  return `${stripMessageMarkers(window.location.pathname + window.location.search)}#settings/${CONNECTORS_TAB}`
}

// A connector with the changes an update makes to it.
function changed(connector: Connector, changes: ConnectorChanges): Connector {
  const permissions = changes.tools ?? {}
  return {
    ...connector,
    ...(changes.name !== undefined ? { name: changes.name } : {}),
    ...(changes.enabled !== undefined ? { enabled: changes.enabled } : {}),
    tools: connector.tools.map((tool) =>
      Object.hasOwn(permissions, tool.name)
        ? { ...tool, permission: permissions[tool.name] }
        : tool,
    ),
  }
}

// The account's connectors, which the settings and the composer show. A
// change shows at once in both, as the harness answers it.
export class ConnectorList {
  private state: ConnectorListState = UNLISTED
  private readonly listeners = new Set<() => void>()
  // Only the latest listing applies, so a list read before a change cannot
  // replace the connector the change answered with.
  private generation = 0
  private listing: Promise<void> | null = null
  // The storage mode and key the list was last read under.
  private scope?: string
  // What stops waiting for each connector's sign-in popup.
  private readonly popups = new Map<string, () => void>()

  constructor(private readonly api: HarnessAPI) {}

  read = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private set(patch: Partial<ConnectorListState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  // Lists the connectors once for each storage mode and key, however many
  // views ask.
  load(scope: string): Promise<void> {
    if (scope === this.scope && (this.listing || this.state.listed))
      return this.listing ?? Promise.resolve()
    this.scope = scope
    return this.refresh()
  }

  // Reads the account's connectors again. Only an account whose chats the
  // harness stores, with its key unlocked, has them.
  refresh(): Promise<void> {
    const version = ++this.generation
    const isCurrent = () =>
      version === this.generation && !this.api.lifetime.signal.aborted
    const view = getView()
    if (!this.api.userId || !view.cloud || !view.keyReady) {
      this.listing = null
      this.set(UNLISTED)
      return Promise.resolve()
    }
    this.set({ loading: true })
    const listing = (async () => {
      try {
        const connectors = await listConnectors(this.api)
        if (isCurrent()) this.set({ connectors, listed: true, error: null })
      } catch (cause) {
        if (!isCurrent()) return
        this.set({ listed: true, error: describeConnectorError(cause) })
        logError('Failed to list connectors', cause, {
          component: 'ConnectorList',
          action: 'refresh',
        })
      } finally {
        if (version === this.generation) this.listing = null
        if (isCurrent()) this.set({ loading: false })
      }
    })()
    this.listing = listing
    return listing
  }

  // Shows a connector as the harness answered with it, in place of the one
  // listed. A listing read meanwhile no longer applies.
  private show(connector: Connector) {
    this.generation++
    this.listing = null
    const { connectors } = this.state
    const listed = connectors.some(({ id }) => id === connector.id)
    this.set({
      loading: false,
      connectors: listed
        ? connectors.map((kept) =>
            kept.id === connector.id ? connector : kept,
          )
        : [...connectors, connector],
    })
  }

  // Connects a server, and sends the user to sign in to it when it asks.
  async add(name: string, url: string): Promise<Connector> {
    const answer = await addConnector(this.api, name, url)
    this.show(answer.connector)
    this.signInIfAsked(answer)
    return answer.connector
  }

  // Signs in to a connector again.
  async signIn(id: string) {
    const answer = await authorizeConnector(this.api, id)
    this.show(answer.connector)
    this.signInIfAsked(answer)
  }

  private signInIfAsked({ connector, authorizationUrl }: ConnectorAnswer) {
    if (!authorizationUrl) return
    const popup = openSignIn(authorizationUrl, connector.id, returnAddress())
    if (!popup) return
    this.popups.get(connector.id)?.()
    this.popups.set(
      connector.id,
      awaitPopupAnswer(popup, (answer) => {
        this.popups.delete(connector.id)
        void this.finishSignIn(answer)
      }),
    )
  }

  private async finishSignIn(answer: CallbackAnswer) {
    let failure: string
    try {
      const outcome = await finishSignIn(this.api, answer)
      if (outcome.status === 'completed') {
        this.show(outcome.connector)
        return
      }
      failure =
        outcome.status === 'refused'
          ? 'The sign-in was canceled or refused.'
          : 'This sign-in was not started here. Try signing in again.'
    } catch (cause) {
      if (this.api.lifetime.signal.aborted) return
      logError('Failed to finish signing in to a connector', cause, {
        component: 'ConnectorList',
        action: 'finishSignIn',
      })
      failure = describeConnectorError(cause)
    }
    toast({
      title: 'Sign-in did not finish',
      description: failure,
      variant: 'destructive',
    })
  }

  // Changes a connector. The change shows at once, and goes back when the
  // harness refuses it.
  async update(id: string, changes: ConnectorChanges) {
    const before = this.state.connectors.find(
      (connector) => connector.id === id,
    )
    if (before) this.show(changed(before, changes))
    try {
      const { connector } = await updateConnector(this.api, id, changes)
      this.show(connector)
    } catch (cause) {
      if (before) this.show(before)
      throw cause
    }
  }

  // Lists a connector's tools again.
  async refreshTools(id: string) {
    const { connector } = await refreshConnector(this.api, id)
    this.show(connector)
  }

  async remove(id: string) {
    await deleteConnector(this.api, id)
    this.popups.get(id)?.()
    this.popups.delete(id)
    this.generation++
    this.listing = null
    this.set({
      loading: false,
      connectors: this.state.connectors.filter(
        (connector) => connector.id !== id,
      ),
    })
  }
}

const lists = new WeakMap<HarnessAPI, ConnectorList>()
function connectorList(api: HarnessAPI): ConnectorList {
  let list = lists.get(api)
  if (!list) {
    list = new ConnectorList(api)
    lists.set(api, list)
  }
  return list
}

// The account's connectors, while the harness offers them to it: it is
// signed in, and its session has the feature.
export function useConnectors() {
  const { api, cloud, keyReady } = useHarness()
  const offered = useSessionFeature(CONNECTORS_FEATURE) && !!api.userId
  const list = connectorList(api)
  const state = useSyncExternalStore(list.subscribe, list.read, list.read)
  useEffect(() => {
    if (offered) void list.load(`${cloud}:${keyReady}`)
  }, [offered, list, cloud, keyReady])
  return { ...state, offered, list }
}
