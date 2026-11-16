import { ERROR_ACTIONS, ERROR_CODES, ROUTES } from './protocol'
import type { HarnessAPI } from './runtime'
import { HarnessError } from './sse'
import type {
  Connector,
  ConnectorAnswer,
  ConnectorChanges,
  ConnectorSignIn,
} from './types'

// The account's connectors: the MCP servers it connected, whose tools its
// stored chats' replies call. The harness reaches them, signs in to them and
// keeps what it signs in with; this client only sends the user to a server's
// sign-in page and brings back what the page answered.

export const listConnectors = async (api: HarnessAPI): Promise<Connector[]> =>
  (await api.post<{ connectors: Connector[] }>(ROUTES.connectorsList))
    .connectors

// A server that asks the user to sign in is added signed out, with the page
// that signs them in.
export const addConnector = (api: HarnessAPI, name: string, url: string) =>
  api.post<ConnectorAnswer>(ROUTES.connectorsAdd, { name, url })

export const authorizeConnector = (api: HarnessAPI, id: string) =>
  api.post<ConnectorAnswer>(ROUTES.connectorsAuthorize, { id })

export const completeConnector = (api: HarnessAPI, signIn: ConnectorSignIn) =>
  api.post<ConnectorAnswer>(ROUTES.connectorsComplete, signIn)

export const updateConnector = (
  api: HarnessAPI,
  id: string,
  changes: ConnectorChanges,
) => api.post<ConnectorAnswer>(ROUTES.connectorsUpdate, { id, ...changes })

export const refreshConnector = (api: HarnessAPI, id: string) =>
  api.post<ConnectorAnswer>(ROUTES.connectorsRefresh, { id })

export const deleteConnector = (api: HarnessAPI, id: string) =>
  api.post(ROUTES.connectorsDelete, { id })

// A connector whose tools can be called. A status this client does not know
// shows as signed out.
export const isConnected = (connector: Pick<Connector, 'status'>) =>
  connector.status === 'connected'

// Why the harness refused a change to a connector, as the user reads it.
const CONNECTOR_ERROR_COPY: Record<string, string> = {
  [ERROR_CODES.connectorUnreachable]:
    'No MCP server answered at that address. Check the URL and try again.',
  [ERROR_CODES.connectorUnsupported]:
    'This server only works with apps it approved in advance, so it cannot be connected here.',
  [ERROR_CODES.connectorLimit]:
    'You have added the most connectors you can. Remove one to add another.',
  [ERROR_CODES.badRequest]:
    'Check the name and the address. The address must be a public HTTPS URL.',
  [ERROR_CODES.connectorSignInFailed]:
    'Signing in did not finish. Try signing in again.',
  [ERROR_CODES.connectorSignedOut]:
    'This connector needs you to sign in again.',
  [ERROR_CODES.connectorNotFound]: 'This connector was removed.',
}

const ACTION_COPY: Record<string, string> = {
  [ERROR_ACTIONS.retry]: 'Something went wrong. Try again.',
  [ERROR_ACTIONS.wait]: 'Try again later.',
  [ERROR_ACTIONS.unlock]:
    'Unlock your encryption key in Cloud Sync to manage connectors.',
  [ERROR_ACTIONS.reauthenticate]: 'Sign in again to continue.',
  [ERROR_ACTIONS.reload]: 'This connector changed. Try again.',
}

// What to tell the user about a failed connector request: by the error's
// code where it has copy of its own, and otherwise by its action.
export function describeConnectorError(cause: unknown): string {
  if (!(cause instanceof HarnessError)) return ACTION_COPY[ERROR_ACTIONS.retry]
  if (Object.hasOwn(CONNECTOR_ERROR_COPY, cause.code))
    return CONNECTOR_ERROR_COPY[cause.code]
  return Object.hasOwn(ACTION_COPY, cause.detail.action)
    ? ACTION_COPY[cause.detail.action]
    : cause.message
}
