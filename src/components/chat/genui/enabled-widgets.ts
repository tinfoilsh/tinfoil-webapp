/**
 * Resolves the active set of GenUI widgets for a given request.
 *
 * The webapp registers a fixed list of widgets in `registry.ts` — those are
 * the only widgets it has renderers for. The controlplane can further
 * restrict which of those are exposed to the model via its
 * `enabledWidgets` allowlist (see `config.ts` and the controlplane's
 * `/api/config/system-prompt` response).
 *
 * Semantics:
 *   - No controlplane config yet → expose every registered widget. Keeps
 *     the first-render path working before the network response arrives.
 *   - Controlplane config present → intersect with the local registry.
 *     Widgets the controlplane lists but the webapp doesn't have are
 *     ignored (lets the controlplane reference future widget names without
 *     breaking older clients).
 *   - Empty controlplane allowlist → no widgets enabled. The tool builders
 *     and prompt-hint builder both treat this as "GenUI is off".
 */
import { getGenUIConfig } from './config'
import { GENUI_WIDGETS } from './registry'
import type { GenUIWidget } from './types'

export function resolveEnabledWidgets(): GenUIWidget[] {
  const config = getGenUIConfig()
  if (!config) return GENUI_WIDGETS
  const allowed = new Set(config.enabledWidgets)
  return GENUI_WIDGETS.filter((w) => allowed.has(w.name))
}
