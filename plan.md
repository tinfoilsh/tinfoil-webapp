# Local controlplane gateway and safeguard mock

## Status

Implemented on `dmccanns/disable-flagged-chats`. This document records the intended architecture and acceptance criteria for the implementation.

## Goals

- Make safeguard-flagged conversations read-only while preserving access to their history and chat-level management controls.
- Exercise the production safeguards HTTP client during local UI development.
- Mock controlplane at the network boundary rather than injecting development state into React or `src/services/safeguards.ts`.
- Keep local API routing generic so future controlplane mocks do not require edits to Next.js or the static development server.
- Keep production and Vercel behavior unchanged.

## Runtime architecture

### Production and Vercel

- `API_BASE_URL` resolves to `NEXT_PUBLIC_API_BASE_URL`, defaulting to `https://api.tinfoil.sh`.
- Safeguards are fetched from the real authenticated `GET /api/users/me/safeguard-flags` endpoint.
- Local rewrites and mocks are disabled.
- Hosted builds reject `NEXT_PUBLIC_DEV=true`.
- A dev-flagged bundle served from a public origin also fails closed because local mode requires a local/private runtime hostname.

### Local development

`NEXT_PUBLIC_DEV=true` plus a local/private browser origin makes client controlplane requests same-origin.

Both frontend serving modes use the same infrastructure boundary:

```text
Browser
  ├─ /api/local-router/* → local model router on port 8090
  └─ /api/*              → local API gateway on port 3001
```

The port-3001 gateway then routes requests:

```text
Local API gateway
  ├─ POST /api/dev/simulator       → Dev Simulator
  ├─ registered controlplane mock  → matching mock module
  ├─ unknown /api/dev/*            → 404 (never production)
  └─ remaining /api/*              → configured real controlplane
```

Next.js and `dev-serve` do not know individual mock routes.

## Responsibilities

### `next.config.mjs`

- Enable local rewrites only when both `NODE_ENV=development` and `NEXT_PUBLIC_DEV=true`.
- Route local model-router traffic to port 8090.
- Route all other `/api/*` traffic to the port-3001 gateway.
- Contain no safeguard-specific route matching.

### `scripts/dev-serve.mjs`

- Provide equivalent routing for a static export.
- Handle stream-log uploads locally.
- Route local model traffic to port 8090.
- Route all other API traffic to the port-3001 gateway.
- Contain no controlplane mock registry or safeguard-specific route matching.

### `scripts/dev-simulator.mjs`

- Host the port-3001 local API gateway and Dev Simulator endpoint.
- Load the same development environment files as Next.js.
- Forward unmatched controlplane requests to `NEXT_PUBLIC_API_BASE_URL`.

### `scripts/local-api-gateway.mjs`

- Give registered controlplane mocks an opportunity to handle requests.
- Reject unknown `/api/dev/*` routes.
- Forward remaining `/api/*` traffic to the configured real controlplane.
- Preserve methods, paths, query strings, bodies, and authorization headers.

### `scripts/mock-controlplane.mjs`

- Compose independent mock modules.
- Future mocks are registered here and nowhere else.
- Each module owns its route matching, state, validation, and responses.

### `scripts/mock-safeguards.mjs`

- Implement the local safeguard API contracts.
- Store flags only in backend memory.
- Require a syntactically valid bearer header for the authenticated GET without validating Clerk cryptographically.
- Never log bearer tokens.

### `src/services/safeguards.ts`

- Remain environment-agnostic.
- Always use the production HTTP request and Zod response schema.
- Acquire authentication through `authTokenManager`.
- Track whether the first successful response has loaded without discarding the last good snapshot during later refreshes.
- Contain no `IS_DEV` branch, placeholders, simulated flags, or browser persistence.

### `src/hooks/use-safeguards.ts`

- Fetch immediately for a signed-in user.
- Poll every 30 seconds while the page is visible.
- Refresh immediately on focus, visibility restoration, and reconnect.
- Pause interval requests while hidden.
- Deduplicate overlapping refreshes through the safeguards service.

## Mock safeguard contracts

### Read flags

```http
GET /api/users/me/safeguard-flags
Authorization: Bearer <token>
```

The response matches controlplane:

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

Flags are newest first and deduplicated by conversation ID. `in_window` is computed from timestamps.

### Add a flag

```http
POST /api/dev/safeguard-flags
Content-Type: application/json

{"conversation_id":"<conversation-id>"}
```

The endpoint rejects malformed input and reports whether the flag was newly created or already present.

### Reset flags

```http
DELETE /api/dev/safeguard-flags
```

The endpoint clears all in-memory flags and reports the number removed.

Mock state survives browser reloads and clears when `dev:backend` restarts. It is never written to localStorage, sessionStorage, IndexedDB, Clerk, or real controlplane.

## Local commands

With `npm run dev:backend` and a local frontend running:

- `flag safeguard` posts the active conversation ID to the mock and then invokes the normal authenticated safeguards refresh.
- `reset safeguards` clears the mock and invokes the same refresh path.
- Local safeguard testing requires Clerk sign-in, matching production client behavior.

## Read-only conversation policy

When the active conversation is flagged:

- Hide the composer and pending GenUI input.
- Hide edit, regenerate, continue, retry, copy, read-aloud, and per-message delete actions.
- Preserve message dates and read-only metadata.
- Close any message edit already in progress.
- Disable Quote/Ask interactions.
- Reject form submissions and URL-provided messages.
- Block all generation until authentication resolves and the first signed-in safeguard response succeeds.
- Block queued dispatch, clear queued messages, and cancel active generation.
- Keep history readable and scrollable.
- Keep rename, share/export, and whole-chat deletion available.

`ChatMessages` receives one `readOnly` policy prop rather than independent conditional callbacks. Non-visual dispatch boundaries retain their own hard guards.

## Extending the mock controlplane

To add another mock:

1. Create `scripts/mock-whatever.mjs` exposing a `route(req, res)` method that returns `null` for unmatched requests.
2. Register it in `scripts/mock-controlplane.mjs`.
3. Add focused contract tests.

No changes should be required in `next.config.mjs` or `scripts/dev-serve.mjs`.

## Validation

Automated coverage should verify:

- Local rewrites are enabled only by explicit local dev mode.
- All general API routes pass through the local gateway.
- Model-router routes remain separate.
- Registered mocks take precedence over real-controlplane forwarding.
- Unknown development routes never reach production.
- Authorization and query strings are preserved.
- Mock safeguard authentication, validation, deduplication, counting, and reset behavior.
- Production safeguard parsing and store behavior.
- URL-provided messages cannot generate in read-only chats.
- Message actions are suppressed while dates remain visible.
- Active edits close when a chat becomes read-only.
- Queued messages are cleared and cannot dispatch.

Before merge, run:

```bash
npx prettier --check .
npx tsc --noEmit
npm run lint -- --quiet
npm run test:unit -- --run
npm run build
```
