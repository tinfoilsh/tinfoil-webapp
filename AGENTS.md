# Logging in this project

Never use console.log/error/warn in production code. Use the logging utilities from `@/utils/error-handling`.

# API Requests

NEVER use raw fetch() for API requests to Tinfoil enclaves. Always use the TinfoilAI SDK client (via getTinfoilClient or getWebSearchClient). The SDK handles attestation verification which is critical for security.

# Error Classification

NEVER string match on error messages to drive control flow (retries, fallbacks, recovery). Messages vary across browsers, SDK versions, and locales. Classify errors with structured signals instead: error classes (instanceof, e.g. the OpenAI SDK's APIConnectionError), spec-defined error names (DOMException "AbortError"), error codes, and HTTP status codes.

# Testing

- A test must reject a plausible wrong implementation. Call the live production entry point; do not copy its logic into a local proxy, or retain unused production helpers solely for tests.
- Observe a transition, not a pre-satisfied result: seed the key before testing preservation, use a valid pending tool before testing its resolved gate, and populate data before testing deletion. Isolate each rejecting guard so an expired fixture cannot mask an ownership failure.
- Assert exact payloads and surviving records, not only counts, truthiness, or status. Require callbacks to run before relying on assertions inside them. Assert event presence before comparing indexes; `-1` is not proof of event order.
- Use real IndexedDB transactions through `fake-indexeddb` for persistence and rollback claims. Reuse `tests/services/speech/fixtures.ts` for controlled audio/streams and `tests/services/chat-import/functional-import-worker.ts` for parser-backed worker tests; the latter does not emulate browser transfer detachment. Stream fixtures claiming success must include a completion marker.
- Reset mock implementations and establish required defaults in each file's setup, not a sibling describe block. `vi.clearAllMocks()` only resets call history. Restore spies, globals, listeners, timers, and environment variables; delete an originally absent `TZ` instead of assigning `undefined`.
- Own and clear animation-frame callbacks across every describe block in a file. A native frame scheduled by a fork test can notify a later upload test; do not layer fake-timer RAF scheduling over a separate manual frame queue.
- Shared `vitest.setup.ts` resets a plain-object `localStorage` adapter before each test. Spy on `localStorage` itself, not `Storage.prototype`, when injecting storage failures. Session storage and module state need their own cleanup.
- Use held promises or transaction events to test await/account-switch boundaries, not sleeps or the number of times a guard was called. Keep different accounts, attachment occurrences, and concurrent operations distinguishable.
- Run `npm test`, `npm run test:shuffle -- --sequence.seed=<seed>`, and `npm run test:typecheck`. CI runs shuffled tests and typechecks tests as well as building the app. Validate locally in the workstation's timezone; use explicit timezone overrides only for labeled timezone-specific checks.
- CSP/font/iframe configuration lints do not prove browser enforcement or layout. Keep rendered sandbox/source/nonce tests alongside them. Script tests use local HTTP servers; the scheduled Clerk configuration check contacts the real service and is separate from the unit suite.
