/**
 * Whether a given model can drive computer-use, and under what constraints.
 *
 * Two axes (architecture → conditional tool exposure, extended for the model
 * dimension):
 *  - **Capability**: the loop drives the model purely from screenshots, so a
 *    non-vision model simply cannot do this — `computer_use` must NOT be offered
 *    for it.
 *  - **Recognition**: a vision model from a known family gets a tuned adapter
 *    (prompt + schema + normalizer). An unrecognized vision model still gets the
 *    best-effort default adapter, but the UI should flag that actions may be
 *    unreliable rather than silently offering it.
 *
 * The webapp's conditional tool exposure should gate on `supported` (only then
 * register `computer_*`) and surface `reasons` when `!supported` or `!recognized`.
 */

import { resolveAdapter } from './adapter'

export interface ModelLike {
  modelName: string
  /** The webapp's vision flag (`BaseModel.multimodal`). */
  multimodal?: boolean
}

export interface ComputerUseSupport {
  /** Offer `computer_use` for this model at all? */
  supported: boolean
  /** Did the model match a tuned adapter family (vs. the default fallback)? */
  recognized: boolean
  /** Matched family name, or 'default'. */
  family: string
  /** Human-readable constraints to surface (empty when fully supported + tuned). */
  reasons: string[]
}

export function computerUseSupport(model: ModelLike): ComputerUseSupport {
  const { recognized, family } = resolveAdapter(model.modelName)

  // Vision is a hard requirement — without it the model can't see the screen.
  if (!model.multimodal) {
    return {
      supported: false,
      recognized,
      family,
      reasons: [
        'Computer use needs a vision-capable model — this model cannot see screenshots.',
      ],
    }
  }

  const reasons: string[] = []
  if (!recognized) {
    reasons.push(
      'This model is not specifically tuned for computer use; a best-effort default action adapter is used and actions may be unreliable.',
    )
  }
  return { supported: true, recognized, family, reasons }
}
