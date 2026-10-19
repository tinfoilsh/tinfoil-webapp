# Development

## Setup

```bash
npm install
cp .env.example .env.local
```

In `.env.local`, add the Clerk keys and set:

```env
NEXT_PUBLIC_DEV=true
NEXT_PUBLIC_API_BASE_URL=https://api.tinfoil.sh
NEXT_PUBLIC_DEV_API_KEY=tf-api-key
```

`NEXT_PUBLIC_DEV_API_KEY` is only used by the optional local model router. Hosted builds reject `NEXT_PUBLIC_DEV=true`.

## Running locally

Run each command in its own terminal:

```bash
npm run dev:backend   # port 3001: Dev Simulator, controlplane mocks, forwarding to NEXT_PUBLIC_API_BASE_URL
npm run dev           # port 3000: the app
```

Open http://localhost:3000 and sign in to test account-scoped features such as safeguards. Add controlplane mocks in `scripts/mock-controlplane.mjs`.

To test the static export instead of `npm run dev`, keep `dev:backend` running:

```bash
npm run build
npm run dev:serve
```

With `NEXT_PUBLIC_DEV=true`, streamed responses are saved per chat as Markdown under `logs/` (gitignored).

## Dev Simulator

Select **Dev Simulator** in the model picker. Send `help` for the full command list. Useful commands:

- `test thoughts`, `test long thoughts`, `test no thoughts`: responses with and without reasoning
- `test rapid`, `test code`: fast streaming and code blocks
- `test retry`: fails three times, then succeeds after automatic retries
- `test error`: the connection-error banner (send a different message to resume)
- `flag safeguard`: flags the chat in the local safeguards mock (requires sign-in)
- `reset safeguards`: clears all mock flags, as does restarting `dev:backend` (flagged chats are read-only, so send it from another chat)

## Optional local model router

Run an OpenAI-compatible model router on `localhost:8090` and select a model from `DEV_MODELS` in `src/config/models.ts`. These requests use `NEXT_PUBLIC_DEV_API_KEY` and skip attestation.

## Testing

```bash
npm test
npm run test:shuffle
npm run test:typecheck
npm run lint
npm run build
```

Reproduce a shuffled failure with the seed Vitest prints: `npm run test:shuffle -- --sequence.seed=42`. `npm run test:unit` runs Vitest in watch mode. `npm run check:clerk-privacy` checks the live Clerk environment and runs on a schedule in CI.

## Releases

Start from a clean `main` with an authenticated GitHub CLI (`gh auth status`).

```bash
git switch main
npm run release -- prepare 1.0.3   # bumps the version, opens the version PR, and squash-merges it without waiting for CI
git switch main
npm run release -- publish 1.0.3   # tags the merged version and pushes only that tag, which starts the release workflow
```

Do not use `git push --tags`; GitHub skips workflow events when more than three tags are pushed together. If a tag misses its release, run the **Create Release** workflow manually with that tag.
