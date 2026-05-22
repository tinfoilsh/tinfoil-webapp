# `computer_use` webapp skill — implementation notes

Status of this pass: **loop-first prototype**. The browser-mediated agentic loop
and the OpenAI-CU model-presentation adapter are built, unit-tested, and the
broker bridge contract is verified live against the real `tinfoil-broker`. UI
and main-chat-pipeline integration are deliberately deferred (see "Not done").

See `~/dev/tinfoil/architecture.md` (authoritative design) and the coding-agent
brief. This module is `src/services/computer-use/`.

## What was built

| File                 | Responsibility                                                                                                                                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`           | Wire types mirroring the broker contract (status, pairing, token, manifest, action results) + helpers (`firstImagePart`, `perceptionText`) + `BrokerError`.                                                                                                                                                      |
| `broker-client.ts`   | Low-level loopback HTTP client for all broker endpoints. Plain HTTP to `127.0.0.1:8765`; never sets `Origin` (browser-forbidden header — the browser attaches it).                                                                                                                                               |
| `access-token.ts`    | Two-tier token lifecycle: caches the access JWT, re-mints proactively before `expires_at`, `invalidate()` on a surprise 401. `createBrokerConnection()` wires client + token manager.                                                                                                                            |
| `pairing.ts`         | One-time pairing handshake (`generatePairingCode` → `/pair` → poll `/pair/status` → refresh credential).                                                                                                                                                                                                         |
| `adapter.ts`         | **Model-presentation adapter.** Presents the OpenAI-CU `computer` tool; normalizes emitted calls (incl. quirk repairs like `x:[a,b]`, nested `action`, numeric strings) into the broker's canonical `{op, payload}`; formats results back into next-turn messages. One `openai-cu` entry covers Qwen3-VL + Kimi. |
| `chat-protocol.ts`   | Minimal OpenAI chat-completion message/stream subset the loop works in (so it can carry `tool` messages + image parts the webapp `Message` type can't). `StreamChat` is the injectable inference seam.                                                                                                           |
| `turn-collector.ts`  | Accumulates one streamed assistant turn → `{content, toolCalls, finishReason}`.                                                                                                                                                                                                                                  |
| `loop-controller.ts` | **The agentic loop.** `begin → stream turn → normalize action(s) → POST /action → feed screenshot back → repeat` until the model stops, `request_handoff`, max steps, or abort. Isolated/dedicated; depends on a structural `BrokerLike`. Emits `LoopEvent`s (the audit-trail frames).                           |
| `inference.ts`       | Default `StreamChat` wrapping the attested `getTinfoilClient()` — inference stays browser↔enclave, attested, unchanged.                                                                                                                                                                                          |

Tests: `tests/services/computer-use/` (47 tests) — adapter/normalizer, the
multi-turn loop (cycle, unsupported-action recovery, handoff, max-steps, 401
re-mint, event ordering), token lifecycle, client wiring, pairing. Plus
`fixtures.ts` (in-memory `FakeBroker` + scripted `StreamChat`).

## Unknowns validated this pass

- **#1 Browser↔loopback bridge** — re-confirmed live against the freshly built
  broker (`up --auto-approve --origin http://localhost:3000`):
  - `/status` returns exactly `{installed, running, version, images:[{name, os, ready}]}`.
  - CORS is **exact-origin** (`Access-Control-Allow-Origin: http://localhost:3000`, not reflected); a foreign `Origin` → **403**.
  - PNA `OPTIONS` preflight → `Access-Control-Allow-Private-Network: true`.
  - Pairing→token: `/pair` → `{code, pairing_id}`; `/pair/status` delivers the refresh credential **once** (2nd read → `consumed`); `/token` returns an **HS256** JWT with `expires_at`/`expires_in`; bogus refresh → 401; `/begin` with a valid JWT passes the auth gate into provisioning.
  - My TS client types match the live wire format 1:1.

## Design decisions (consistent with `architecture.md`, no design changes)

- **Loop runs in raw OpenAI chat-protocol space**, not the webapp `Message`
  type — the loop is a sub-process _within_ one user turn and needs `tool`
  messages + image content the `Message` type doesn't model. This is why the
  controller is isolated rather than threaded through `use-chat-messaging`.
- **Screenshots are fed back as a short text `tool` message + a follow-up
  `user` message carrying the image** (rather than an image inside the `tool`
  message), which is the most broadly compatible shape for OpenAI-compatible
  vision servings. Configurable in the adapter if a serving prefers otherwise.
- **`request_handoff` stops the loop and leaves the session open** (resume is a
  user action — never model-driven); all other terminal paths call `/end`.
- **Single action vocabulary, liberal normalizer**: since the serving envelope
  (#4) is unverified, the normalizer accepts `{action:{…}}`, `{type,…}`,
  call-name-as-type, coordinate arrays, and numeric strings.

## Per-model extensibility & capability gating

Two model-dimension concerns are now first-class (pure logic, fully tested):

- **Adapter registry** (`adapter.ts`): `resolveAdapter(modelName)` matches a
  model to the family adapter that owns its prompt + tool schema + normalizer +
  result formatting, and reports `recognized`. Adding a model = one registry
  entry (and a new adapter when its quirks — coordinate convention, native
  shape, prompt steering — diverge enough). The per-family **system prompt**
  lives on the adapter (`adapter.systemPrompt`), so prompt engineering is
  per-model, not hardcoded in the loop. Current entries: `kimi`, `qwen-vl`;
  unrecognized → best-effort default with `recognized:false`.
- **Capability gate** (`model-support.ts`): `computerUseSupport({modelName,
multimodal})` → `{supported, recognized, family, reasons}`. **Non-vision
  models are not supported** (the loop drives from screenshots) so `computer_use`
  must not be offered for them; unrecognized vision models are offered but with
  `reasons` to surface ("actions may be unreliable"). This is the model axis the
  conditional tool exposure should gate on, alongside broker readiness.

## Detection → conditional exposure (built)

The browser's discovery half — pure, testable logic + a polling engine:

- `availability.ts`: `brokerReadiness(status)` (absent/no_images/ready) and
  `computerUseAvailability({status, model})` — the exposure brain that ANDs
  broker readiness with `computerUseSupport`, yielding `{exposeTools,
showInstallCTA, images, reasons}` and the connection-indicator state. The
  indicator and the toolset derive from the same `/status` result, so they can't
  disagree.
- `manifest-schema.ts`: `buildComputerBeginSchema(images)` — the `computer_begin`
  tool schema via Zod→JSONSchema, with `session.image` as an enum of the ready
  images (so the model can only pick a real sandbox; falls back to a plain string
  in `no_images`).
- `status-poller.ts`: `BrokerStatusPoller` — adaptive cadence (~2s disconnected,
  ~20s heartbeat connected; the heartbeat catches the daemon dying mid-session),
  `refresh()` for `visibilitychange`, abortable. `use-broker-status.ts` is the
  thin React binding (starts/stops the poller, probes on `visibilitychange`).

## Chat-input tool button (built)

`src/components/chat/ComputerUseToolButton.tsx` — the computer-use toggle in the
chat input toolbar, mirroring the web-search / code-execution buttons, with a
tiny **online/offline status dot** overlaid on the desktop icon reflecting live
broker connectivity (green connected / amber connecting / grey offline).
Presentational; `chat-input.tsx` owns one `useBrokerStatus` poller + the
`computerUseSupport` gate and feeds both the desktop button and the mobile menu
item. Non-vision models render the button **disabled with a "needs vision"
tooltip** (discoverable, not hidden). Toggle state persists in localStorage
(`SETTINGS_COMPUTER_USE_ENABLED`), threaded chat-interface → ChatMessages →
WelcomeScreen → ChatInput. Poller backs off exponentially (2s→30s) while
disconnected so loopback isn't hammered. Component-tested
(`tests/components/chat/computer-use-tool-button.test.tsx`).

## In-chat session (built)

End-to-end in-chat flow, additive + gated so normal chat is byte-for-byte
unchanged when the toggle is off:

- `credential-store.ts` / `connection.ts`: persist the refresh credential
  (per-browser) and build a token-managed `BrokerConnection`; `pairAndConnect`
  runs the handshake + stores the credential.
- `use-computer-use-session.ts`: the orchestration state machine —
  `idle → pairing → consent → running → done|handoff|error` — driving the loop
  against the real broker + attested inference. Deps injectable; unit-tested.
- `ComputerUseSessionDialog.tsx`: pairing code, consent (image picker + sealed
  manifest summary), live screenshot/exec frames (the audit trail), handoff/done/
  error states.
  **Model-initiated** (`request-tools.ts` + `use-chat-messaging.ts`): when the
  toggle is on, `computer_begin` is added to the chat request
  (`computerUseRequestTools` — one-shot `/status` probe for the image enum; gated
  by vision + broker readiness; never throws). It's NOT auto-continued, so the
  model stops after emitting it; after the stream, `extractComputerBegin` reads the
  finished assistant message and `onComputerBegin(manifest, task)` hands off to the
  session (consent seeded from the model's manifest → loop). The streaming pipeline
  is untouched — purely a post-stream check, gated by the toggle. The
  chat-interface↔session cycle (session needs `selectedModel` from `useChatState`,
  which needs the callback) is broken with a stable ref. `computer_*` tool calls
  are suppressed in the GenUI renderer (handled by the dialog, not a widget).

**Editable consent**: `ManifestEditor` in the dialog lets the user edit the
_full_ manifest before approving — image, OS, ephemeral clone, headless/window,
idle timeout, mounts (add/remove src·dst·mode), and the egress domain allowlist.
Seeded from the model's proposed manifest; default-deny (nothing granted that
isn't shown).

## End-to-end testing

- **Bridge E2E** (`tests/services/computer-use/e2e.bridge.test.ts`, `node` env):
  runs the real `BrokerClient` against the live broker — status/CORS/auth.
  Verified: `/status` running, foreign origin → 403, bogus refresh → 401 (Origin
  injected since Node doesn't set it). Pairing happy-path needs `--auto-approve`.
  `BROKER_E2E=1 npx vitest run …e2e.bridge…` with the broker up.
- **Full-slice E2E** (`…/e2e.full-slice.test.ts`): pairs, boots the real VM, and
  drives real Kimi K2.6 through the loop. Run:
  `./tinfoil-broker up --auto-approve --origin http://127.0.0.1:3000` then
  `BROKER_E2E_FULL=1 TINFOIL_API_KEY=… npx vitest run …e2e.full-slice…`.
- Live in-app: load the app from **http://127.0.0.1:3000** (the broker's allowed
  origin — `localhost` is rejected), enable the computer-use toggle, send a
  message → pairing → consent → loop in the dialog.

## Not done this pass (next steps)

- **React UI (remaining)**: consent screen (render the manifest), pairing-code
  display/modal, takeover/resume controls, inline screenshot frames via the
  GenUI tool-call renderer, and the `suggest_installing_computer_use` install-CTA
  GenUI widget (gated by `availability.showInstallCTA`). Live visual check in the
  running app (dev server + broker) still pending — only component-level render
  tests so far.
- **Request assembly wiring**: put the `computer`/`computer_begin` tools into the
  inference request (mirror GenUI's `buildGenUIToolSchemas` path in
  `inference-client.ts`/`registry.ts`) gated by `computerUseAvailability`, plus
  the `computer_use_options` enablement flag (mirror `code_execution_options`).
- **Main-pipeline integration**: invoking `runComputerUseLoop` from the chat,
  persisting frames, `computer_begin` as a _model-emitted_ tool (today the
  controller orchestrates `begin` directly).

## Verified via live probe of Tinfoil-hosted `kimi-k2-6` (2026-05-21)

Ran `kimi-probe.sh` / `kimi-probe2.sh` (in `~/dev/tinfoil/`) against a real
screenshot. Findings, now encoded in the adapter + tests:

- **Envelope (Unknown #4) RESOLVED**: Tinfoil serving emits structured OpenAI
  `tool_calls` (`finish_reason:"tool_calls"`), not native tags as text. No
  `event-normalizer` change needed.
- **Kimi complies with the declared schema** — it's a general tool-caller, not a
  fixed-shape CU model. Emitted `{"type":"keypress","keys":["cmd","space"]}` —
  our exact field names + enum value. So the brief's "present OpenAI-CU shape +
  repair quirks" framing is unnecessary for Kimi (kept the liberal normalizer as
  defense-in-depth, mainly for Qwen).
- **Coordinate convention is steered by the schema label, and is fragile**:
  pixel-labeled schema → `{"x":105,"y":79}` (real pixels scaled to the frame);
  normalized-labeled schema → `{"x":0.109,"y":0.118}`. Kimi grounds in 0..1
  internally and reverts to fractions under weaker prompts. **Mitigation built**:
  the normalizer now rescues normalized [0,1] coords to pixels using the
  screenshot's pixel size (`image-size.ts` reads PNG/JPEG headers; the loop
  threads the latest frame size into `normalizeCall`). Pixel coords pass through
  untouched (real targets are never both ≤1).
- **No `pid`/`window` ever emitted** (your flag — confirmed). The guest/broker
  must resolve pid + translate screen→window-local coords; the webapp emits
  screenshot-pixel `{x,y}`, which is the right input for that resolution.
- **Reliability fix (proven)**: with `tool_choice:auto` and a weak prompt Kimi
  _narrates_ the action in prose (`tool_calls:[]`); adding "you MUST call the
  tool, never describe an action in prose" made it emit clean tool calls.
  `DEFAULT_SYSTEM_PROMPT` hardened accordingly.
- **`reasoning` field**: Kimi emits a separate `reasoning` per message. Now
  captured in `CollectedTurn.reasoning` + the `model_message` event (audit/UI).
  NOT yet fed back into request messages — Kimi docs say to retain
  `reasoning_content` across multi-step tool calls, but whether the OpenAI-compat
  input accepts it is unverified (needs its own probe). Flagged below.

## Open questions to resolve with the broker maintainer

- **pid + coordinate resolution is mandatory guest-side** (now confirmed both
  ends): cua-driver's `click`/`type_text`/`press_key` all have `"required":
["pid"]` and treat `x,y` as **window-local** pixels; Kimi never emits a pid and
  emits coords in the **full-screenshot** space. So the guest must, per pixel
  action: hit-test the screenshot point against `list_windows` bounds (z-order) →
  resolve `{pid, window_id, window-local x,y}` → call cua-driver. cua-driver
  exposes everything needed (`list_windows` returns pid/bounds/z_index;
  `screenshot` without `window_id` is full-display). **This must exist before
  real clicks work** — the webapp side is correct as-is (emits screenshot-pixel
  `{x,y}`).
- **Reasoning retention**: should the loop send Kimi's `reasoning` back on
  assistant messages across tool-call turns (their docs say yes)? Needs a probe
  to confirm the OpenAI-compat input accepts `reasoning`/`reasoning_content`
  without a 400.
- Whether `computer_use_options` needs **controlplane allowlisting** (like the
  GenUI `enabledWidgets` gate).
- Exact **egress-escalation** endpoint/shape (broker hook: `Provisioner.UpdateEgress`).
