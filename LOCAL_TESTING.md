# Local development

The recommended local workflow runs the webapp with the Dev Simulator, a local API gateway, and selected controlplane mocks. A local model router is optional.

## Quick start

### 1. Configure the environment

```bash
cp .env.example .env.local
```

Set:

```env
NEXT_PUBLIC_DEV=true
NEXT_PUBLIC_API_BASE_URL=https://api.tinfoil.sh
NEXT_PUBLIC_DEV_API_KEY=tf-api-key
```

`NEXT_PUBLIC_DEV_API_KEY` is only used when testing inference against the optional local model router. Clerk continues to provide normal account authentication.

### 2. Start the local API gateway

```bash
npm run dev:backend
```

This starts port 3001 and provides:

- The Dev Simulator endpoint
- Registered controlplane mocks
- Forwarding for unmatched controlplane APIs

### 3. Start the frontend

```bash
npm run dev
```

Open http://localhost:3000 and sign in when testing account-scoped features such as safeguards.

## Local architecture

| Process            | Port | Required | Purpose                                                           |
| ------------------ | ---: | -------- | ----------------------------------------------------------------- |
| Next frontend      | 3000 | Yes      | Application UI and same-origin API entrypoint                     |
| Local API gateway  | 3001 | Yes      | Dev Simulator, registered mocks, and real-controlplane forwarding |
| Local model router | 8090 | No       | Optional testing of actual model-router requests                  |

Frontend routing in explicit local dev mode:

```text
/api/local-router/* → optional model router on port 8090
/api/*              → local API gateway on port 3001
```

Gateway routing:

```text
POST /api/dev/simulator → Dev Simulator
registered mock route   → matching mock module
unknown /api/dev/*      → 404; never forwarded to production
remaining /api/*        → NEXT_PUBLIC_API_BASE_URL
```

Future controlplane mocks are registered in `scripts/mock-controlplane.mjs`. Next and the static development server do not know individual mock routes.

## What changes in local mode

| Concern            | Production                                   | Local development                                                                           |
| ------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Controlplane API   | Browser contacts the configured API directly | Browser uses the same-origin gateway; selected routes are mocked and the rest are forwarded |
| Clerk              | Real Clerk                                   | Real Clerk                                                                                  |
| Safeguards         | Real controlplane                            | Local mock using the production client contract                                             |
| Default UI testing | Production models                            | Dev Simulator                                                                               |
| Local model router | Not applicable                               | Optional                                                                                    |
| Inference auth     | Clerk/delegated token                        | Static key only for the optional local router                                               |
| Attestation        | Enabled                                      | Disabled only for optional local-router inference                                           |
| Stream logs        | Disabled                                     | Available locally                                                                           |

Hosted builds reject `NEXT_PUBLIC_DEV=true`.

## Dev Simulator

Select **Dev Simulator** in the model picker. It does not require the local model router.

Send:

```text
help
```

for the complete command list. Useful commands include:

```text
test thoughts
test long thoughts
test no thoughts
test rapid
test code
test retry
test error
```

`test error` shows the local connection-error banner. Resending repeats the error; a different message resumes normal simulator responses.

## Testing safeguards

Safeguard testing requires local Clerk sign-in so the production safeguards client obtains and sends its normal bearer header. The mock requires the header but does not validate the token cryptographically.

1. Start both the gateway and frontend.
2. Sign in.
3. Select **Dev Simulator**.
4. Create a chat and send:

   ```text
   flag safeguard
   ```

5. Confirm the sidebar marker, Settings → Safeguards entry, read-only banner, and disabled generation actions.
6. Refresh and confirm the flag persists. Mock state lives in the backend process.
7. Create an unflagged chat and send:

   ```text
   reset safeguards
   ```

Restarting `npm run dev:backend` also clears all mock flags. No real controlplane violation is created.

The signed-in client fetches safeguards immediately, every 30 seconds while visible, and when the page regains focus or comes back online. Generation waits for the first successful safeguard response; later refreshes preserve the last successful state.

## Verifying gateway routing

```bash
# Unmocked request forwarded to real controlplane
curl -i 'http://localhost:3000/api/config/models?chat=true'

# Mock endpoint requires a bearer header
curl -i http://localhost:3000/api/users/me/safeguard-flags

# Local mock response
curl -i \
  -H 'Authorization: Bearer local-test' \
  http://localhost:3000/api/users/me/safeguard-flags

# Unknown development routes never reach production
curl -i http://localhost:3000/api/dev/not-a-real-route
```

If port 3001 is unavailable, general local API requests return 502 rather than bypassing the gateway.

## Optional local model router

Run an OpenAI-compatible model router on `localhost:8090`, then select one of the normal development models instead of Dev Simulator.

The frontend proxies `/api/local-router/*` to the router and strips the prefix. This path uses `NEXT_PUBLIC_DEV_API_KEY` and bypasses the production attested inference client.

Development models are defined in `src/config/models.ts` under `DEV_MODELS`.

## Static development server

To test the production static export locally, leave `dev:backend` running and replace `npm run dev` with:

```bash
npm run build
npm run dev:serve
```

`dev:serve` serves `out/` on port 3000 and applies the same API-gateway and model-router boundaries as Next development mode.

## Stream logging

In local mode, streaming responses can be written under `logs/` as per-chat Markdown transcripts. Both frontend modes accept stream-log uploads through:

```text
POST /api/dev/stream-log
```

The `logs/` directory is gitignored.

## Troubleshooting

- **Port 3000 occupied:** stop the previous `npm run dev` or `npm run dev:serve` process.
- **Port 3001 unavailable:** start `npm run dev:backend`; gateway requests otherwise return 502.
- **Port 8090 unavailable:** only optional local-router models fail. Dev Simulator still works.
- **Safeguard command asks for sign-in:** authenticate with Clerk locally.
- **Stale mock flags:** send `reset safeguards` from an unflagged chat or restart `dev:backend`.
