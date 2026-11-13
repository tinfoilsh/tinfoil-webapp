# Development

## Setup

```bash
npm install
cp .env.example .env.local
```

In `.env.local`, add the Clerk keys, the Tinfoil API URL (`NEXT_PUBLIC_API_BASE_URL`), and `NEXT_PUBLIC_HARNESS_ENCLAVE_URL` (default `https://chat-api.tinfoil.sh`). The harness URL must be a deployed, attested HTTPS origin.

## Running locally

```bash
npm run dev
```

The app runs against the configured harness with real services and the signed-in account, so use a test account.

http://localhost:3000/dev lists pages that preview the onboarding and cloud sync flows with stubbed callbacks, without the chat service or account changes. They only render under `npm run dev`.

## Testing

```bash
npm test
npm run test:shuffle
npm run test:typecheck
npm run lint
npm run build
```

`npm test` also checks the widget argument types against the harness's tool declarations, read from `HARNESS_WIDGETS_JSON` (CI downloads the harness's `widgets.json` from its main branch) or from the harness repository checked out next to this one; `npm run generate:widgets` regenerates them.

`harness-protocol/` holds the harness's protocol and recorded runs, copied from a harness commit named in `harness-protocol/revision`. `npm test` checks `packages/chat-client/src/openapi.ts` was generated from it and replays the recorded runs through the reducer. `npm run sync:harness-protocol [harness checkout]` copies them again, from the harness repository next to this one by default, and regenerates the types.

Reproduce a shuffled failure with the seed Vitest prints: `npm run test:shuffle -- --sequence.seed=42`. `npm run test:unit` runs Vitest in watch mode. `npm run check:clerk-privacy` checks the live Clerk environment and runs on a schedule in CI.

## Browser extension

Use Node.js 22 or newer. Configure the public Clerk key and frontend API in `apps/extension/.env`; enable Clerk's Native API and register the extension ID shown in `chrome://extensions` ([Clerk setup](https://clerk.com/docs/chrome-extension/getting-started/quickstart)). Browser actions require an attested harness release advertising `browserTools`; set its origin as `WXT_HARNESS_URL`.

```bash
cp apps/extension/.env.example apps/extension/.env
npm run dev:extension
```

In `chrome://extensions`, enable Developer mode and load `apps/extension/.output/chrome-mv3-dev` as an unpacked extension. Sign in on the website opened by the panel; the panel updates when the website's session changes. Clerk shares the website's session through its [Sync Host integration](https://clerk.com/docs/guides/sessions/sync-host?sdk=chrome-extension); use the same Clerk instance and Chrome profile, and set `WXT_WEBAPP_URL` when testing against another webapp. Use a persistent Chrome profile to keep local chats between sessions.

```bash
npm run build:extension
npm run typecheck:extension
npm run test:extension
npm exec --workspace=apps/extension -- playwright install chromium
npm run test:browser --workspace=apps/extension
```

The production-mode folder is `apps/extension/.output/chrome-mv3`. Reload its extension card after rebuilding. CI publishes that folder as the `tinfoil-browser-chrome` artifact; its public configuration comes from the `EXTENSION_CLERK_PUBLISHABLE_KEY`, `EXTENSION_CLERK_FRONTEND_API`, `EXTENSION_WEBAPP_URL`, and `EXTENSION_HARNESS_URL` repository variables.

## Releases

Start from a clean `main` with an authenticated GitHub CLI (`gh auth status`).

```bash
git switch main
npm run release -- prepare 1.0.3   # bumps the version, opens the version PR, and squash-merges it without waiting for CI
git switch main
npm run release -- publish 1.0.3   # tags the merged version and pushes only that tag, which starts the release workflow
```

Do not use `git push --tags`; GitHub skips workflow events when more than three tags are pushed together. If a tag misses its release, run the **Create Release** workflow manually with that tag.
