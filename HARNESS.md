# Webapp harness integration

All chat routes use the existing chat UI and `src/services/harness/`. `/harness` is an alias for the main page. The harness origin defaults to `https://chat-api.tinfoil.sh`; set `NEXT_PUBLIC_HARNESS_ENCLAVE_URL` to use another deployed harness's HTTPS origin. `HarnessClient` uses the Tinfoil SDK to verify `tinfoilsh/confidential-tinfoil-harness` for JSON, multipart uploads, binary downloads, and SSE. There is no direct model or sync connection and no development attestation bypass.

The browser owns rendering, navigation, microphone recording, passkey ceremonies, and custody of the content encryption key. The harness owns prompts, model routing, tools, the turn queue, token budgeting, transcripts, projects, memory, settings, search, sharing, archive conversion, and persistence. Built-in prompt text comes from the session catalog for viewing and copying in the prompt library.

The existing message renderers, widgets, sidebars, project panels, settings, and key recovery dialogs remain. Tool results and project/context usage are server data. Imports upload the original file; the progress control checks the returned job id. Image galleries download full-size images through the harness. Account management, billing, public map tokens, and legacy opaque passkey credential lookup retain their controlplane requests.

The browser keeps transcripts and profile data in memory. Session storage holds only run routing hints, and UI preferences such as panel expansion. Keys and passkey recovery state remain in local storage. There is no chat IndexedDB writer or local transcript importer. Existing browser-only chats are not automatically migrated; export them with the previous client before cutover. Signout and account changes still remove the legacy chat database.

Closing the page detaches the stream. Stop sends the active run id to the cancel endpoint. A reconnect follows that run with its last event cursor; a request whose acceptance was not received retries with its original nonce. Queued turns run on the server, including priority sends and removal. Account and key changes abort outstanding requests and discard the previous view.

The paired harness revision is required for first-turn project/preset selection, queue priority sends, bulk deletion, favicon lookup, normalized shares, and context usage. See the harness's `IMPLEMENTATION.md` for deployment prerequisites, model catalog reconciliation, token expiry, and replica affinity. This code change does not deploy either service.

Run the checks without starting a development server:

```sh
npm run test:unit -- --run
npm run lint
node node_modules/typescript/bin/tsc --noEmit --incremental false
node ../confidential-tinfoil-harness/scripts/check-widgets.cjs .
```

The Go tests also check generated events against the browser reducer and validate legacy rows and native archives using frozen reference validators under the harness's `scripts/fixtures/legacy-webapp/`. Live attestation and browser smoke testing against the deployed service remain rollout checks.
