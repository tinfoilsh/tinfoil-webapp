/**
 * Conditional tool exposure (architecture → "Capability discovery & conditional
 * tool exposure"), extended with the model axis.
 *
 * The browser probes the local driver (`/status`) and reflects the result — plus
 * whether the current model can drive computer-use at all — into the toolset it
 * assembles for the enclave LLM. The model never probes anything; its awareness
 * of computer-use readiness is purely a function of what the webapp puts in the
 * request. This module is the pure decision brain the request-builder and the UI
 * both consume, so the connection indicator and tool exposure never disagree.
 */

import {
  computerUseSupport,
  type ComputerUseSupport,
  type ModelLike,
} from './model-support'
import type { DriverImage, DriverStatus } from './types'

/** Driver readiness, derived solely from `/status` (or its absence). */
export type DriverReadiness =
  | 'absent' // daemon not reachable / not running
  | 'no_images' // running, but no ready sandbox image yet
  | 'ready' // running with at least one ready image

/** The persistent connection-indicator state near the chat input. */
export type ConnectionIndicator = 'connected' | 'connecting' | 'disconnected'

/** Derive readiness from a `/status` result (`null` ⇒ fetch failed ⇒ absent). */
export function driverReadiness(status: DriverStatus | null): DriverReadiness {
  if (!status || !status.running) return 'absent'
  // The Go driver can serialise a nil image slice as JSON `null` rather than
  // `[]` (the zero value of a Go slice). Treat null + missing the same as
  // an empty array so we don't crash with "Cannot read properties of null
  // (reading 'some')" on a fresh driver that has no images yet.
  const images = status.images ?? []
  return images.some((i) => i.ready) ? 'ready' : 'no_images'
}

/** Ready image names — the source for the `computer_begin` `session.image` enum. */
export function readyImageNames(status: DriverStatus | null): string[] {
  return readyImages(status).map((i) => i.name)
}

/**
 * Ready images with their OS — the source consent UI and the manifest-OS
 * derivation use to fill in `session.os` (which the model does NOT choose).
 * Tolerates a null `status.images` (Go nil-slice → JSON null).
 */
export function readyImages(status: DriverStatus | null): DriverImage[] {
  return (status?.images ?? []).filter((i) => i.ready)
}

export interface ComputerUseAvailability {
  driverState: DriverReadiness
  modelSupport: ComputerUseSupport
  /** Expose the `computer_*` tools to the model this turn? */
  exposeTools: boolean
  /** Show the `suggest_installing_computer_use` install-funnel widget instead? */
  showInstallCTA: boolean
  /** Ready image names for the `session.image` enum (empty in `no_images`). */
  images: string[]
  /** Human-readable constraints/notes to surface to the user. */
  reasons: string[]
}

/**
 * Combine driver readiness with model capability into the exposure decision.
 *
 * Three driver states × the model axis:
 *  - model can't do computer-use (non-vision) → expose nothing, no install CTA
 *    (installing wouldn't help this chat); surface why.
 *  - driver absent → only the install CTA (the funnel), no `computer_*`.
 *  - driver running, no ready image → expose `computer_*` with an empty image set
 *    + a "run `tinfoil-driver image setup` first" hint; no install CTA.
 *  - driver ready → expose `computer_*`, populate images, no install CTA; flag if
 *    the model family is unrecognized (best-effort adapter).
 */
export function computerUseAvailability(args: {
  status: DriverStatus | null
  model: ModelLike
}): ComputerUseAvailability {
  const driverState = driverReadiness(args.status)
  const modelSupport = computerUseSupport(args.model)

  // The model gates everything: if it can't see the screen, computer-use is off
  // regardless of the driver, and pushing an install is misleading here.
  if (!modelSupport.supported) {
    return {
      driverState,
      modelSupport,
      exposeTools: false,
      showInstallCTA: false,
      images: [],
      reasons: modelSupport.reasons,
    }
  }

  if (driverState === 'absent') {
    return {
      driverState,
      modelSupport,
      exposeTools: false,
      showInstallCTA: true,
      images: [],
      reasons: [],
    }
  }

  const reasons = [...modelSupport.reasons]
  if (driverState === 'no_images') {
    reasons.push(
      'No sandbox image is ready yet — run `tinfoil-driver image setup <name>` first.',
    )
  }

  return {
    driverState,
    modelSupport,
    exposeTools: true,
    showInstallCTA: false,
    images: readyImageNames(args.status),
    reasons,
  }
}

/** Indicator state from a `/status` result and whether a probe is in flight. */
export function connectionIndicator(
  status: DriverStatus | null,
  probing: boolean,
): ConnectionIndicator {
  if (status && status.running) return 'connected'
  if (probing) return 'connecting'
  return 'disconnected'
}
