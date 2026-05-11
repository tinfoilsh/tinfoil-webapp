/**
 * Runtime GenUI configuration sourced from the controlplane.
 *
 * The controlplane's `GET /api/config/system-prompt` response includes an
 * optional `genUI` field with two knobs:
 *
 *   - `header`: the guidance block prepended to the per-widget hint list
 *     in the system prompt (the "default to markdown, only call when
 *     explicitly asked" wording). Tunable without a webapp release.
 *   - `enabledWidgets`: an allowlist of render_* tool names the webapp is
 *     permitted to expose to the model. Widgets registered locally but not
 *     in this list are filtered out of both the tool schemas and the prompt
 *     hint block. An empty list disables GenUI entirely.
 *
 * The Zod schema and renderer for each widget stay bundled in the webapp —
 * only the model-facing prompt header and the on/off allowlist live in the
 * controlplane.
 *
 * Until the controlplane response arrives, `getGenUIConfig()` returns
 * `null`, which the prompt/tool builders treat as "use bundled defaults"
 * (i.e. all registered widgets enabled with the bundled header). This keeps
 * the first-render path working when the network is slow or offline.
 */

export interface GenUIConfig {
  header: string
  enabledWidgets: string[]
}

let runtimeConfig: GenUIConfig | null = null

export function setGenUIConfig(config: GenUIConfig | null): void {
  runtimeConfig = config
}

export function getGenUIConfig(): GenUIConfig | null {
  return runtimeConfig
}
