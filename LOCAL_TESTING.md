# Local development and checks

Copy `.env.example` to `.env.local` and configure Clerk, the controlplane URL, and `NEXT_PUBLIC_HARNESS_ENCLAVE_URL`. The harness URL must be a deployed, attested HTTPS origin. The webapp no longer has a model-router proxy, simulator, or plain HTTP mode.

Use `npm run dev` to run the existing Next.js UI against that harness. Account, project, attachment, and key operations use the configured services and account. Use a test account for these checks.

Offline checks do not need a running development server:

```sh
npm run test:unit -- --run
npm run lint
node node_modules/typescript/bin/tsc --noEmit --incremental false
node ../confidential-tinfoil-harness/scripts/check-widgets.cjs .
```

The tests replace transport with fixtures and cover rendering, key custody, event reduction, reconnects, uploads, and account isolation. They do not verify a deployed enclave or replace a browser smoke test. See [HARNESS.md](./HARNESS.md) for ownership and cutover details.
