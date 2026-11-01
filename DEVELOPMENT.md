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

## Testing

```bash
npm test
npm run test:shuffle
npm run test:typecheck
npm run lint
npm run build
```

`npm test` also checks the widget argument types against the harness's tool declarations, read from `HARNESS_WIDGETS_JSON` (CI downloads the harness's `widgets.json` from its main branch) or from the harness repository checked out next to this one; `npm run generate:widgets` regenerates them.

`harness-protocol/` holds the harness's protocol and recorded runs, copied from a harness commit named in `harness-protocol/revision`. `npm test` checks `src/services/harness/openapi.ts` was generated from it and replays the recorded runs through the reducer. `npm run sync:harness-protocol [harness checkout]` copies them again, from the harness repository next to this one by default, and regenerates the types.

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
