# Local development

Copy `.env.example` to `.env.local` and configure Clerk, the controlplane URL, and `NEXT_PUBLIC_HARNESS_ENCLAVE_URL`. The harness URL must be a deployed, attested HTTPS origin. The webapp no longer has a model-router proxy, simulator, or plain HTTP mode.

Use `npm run dev` to run the existing Next.js UI against that harness. Account, project, attachment, and key operations use the configured services and account. Use a test account for these checks.

## Automated tests

Offline checks do not need a running development server:

```bash
npm test
npm run test:shuffle
npm run test:typecheck
npm run lint
npm run build
```

With the harness repository checked out next to this one, also check the
widget schemas against the harness's tool declarations:
`node ../confidential-tinfoil-harness/scripts/check-widgets.cjs .`

To reproduce a shuffled failure, pass the seed printed by Vitest:
`npm run test:shuffle -- --sequence.seed=42`. Keep the workstation's timezone
for normal validation. CI runs test typechecking and shuffled Vitest tests before
the production build; `npm run test:unit` is the local watch command.

The suite uses happy-dom, fake IndexedDB, and local HTTP servers for script tests.
Configuration lints are not browser CSP or layout verification. The separate
scheduled `check:clerk-privacy` command checks the live Clerk environment.

The tests replace transport with fixtures and cover rendering, key custody, event reduction, reconnects, uploads, and account isolation. They do not verify a deployed enclave or replace a browser smoke test. See [HARNESS.md](./HARNESS.md) for ownership and cutover details.

## Releases

Releases use a two-step local command so package versions are committed before the matching tag is created. Start with a clean `main` branch and an authenticated GitHub CLI (`gh auth status`).

### 1. Prepare the version

```bash
git switch main
npm run release -- prepare 1.0.3
```

The command:

1. Updates `package.json` and `package-lock.json`.
2. Creates and pushes a release branch.
3. Opens a version pull request.
4. Verifies the pull request head and immediately squash-merges it.

The merge does not wait for CI checks. If it fails, the command prints the pull request URL and a manual recovery command.

### 2. Publish the tag

After preparation finishes, publish the same version:

```bash
git switch main
npm run release -- publish 1.0.3
```

This updates local `main`, verifies the committed package version, creates one annotated tag, and pushes only that tag. The tag push starts the GitHub workflow that publishes the release and generated release notes.

Do not use `git push --tags`; GitHub does not emit workflow events when more than three tags are pushed together. If a valid tag misses its release, run the **Create Release** workflow manually with that tag.
