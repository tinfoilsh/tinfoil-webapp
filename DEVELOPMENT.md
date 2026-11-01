# Development

## Setup

```bash
npm install
cp .env.example .env.local
```

In `.env.local`, add the Clerk keys, the controlplane URL, and `NEXT_PUBLIC_HARNESS_ENCLAVE_URL`. The harness URL must be a deployed, attested HTTPS origin.

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

With the harness repository checked out next to this one, also check the widget schemas against the harness's tool declarations: `node ../confidential-tinfoil-harness/scripts/check-widgets.cjs .`

Reproduce a shuffled failure with the seed Vitest prints: `npm run test:shuffle -- --sequence.seed=42`. `npm run test:unit` runs Vitest in watch mode. `npm run check:clerk-privacy` checks the live Clerk environment and runs on a schedule in CI. See [HARNESS.md](./HARNESS.md) for ownership and cutover details.

## Releases

Start from a clean `main` with an authenticated GitHub CLI (`gh auth status`).

```bash
git switch main
npm run release -- prepare 1.0.3   # bumps the version, opens the version PR, and squash-merges it without waiting for CI
git switch main
npm run release -- publish 1.0.3   # tags the merged version and pushes only that tag, which starts the release workflow
```

Do not use `git push --tags`; GitHub skips workflow events when more than three tags are pushed together. If a tag misses its release, run the **Create Release** workflow manually with that tag.
