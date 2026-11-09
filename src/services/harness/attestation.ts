import type { Verification } from './client'
import { harnessAPI } from './runtime'

type Measurement = ReturnType<Verification['toJSON']>['codeMeasurement']

const VERIFIED = { status: 'success' } as const

// Verifies the chat service's enclave, which every request does before it
// is sent; the first verification is shared.
export async function verifyChatService(): Promise<void> {
  await harnessAPI().client.verify()
}

// The registers a measurement sets, by name, in the platform's order.
function registersOf({ platform: _platform, ...registers }: Measurement) {
  return new Map(Object.entries(registers))
}

// The document the chat service's verification produced, for the
// verification center to show. The center reads the fields of the 1.x SDK's
// verification document, so what the verification proved is given in them.
// A release fixes only some of a platform's registers, and the enclave's
// fingerprint is of those.
export async function verificationDocument() {
  const { client } = harnessAPI()
  const verification = await client.verify()
  const facts = verification.toJSON()
  const fixed = registersOf(facts.codeMeasurement)
  const measured = registersOf(facts.enclaveMeasurement)
  const tlsPublicKey = verification.tlsPublicKeyFP ?? ''
  const hpkePublicKey = verification.hpkePublicKey ?? ''
  return {
    configRepo: facts.configRepo,
    enclaveHost: client.enclave,
    releaseDigest: facts.codeDigest,
    codeMeasurement: {
      type: facts.codeMeasurement.platform,
      registers: [...fixed.values()],
    },
    enclaveMeasurement: {
      measurement: {
        type: facts.enclaveMeasurement.platform,
        registers: [...measured.values()],
      },
      tlsPublicKeyFingerprint: tlsPublicKey,
      hpkePublicKey,
    },
    tlsPublicKey,
    hpkePublicKey,
    codeFingerprint: [...fixed.values()].join(''),
    enclaveFingerprint: [...fixed.keys()]
      .map((name) => measured.get(name))
      .join(''),
    securityVerified: true,
    steps: {
      fetchDigest: VERIFIED,
      verifyCode: VERIFIED,
      verifyEnclave: VERIFIED,
      compareMeasurements: VERIFIED,
    },
  }
}
