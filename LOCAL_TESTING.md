# Local Testing & Dev Mode

This guide covers how to run the Tinfoil webapp against a local model router for development and debugging.

## Dev Mode Overview

Dev mode bypasses the [TinfoilAI](https://github.com/tinfoilsh/tinfoil-node) client (attestation, EHBP encryption) and connects directly to a local model router via a plain OpenAI-compatible client.

### What changes in dev mode

| Concern        | Production                        | Dev mode                                           |
| -------------- | --------------------------------- | -------------------------------------------------- |
| Client         | `TinfoilAI` (attestation + EHBP)  | `OpenAI` (plain HTTPS)                             |
| API base       | `https://api.tinfoil.sh`          | `localhost:8090` via proxy                         |
| Auth           | Clerk session token               | Static API key from `.env`                         |
| Models         | Fetched from `/api/config/models` | Hardcoded in `src/config/models.ts` (`DEV_MODELS`) |
| Stream logging | Disabled                          | JSONL files written to `logs/`                     |

## Setup

### 1. Environment variables

```bash
cp .env.example .env.local
```

Set the dev flags in `.env.local`:

```env
NEXT_PUBLIC_DEV=true
NEXT_PUBLIC_DEV_API_KEY=tf-api-key
```

### 2. Start the local model router

Your model router should be running on `localhost:8090` and expose an OpenAI-compatible `/v1/chat/completions` endpoint.

_The [model router](https://github.com/tinfoilsh/confidential-model-router) does this by default in dev mode_

### 3. Run the app

First, start the local mock backend on port 3001. It provides the dev
simulator LLM endpoint AND the mocked controlplane safeguard routes:

```bash
npm run dev:backend
```

Then start one of the frontend modes:

**Option A: Next.js dev server** (hot reload, slower startup)

```bash
npm run dev
```

**Option B: Static dev server** (fast, serves production build)

```bash
npm run build      # generates out/
npm run dev:serve  # serves out/ on port 3000 with API proxying
```

Both modes route `/api/*` requests with the same precedence:

1. `/api/dev/*` → local mock backend on `localhost:3001` (simulator LLM +
   mock safeguard mutations).
2. `/api/local-router/*` → local model router on `localhost:8090`.
3. `GET /api/users/me/safeguard-flags` → local mock backend (returns the
   real controlplane schema).
4. Everything else under `/api/*` → the configured real controlplane at
   `NEXT_PUBLIC_API_BASE_URL`, so Clerk, billing, cloud sync, sharing, etc.
   keep working in dev.

`dev:serve` (`scripts/dev-serve.mjs`) also accepts stream log uploads at
`POST /api/dev/stream-log`.

### Testing the safeguard read-only flow locally

Because the mocked safeguard route uses the _real_ production HTTP path, the
safeguards client runs unchanged. To exercise it:

1. Start `npm run dev:backend`.
2. Start `npm run dev` (or `npm run build && npm run dev:serve`).
3. Sign in locally so the browser has a Clerk session token — the mock
   backend requires a bearer header on the safeguard GET, matching
   production. It does not validate the token cryptographically.
4. Select **Dev Simulator** in the model picker and open a chat.
5. Send **`flag safeguard`**. The simulator POSTs the active conversation
   id to `/api/dev/safeguard-flags`, then triggers the normal
   `refreshSafeguards()` fetch. Sidebar flag, Settings → Safeguards, and
   the read-only chat banner all react through the production code path.
6. Refresh the page: the flag persists because mock state lives in the
   backend process, not in the browser.
7. Send **`reset safeguards`** (in the Dev Simulator) to clear all mocked
   flags via DELETE and refresh the store.
8. Restart `npm run dev:backend` to wipe all mock state.

Notes:

- The client-side safeguards service (`src/services/safeguards.ts`) has no
  simulator branch. The only difference in dev is the URL: same-origin
  `/api/*` in dev, absolute `NEXT_PUBLIC_API_BASE_URL` in production.
- Other controlplane traffic (Clerk, cloud sync, sharing, billing) still
  reaches the real controlplane through the catch-all rewrite.
- No real safeguard violation is ever created; nothing is written to Clerk
  metadata or persisted in the browser.
- Production and Vercel previews never enable the mock: `NEXT_PUBLIC_DEV`
  is rejected in hosted builds by `next.config.mjs`.

## Adding Dev Models

Dev models are defined in `src/config/models.ts` in the `DEV_MODELS` array. To add a new model:

```ts
const DEV_MODELS: BaseModel[] = [
  {
    modelName: 'your-model-name', // must match what the router expects
    image: 'provider.webp',
    name: 'Display Name',
    nameShort: 'Short Name',
    description: 'Description',
    type: 'chat',
    chat: true,
    multimodal: true,
  },
]
```

Models can also specify a `requestParams` field.

## Stream Logging

In dev mode, every streaming response is logged as a JSONL file in `logs/`. Each file captures the full SSE event stream with timestamps:

```
logs/
  stream-a1b2c3d4-2026-04-23T14-30-00-000Z.jsonl
```

Each line is a JSON object with:

- `t` — timestamp (ms since epoch)
- `type` — `raw` | `parsed` | `tinfoil_event` | `web_search_dispatch`
- `data` — the event payload

Logs are written by the dev server (`dev:serve`) or the Next.js dev proxy. The `logs/` directory is gitignored.

## Test Prompts

### Dev Simulator

Select **Dev Simulator** to run canned responses entirely in the browser. It does not need the simulator server on port 3001, an API key, or the model router. Send `help` to list the available commands; `test thoughts`, `test code`, and `test retry` exercise the existing streaming patterns.

Send **`test error`** to immediately show the connection-error banner locally. Use it to check the resend button, expandable details, and dismissal. Resending repeats the simulated error; send a different message to resume normal simulator responses. No network request is made.

Send **`flag safeguard`** to flag the current chat through the local mock
controlplane. The command POSTs to `/api/dev/safeguard-flags` and then
triggers the normal `refreshSafeguards()` fetch, so the sidebar,
**Settings → Safeguards**, and read-only chat state all react through the
production code path. Each chat counts once, even if the command is
repeated. Send **`reset safeguards`** to clear all mocked flags; restarting
`npm run dev:backend` also wipes state. Nothing is submitted to the real
controlplane and your account is unaffected. Sign-in is required so the
normal bearer header is sent.

**Interleaved search + thinking:**

```
Hi! Please consecutively search for the following items. After getting results
for each one, think about what you learned & also put some text.

items: cats, turtles, local news.
```

This exercises the timeline rendering with interleaved thinking blocks, web search blocks, and content blocks.
