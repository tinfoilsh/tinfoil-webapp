/**
 * The `computer_begin` tool schema — i.e. the capability manifest as a tool
 * parameter schema, built via Zod→JSONSchema (the same path GenUI widgets use,
 * so tool definitions and runtime validation never drift).
 *
 * The manifest IS the parameter schema (architecture → "Capabilities manifest"):
 * the model receives it every turn, the driver re-validates server-side, and
 * everything is default-deny. The one dynamic piece is `session.image`, built
 * per-request as an enum of the driver's currently-ready images (from `/status`)
 * — so the model can only pick a real, ready sandbox and *sees* what exists.
 *
 * This declares the session-opening tool. The model's *actions* inside the
 * session use the separate `computer` tool from `adapter.ts`.
 */

import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { ToolSchema } from './chat-protocol'

export const COMPUTER_BEGIN_TOOL_NAME = 'computer_begin'

const COMPUTER_BEGIN_DESCRIPTION = [
  'Provision an isolated, sandboxed desktop session under a least-privilege',
  'capability manifest, and return the first screenshot. Everything is',
  'default-deny: request only the mounts/network/devices the task needs. The',
  'user must approve the manifest before the session starts.',
  '',
  'Call this EXACTLY ONCE per task to open the sandbox. Do NOT try to drive',
  'the desktop with this tool — `computer_begin` only opens the session and',
  'returns the first frame. AFTER you call it and the user approves, you',
  'will be presented with a `computer` action tool (click / type / screenshot',
  '/ scroll / keypress / etc.) in a follow-on interactive session, and that',
  'is what you use to actually drive the sandbox. The `computer` tool is not',
  'available before this call — that is expected; it appears once the session',
  'is open. Do not try to script things via an `entrypoint`; just `computer_begin`',
  'with the minimal manifest and drive interactively with `computer` once the',
  'session is up.',
].join(' ')

/** Build the Zod schema for the manifest, with `image` constrained to `images`. */
function manifestZodSchema(images: string[]) {
  // z.enum needs a non-empty tuple; with no ready images fall back to a string
  // (the `no_images` state — the driver will reject begin until one is ready).
  const imageSchema =
    images.length > 0
      ? z
          .enum(images as [string, ...string[]])
          .describe('Which ready sandbox image to clone.')
      : z
          .string()
          .describe(
            'Sandbox image name (none are ready yet — set one up first).',
          )

  return z.object({
    version: z.literal(1),
    reason: z
      .string()
      .describe(
        'A very brief summary, in your own words, of what you intend to do in the sandbox and why. Shown to the user to approve before the session starts.',
      ),
    entrypoint: z
      .array(z.string())
      .optional()
      .describe('Optional command run once at session start.'),
    session: z.object({
      // `os` is intentionally NOT a model choice: the chosen image already has
      // an OS, and letting the model pick lets it disagree with the image (e.g.
      // pick `linux` for a macOS image). The webapp derives `session.os` from
      // the image's `/status` entry before sealing the manifest.
      image: imageSchema,
      clone: z
        .boolean()
        .optional()
        .describe('Run an ephemeral fork of the image (recommended).'),
      headless: z
        .boolean()
        .optional()
        .describe(
          'Omit for the default (no host window). Set false only to keep a window for seamless takeover.',
        ),
      idle_timeout: z
        .string()
        .optional()
        .describe('Tear down after inactivity, e.g. "15m".'),
    }),
    mounts: z
      .array(
        z.object({
          src: z
            .string()
            .describe('Host path to share (absolute or ~-relative).'),
          dst: z.string().describe('Guest mount point, e.g. /Volumes/x.'),
          mode: z.enum(['ro', 'rw']).describe('Read-only or read-write.'),
        }),
      )
      .optional()
      .describe(
        'Host folders to expose into the guest. Front-load everything the task needs.',
      ),
    network: z
      .object({
        egress: z
          .array(z.string())
          .optional()
          .describe(
            'Default-deny domain allowlist, e.g. ["*.irs.gov","mail.google.com"]. Use ["*"] to opt in to allow-all (operator-only escape hatch).',
          ),
        ingress: z.array(z.number().int()).optional(),
      })
      .optional(),
    devices: z
      .object({ clipboard: z.boolean().optional() })
      .optional()
      .describe('Host↔guest device bridges (all off by default).'),
    display: z
      .object({
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        scale: z.number().int().optional(),
      })
      .optional(),
  })
}

/**
 * Build the `computer_begin` tool schema for the current set of ready images.
 * Rebuild per request so the `session.image` enum tracks `/status`.
 */
export function buildComputerBeginSchema(images: string[]): ToolSchema {
  return {
    type: 'function',
    function: {
      name: COMPUTER_BEGIN_TOOL_NAME,
      description: COMPUTER_BEGIN_DESCRIPTION,
      parameters: zodToJsonSchema(manifestZodSchema(images), {
        target: 'openApi3',
        $refStrategy: 'none',
      }) as Record<string, unknown>,
    },
  }
}
