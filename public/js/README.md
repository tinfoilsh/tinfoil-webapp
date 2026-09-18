# Plausible Analytics

Locally-hosted copy of Plausible Analytics script for improved CSP compliance and supply chain security.

## Why Local Hosting?

- Reduces external script sources in CSP
- Enables SRI (Subresource Integrity) verification
- Scripts execute from trusted origin

## Local edits

`plausible.js` is not a verbatim copy of upstream. It carries privacy edits that
keep user content out of analytics:

- `x()` suppresses all events on `/`, `/newchat`, `/chat*`, `/share*`, and
  `/project/*/chat*`, where URLs can carry prompts, chat IDs, or share keys.
- `b.u` (and the engagement baseline `l`) report `location.origin + location.pathname`,
  never the full `href`, so query strings and fragments are dropped.
- `k()` reduces `document.referrer` to origin + pathname before it is sent as `b.r`.

`tests/pages/plausible-analytics.test.ts` asserts each of these and checks that the
SRI hash in `src/pages/_app.tsx` matches the file. Do not overwrite `plausible.js`
with the stock script.

## Updating

```bash
./public/js/update.sh
```

The script downloads the current upstream to `public/js/plausible.upstream.js`
(gitignored) without touching `plausible.js`. Then:

1. Port upstream changes by hand: `diff public/js/plausible.upstream.js public/js/plausible.js`,
   keeping the local edits above.
2. Delete `plausible.upstream.js`.
3. Recompute the SRI hash and update the `integrity` attribute in
   [src/pages/_app.tsx](../../src/pages/_app.tsx):
   ```bash
   openssl dgst -sha384 -binary public/js/plausible.js | openssl base64 -A
   ```
4. Run `npx vitest run tests/pages/plausible-analytics.test.ts`. It fails until both
   the local edits and the SRI hash are in place.
