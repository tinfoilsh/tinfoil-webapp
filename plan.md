# Local controlplane proxy and safeguard mock plan

## Objective

Replace the safeguard-specific client simulation with a local reverse proxy that mocks only the safeguard flags API while forwarding every other controlplane request to the configured real controlplane.

The production safeguards client must use the same HTTP request, authentication, response parsing, and state-update path in local development, Vercel previews, and production. Local development may replace the server behind that request, but must not inject flags directly into React or the safeguards store.

This work will be added to PR #615 (`dmccanns/disable-flagged-chats`) after discarding the uncommitted session-storage and route-fallback experiments made during investigation.

## Desired behavior

### Production and Vercel previews

- Continue using `NEXT_PUBLIC_API_BASE_URL` directly.
- Continue fetching real flags from `GET https://api.tinfoil.sh/api/users/me/safeguard-flags`.
- Never enable the local reverse proxy or mock safeguard state.
- Preserve the existing hosted-build guard that rejects `NEXT_PUBLIC_DEV=true` in Vercel and CI.

### Local development

When `NEXT_PUBLIC_DEV=true`, browser controlplane requests use same-origin `/api/*` URLs. The local frontend server routes them in this order:

1. `/api/dev/*` to the local development backend.
2. `/api/local-router/*` to the local model router.
3. `GET /api/users/me/safeguard-flags` to the local mock controlplane implementation.
4. Remaining `/api/*` requests to the configured real controlplane.
5. Non-API requests to Next.js or the static export as they are today.

This allows Clerk, billing, configuration, sharing, cloud features, and other controlplane-backed functionality to continue using the real controlplane while only safeguard flags are mocked.

## Authentication model

- Local testing of account safeguard state requires signing in, matching production behavior.
- The webapp obtains a real Clerk session token through the existing `authTokenManager`.
- The safeguards service sends the existing `Authorization: Bearer ...` header to the same API route it uses in production.
- The local mock requires a non-empty bearer header so missing-token behavior is still exercised.
- The local mock does not validate the Clerk JWT cryptographically and does not require a Clerk secret.
- Requests forwarded to the real controlplane preserve the original Authorization header; the real controlplane validates those tokens normally.
- Mock flag state is local backend state and is not written to Clerk metadata, browser storage, or controlplane.

## API contracts

### Read mocked safeguard flags

`GET /api/users/me/safeguard-flags`

Required request header:

```http
Authorization: Bearer <clerk-session-token>
```

Response uses the real controlplane schema:

```json
{
  "flags": [
    {
      "id": "dev-safeguard:<conversation-id>",
      "conversation_id": "<conversation-id>",
      "created_at": "2026-09-21T17:00:00.000Z"
    }
  ],
  "in_window": 1,
  "window_hours": 168,
  "warn_threshold": 8,
  "ban_threshold": 10
}
```

Rules:

- Return flags newest first.
- Count each conversation only once.
- Compute `in_window` from `created_at` and `window_hours` rather than hard-coding it.
- Use the production policy defaults currently returned by controlplane: 168 hours, warning at 8, suspension at 10.
- Return `401` when the bearer header is absent or malformed.
- Never forward this route to real controlplane while the local mock is enabled.

### Add a mock flag

`POST /api/dev/safeguard-flags`

Request:

```json
{
  "conversation_id": "<conversation-id>"
}
```

Response:

```json
{
  "created": true,
  "duplicate": false
}
```

Rules:

- Reject blank or missing conversation IDs with `400`.
- Deduplicate by conversation ID.
- Return the existing record when repeated.
- This endpoint is local-development-only and is never exposed by hosted builds.

### Reset mock flags

`DELETE /api/dev/safeguard-flags`

Response:

```json
{
  "cleared": 3
}
```

Rules:

- Clear all in-memory mock flags.
- This endpoint is local-development-only.

## Mock state lifecycle

- Hold mock flags in memory in the local development backend.
- Browser refreshes retain flags.
- Restarting `npm run dev:backend` clears flags.
- Do not use localStorage, sessionStorage, IndexedDB, files, or Clerk metadata for mock flags.
- A single local backend process may use one shared flag set; multi-user isolation is not needed for the local UI harness.

## Client configuration

### Central API URL behavior

Keep `NEXT_PUBLIC_API_BASE_URL=https://api.tinfoil.sh` as the configured real controlplane upstream.

Refactor the client API-base export so local dev builds use same-origin requests while hosted builds continue using the configured absolute URL. The local decision must derive from the existing protected `NEXT_PUBLIC_DEV` mechanism; do not add `NEXT_PUBLIC_SAFEGUARDS_API_URL` or another public override.

Conceptually:

```ts
const configuredApiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || ''
const useLocalApiProxy = process.env.NEXT_PUBLIC_DEV === 'true'

export const API_BASE_URL = useLocalApiProxy ? '' : configuredApiBaseUrl
```

Retain the existing runtime-origin protection for behavior that disables attestation. Confirm during implementation whether API proxy selection should use the build-time flag or the runtime `IS_DEV` value. The selected approach must satisfy both:

- `next dev` and local static exports send `/api/*` to the local frontend server.
- A dev-flagged bundle served from a non-local public origin must fail closed rather than contact an unintended same-origin API.

### Centralize controlplane consumers

Audit all controlplane consumers. Several currently read `process.env.NEXT_PUBLIC_API_BASE_URL` directly instead of importing `API_BASE_URL` from `src/config.ts`.

At minimum inspect and, where safe, centralize:

- `src/services/cloud/cloud-storage.ts`
- `src/services/cloud/project-storage.ts`
- `src/services/share-api.ts`
- `src/services/mapkit-token.ts`
- `src/services/passkey/legacy-passkey-credentials.ts`
- `src/services/inference/tinfoil-client.ts`
- `src/config/models.ts`
- billing requests in settings and upgrade hooks

The reverse proxy is only complete if browser controlplane calls consistently use the local same-origin base in dev. Calls to independently configured services such as the sync enclave must remain direct and must not be routed through the controlplane proxy.

## Proxy implementation

### Next.js development server

Update `next.config.mjs` rewrites with specific routes before the catch-all:

1. Existing `/api/dev/simulator` route.
2. New mock-controlplane mutation routes under `/api/dev/safeguard-flags`.
3. Existing `/api/local-router/:path*` route.
4. Mock `GET /api/users/me/safeguard-flags` route.
5. Catch-all `/api/:path*` route to `${configuredControlplaneBase}/api/:path*`.

Next rewrites cannot select by HTTP method. If necessary, send the safeguard GET route and any same-path unsupported methods to the local backend, where method validation returns `405`.

Only install the catch-all controlplane rewrite during local development. Validate and normalize the upstream URL before constructing rewrite destinations.

### Static development server

Update `scripts/dev-serve.mjs` with the same route precedence.

- Proxy mock safeguard routes to the local development backend on port 3001.
- Proxy remaining `/api/*` routes to the configured real controlplane.
- Preserve request method, path, query string, body, and Authorization header.
- Update the proxy helper to support both HTTP local upstreams and the HTTPS controlplane upstream.
- Replace the Host header with the upstream host.
- Do not forward the mock safeguard GET to production if the local backend is unavailable; return `502` so tests fail visibly rather than silently using real account data.
- Keep request-body streaming and response streaming behavior unchanged.

### Local development backend

Extend `scripts/dev-simulator.mjs` rather than introducing browser-side mock state.

- Preserve the existing simulator endpoint.
- Add a small in-memory safeguard flag store.
- Add GET, POST, and DELETE route handlers described above.
- Add JSON body-size limits and method checks consistent with the existing server style.
- Set appropriate JSON content types and CORS headers if direct requests are retained, although normal browser traffic should use the same-origin frontend proxy.
- Log mock flag additions and resets without logging Clerk bearer tokens.
- Print the available mock controlplane endpoints at startup.

## Safeguards client cleanup

Refactor `src/services/safeguards.ts` so it is environment-agnostic.

Remove:

- `IS_DEV` imports and branches.
- `DEV_PLACEHOLDER_FLAGS`.
- `simulatedFlags`.
- `simulateSafeguardFlag()`.
- Development flag ID generation.
- Development browser-storage logic.
- Any preview snapshot assembled inside the client service.

Keep:

- The real Zod response schema.
- `authTokenManager.getAuthHeaders()`.
- Request deduplication.
- Snapshot indexing by conversation ID.
- Status transitions and structured error logging.
- Store reset behavior on sign-out/account changes.

Review whether `SafeguardsSnapshot.isPreview` remains necessary. If it only exists for the current client-side simulator, remove it and simplify the banner/settings UI. If the UI should explicitly label mock data, derive that label from a narrowly scoped local-development signal outside the data payload; do not alter the controlplane schema.

## Dev Simulator command changes

Keep `flag safeguard` as a local UI convenience, but make it operate through HTTP:

1. The Dev Simulator recognizes the exact command as it does today.
2. It POSTs the active conversation ID to `/api/dev/safeguard-flags`.
3. After a successful POST, it calls the normal `refreshSafeguards()` function.
4. `refreshSafeguards()` performs the normal authenticated GET through the reverse proxy.
5. The read-only UI reacts to the normal store update.

Add `reset safeguards`:

1. DELETE `/api/dev/safeguard-flags`.
2. Call `refreshSafeguards()`.
3. Confirm the sidebar flags, settings count, and read-only state clear.

If the user is signed out or no Clerk token is available, show a clear Dev Simulator response explaining that local safeguard testing requires sign-in. Do not add signed-out exceptions to `useSafeguardsLoader()`.

Remove the inference client’s direct call to `simulateSafeguardFlag()` and any safeguard state mutation from the browser.

## Read-only flagged chat behavior retained from PR #615

The reverse-proxy refactor must preserve the already committed PR behavior:

- Hide the composer and pending GenUI input.
- Hide edit, regenerate, continue, retry, copy, read-aloud, and per-message delete controls.
- Disable Quote/Ask interactions.
- Block direct submissions and queue dispatch.
- Clear queued messages.
- Cancel active generation.
- Keep history readable and scrollable.
- Keep rename, share/export, and whole-chat deletion available.
- Show the updated read-only safeguard banner.

## Remove investigation-only changes

Before implementation, revert the current uncommitted experiments that are superseded by this plan:

- Session-storage persistence for `simulatedFlags`.
- Signed-out safeguard loading exceptions.
- Dev safeguard storage keys and copy changes associated with browser persistence.
- The incomplete static-route fallback changes, unless independently retained in a separate, tested fix for signed-out local chat refreshes.

Do not revert the committed read-only chat work from commit `dd10413c`.

## Documentation changes

Update `LOCAL_TESTING.md` to include:

1. Start the local mock backend:

   ```bash
   npm run dev:backend
   ```

2. Start either frontend mode:

   ```bash
   npm run dev
   ```

   or:

   ```bash
   npm run build
   npm run dev:serve
   ```

3. Sign in locally.
4. Select Dev Simulator.
5. Send `flag safeguard`.
6. Refresh and verify the flag persists because backend state survives browser reload.
7. Send `reset safeguards` to clear it.
8. Restart `dev:backend` to reset all mock state.

Explicitly explain that:

- The normal safeguards client is being exercised.
- Other `/api/*` traffic still reaches real controlplane.
- No real violation is created.
- The local backend ignores token validity but requires the bearer header.
- Production and Vercel previews never use the mock.

## Tests

### Mock backend tests

Refactor route/state logic into importable functions if needed so tests do not need to bind a fixed port.

Cover:

- GET without Authorization returns 401.
- GET returns the exact production schema.
- POST rejects missing or blank conversation IDs.
- POST creates one flag.
- Duplicate POST does not add another flag.
- Multiple flags are returned newest first.
- `in_window` is computed correctly.
- DELETE clears state.
- Unsupported methods return 405.

### Safeguards service tests

Cover:

- The service always fetches the configured endpoint, including development builds.
- It sends the Clerk bearer header.
- It parses the real controlplane schema.
- Request failures preserve appropriate store/error behavior.
- Concurrent refreshes share one request.
- No placeholder or simulated flag path remains.

Delete or rewrite `tests/services/safeguards-local-development.test.ts`; it should verify the HTTP/proxy contract rather than client-side simulation.

### Inference simulator tests

Cover:

- `flag safeguard` POSTs the active conversation ID.
- The command refreshes the normal safeguards store after success.
- Repeated commands remain idempotent through the mock backend.
- Missing chat ID produces a clear error.
- Signed-out/token-unavailable behavior explains that sign-in is required.
- `reset safeguards` sends DELETE and refreshes the store.
- No direct browser safeguard-state mutation occurs.

### Proxy tests

Cover or script-check:

- Mock safeguard GET is routed to the local backend.
- Dev safeguard POST/DELETE are routed to the local backend.
- An unrelated `/api/*` request is forwarded to the configured real controlplane upstream.
- Authorization and query strings are preserved.
- Mock-backend failure returns 502 and never falls through to production safeguard data.
- Static `dev:serve` and Next development rewrites have equivalent route precedence.

### Existing read-only UI tests

Retain and run:

- Safeguard banner tests.
- Message action hiding tests.
- Message queue clearing tests.
- Safeguards settings tests.
- Full unit suite.

## Manual acceptance test

### Local

1. Set `NEXT_PUBLIC_DEV=true` and keep `NEXT_PUBLIC_API_BASE_URL=https://api.tinfoil.sh`.
2. Start `npm run dev:backend`.
3. Start `npm run dev` or rebuild and start `npm run dev:serve`.
4. Sign in.
5. Confirm an unrelated real-controlplane feature still works.
6. Create a chat with Dev Simulator.
7. Send `flag safeguard`.
8. Confirm the mock backend records the conversation ID.
9. Confirm the normal GET returns it.
10. Confirm the sidebar flag, Settings count, and read-only chat state appear.
11. Refresh the page and confirm the flag remains.
12. Confirm the chat cannot send, edit, regenerate, continue, retry, resolve pending tools, Quote, or Ask.
13. Confirm history remains scrollable and chat-level rename/share/export/delete remain available.
14. Send `reset safeguards` from another unflagged chat or invoke the DELETE endpoint.
15. Confirm flags and read-only state clear.
16. Stop the mock backend and verify safeguard refresh returns an error rather than falling back to real production data.

### Vercel preview

1. Confirm the build rejects `NEXT_PUBLIC_DEV=true` as before.
2. Sign in normally.
3. Confirm requests go directly to the real controlplane safeguard endpoint.
4. Verify a real test flag produces the same read-only UI.

## Validation commands

```bash
npx prettier --check .
npx tsc --noEmit
npm run lint -- --quiet
npm run test:unit -- --run
npm run build
```

Also run targeted mock-backend, safeguards service, inference simulator, proxy, message-action, and queue tests during development.

## Commit structure

Prefer two focused commits in PR #615:

1. `fix: make safeguard-flagged chats read-only` — already committed as `dd10413c`.
2. `refactor: mock safeguards through local controlplane proxy` — reverse proxy, mock backend, simulator cleanup, tests, and documentation.

Do not include the untracked `test-results/` directory.
