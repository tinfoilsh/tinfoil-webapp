import {
  findTinfoilError,
  VerificationError,
  type MeasurementJSON,
  type StepJSON,
  type VerificationReport,
} from 'tinfoil'
import type { Verification } from './client'
import { harnessAPI } from './runtime'

// The state of one step as the verification center shows it.
interface StepState {
  status: 'pending' | 'success' | 'failed'
  error?: string
}

interface CenterMeasurement {
  type: string
  registers: string[]
}

// The document the verification center reads, in the fields of the 1.x
// SDK's verification document, which the center still takes.
export interface VerificationDocument {
  configRepo: string
  enclaveHost: string
  releaseDigest: string
  codeMeasurement: CenterMeasurement
  enclaveMeasurement: {
    measurement: CenterMeasurement
    tlsPublicKeyFingerprint: string
    hpkePublicKey: string
  }
  tlsPublicKey: string
  hpkePublicKey: string
  codeFingerprint: string
  enclaveFingerprint: string
  // The host the client contacted for the document, which the center shows
  // as the enclave's endpoint: where the client connected, not an attested
  // fact.
  selectedEnclaveEndpoint: string
  securityVerified: boolean
  steps: {
    fetchDigest: StepState
    verifyCode: StepState
    verifyEnclave: StepState
    compareMeasurements: StepState
    otherError?: StepState
  }
}

// The center's steps, by the layer of the verification report that each
// shows: reading the document, its code's provenance, the hardware quote,
// and the measurements against the release.
const STEP_LAYERS = {
  fetchDigest: 'envelope',
  verifyCode: 'provenance',
  verifyEnclave: 'quote',
  compareMeasurements: 'policy',
} as const

// Verifies the chat service's enclave, which every request does before it
// is sent; the first verification is shared.
export function verifyChatService(): Promise<Verification> {
  return harnessAPI().client.verify()
}

// Tells the listener whether each later attempt to verify the chat service's
// enclave passed, as when a request verifies it again after the verification
// expired, and a failure discards the one before it. Returns a function that
// stops telling it.
export function watchChatService(listener: (verified: boolean) => void) {
  return harnessAPI().client.watchVerification(({ report }) =>
    listener(report !== undefined),
  )
}

// The report of a verification that rejected the enclave's document, which
// shows the step that failed and what the steps before it established.
// Undefined for any other failure, such as a connection that dropped.
function rejectedReport(cause: unknown): VerificationReport | undefined {
  const error = findTinfoilError(cause)
  if (error?.category !== 'attestation') return
  for (let next: unknown = error.cause; next;) {
    if (next instanceof VerificationError) return next.report
    next = (next as { cause?: unknown }).cause
  }
}

// The registers a measurement sets, by name, in the platform's order.
function registersOf(measurement: MeasurementJSON | undefined) {
  if (!measurement) return new Map<string, string>()
  const { platform: _platform, ...registers } = measurement
  return new Map(
    Object.entries(registers).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

function stateOf(step: StepJSON | undefined): StepState {
  switch (step?.status) {
    case 'passed':
    case 'skipped':
      return { status: 'success' }
    case 'failed':
      return { status: 'failed', error: step.message }
    default:
      return { status: 'pending' }
  }
}

// What a verification report shows, as the verification center reads it.
// A release fixes only some of a platform's registers, and the enclave's
// fingerprint is of those. A rejected report shows what the steps before
// the failure established, and the keys only of a verification that passed,
// since a rejected document's keys are only what it claims.
function documentOf(
  enclaveHost: string,
  report: VerificationReport,
): VerificationDocument {
  const {
    steps,
    verified_facts: verified,
    partial_facts: partial,
    metadata,
  } = report.toJSON()
  const code = verified
    ? verified.code_measurement
    : partial?.expected?.code_measurement
  const enclave = verified
    ? verified.enclave_measurement
    : partial?.measured?.cpu_measurement
  const fixed = registersOf(code)
  const measured = registersOf(enclave)
  const tlsPublicKey = report.verifiedFacts?.tlsPublicKeyFP ?? ''
  const hpkePublicKey = report.verifiedFacts?.hpkePublicKey ?? ''
  const step = (layer: string) => steps.find((step) => step.layer === layer)
  const known: readonly string[] = Object.values(STEP_LAYERS)
  // A layer this center has no step for, as a later verifier may add.
  const other = steps.find(
    (step) => step.status === 'failed' && !known.includes(step.layer),
  )
  return {
    configRepo: verified?.config_repo ?? partial?.expected?.config_repo ?? '',
    enclaveHost,
    releaseDigest:
      verified?.code_digest ?? partial?.expected?.artifact.digest ?? '',
    codeMeasurement: {
      type: code?.platform ?? '',
      registers: [...fixed.values()],
    },
    enclaveMeasurement: {
      measurement: {
        type: enclave?.platform ?? '',
        registers: [...measured.values()],
      },
      tlsPublicKeyFingerprint: tlsPublicKey,
      hpkePublicKey,
    },
    tlsPublicKey,
    hpkePublicKey,
    codeFingerprint: [...fixed.values()].join(''),
    enclaveFingerprint: [...fixed.keys()]
      .map((name) => measured.get(name) ?? '')
      .join(''),
    selectedEnclaveEndpoint: metadata.host ?? '',
    securityVerified: verified !== undefined,
    steps: {
      fetchDigest: stateOf(step(STEP_LAYERS.fetchDigest)),
      verifyCode: stateOf(step(STEP_LAYERS.verifyCode)),
      verifyEnclave: stateOf(step(STEP_LAYERS.verifyEnclave)),
      compareMeasurements: stateOf(step(STEP_LAYERS.compareMeasurements)),
      ...(other ? { otherError: stateOf(other) } : {}),
    },
  }
}

// The document the chat service's verification produced, for the
// verification center to show: what a verification that passed proved, or
// where one that the verifier rejected failed. Any other failure, such as a
// connection that dropped, rejects, so that the caller can try again.
export async function verificationDocument(): Promise<VerificationDocument> {
  const { client } = harnessAPI()
  let report: VerificationReport
  try {
    report = await client.verify()
  } catch (cause) {
    const rejected = rejectedReport(cause)
    if (!rejected) throw cause
    report = rejected
  }
  return documentOf(client.enclave, report)
}
