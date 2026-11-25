import { verificationDocument } from '@/services/harness/attestation'
import { AttestationError, NetworkError, VerificationError } from 'tinfoil'
import { beforeEach, expect, it } from 'vitest'
import { client, fakeReport, signIn, VERIFICATION } from '../../harness-fixture'

beforeEach(() => {
  signIn()
})

it('gives the verification center what verifying an AMD enclave proved', async () => {
  const launch = 'ab'.repeat(48)
  await expect(verificationDocument()).resolves.toEqual({
    configRepo: 'tinfoilsh/confidential-tinfoil-harness',
    enclaveHost: 'harness.example',
    releaseDigest: '33'.repeat(32),
    codeMeasurement: { type: 'sev-snp', registers: [launch] },
    enclaveMeasurement: {
      measurement: { type: 'sev-snp', registers: [launch] },
      tlsPublicKeyFingerprint: '11'.repeat(32),
      hpkePublicKey: '22'.repeat(32),
    },
    tlsPublicKey: '11'.repeat(32),
    hpkePublicKey: '22'.repeat(32),
    codeFingerprint: launch,
    enclaveFingerprint: launch,
    selectedEnclaveEndpoint: 'harness.example',
    securityVerified: true,
    steps: {
      fetchDigest: { status: 'success' },
      verifyCode: { status: 'success' },
      verifyEnclave: { status: 'success' },
      compareMeasurements: { status: 'success' },
    },
  })
})

it('fingerprints an Intel enclave by the registers its release fixes', async () => {
  const [mrtd, rtmr0, rtmr1, rtmr2, rtmr3] = ['a0', 'b0', 'c1', 'd2', 'e3'].map(
    (byte) => byte.repeat(48),
  )
  const json = VERIFICATION.toJSON()
  client.verify.mockResolvedValue(
    fakeReport({
      ...json,
      verified_facts: {
        ...json.verified_facts!,
        code_measurement: { platform: 'tdx', rtmr1, rtmr2 },
        enclave_measurement: {
          platform: 'tdx',
          mrtd,
          rtmr0,
          rtmr1,
          rtmr2,
          rtmr3,
        },
      },
    }),
  )

  const document = await verificationDocument()

  expect(document.codeMeasurement).toEqual({
    type: 'tdx',
    registers: [rtmr1, rtmr2],
  })
  expect(document.enclaveMeasurement.measurement).toEqual({
    type: 'tdx',
    registers: [mrtd, rtmr0, rtmr1, rtmr2, rtmr3],
  })
  expect(document.codeFingerprint).toBe(rtmr1 + rtmr2)
  expect(document.enclaveFingerprint).toBe(rtmr1 + rtmr2)
})

it('shows where the verifier rejected the enclave, and what the steps before it established', async () => {
  const expected = 'ab'.repeat(48)
  const measured = 'cd'.repeat(48)
  const report = fakeReport({
    schema_version: 1,
    steps: [
      { layer: 'envelope', status: 'passed' },
      { layer: 'provenance', status: 'passed' },
      { layer: 'quote', status: 'passed' },
      { layer: 'policy', status: 'failed', message: 'launch mismatch' },
    ],
    partial_facts: {
      expected: {
        config_repo: 'tinfoilsh/confidential-tinfoil-harness',
        artifact: { source: 'endorsement', digest: '33'.repeat(32) },
        code_measurement: { platform: 'sev-snp', launch: expected },
      },
      measured: {
        cpu_measurement: { platform: 'sev-snp', launch: measured },
        // Only what the document claims: never shown as the enclave's key.
        tls_public_key_fp: '11'.repeat(32),
      },
    },
    metadata: { verified_at: '2026-04-01T09:00:00Z', host: 'harness.example' },
  })
  client.verify.mockRejectedValue(
    new AttestationError('launch mismatch', {
      cause: new VerificationError('launch mismatch', {
        layer: 'policy',
        report,
      }),
    }),
  )

  await expect(verificationDocument()).resolves.toEqual({
    configRepo: 'tinfoilsh/confidential-tinfoil-harness',
    enclaveHost: 'harness.example',
    releaseDigest: '33'.repeat(32),
    codeMeasurement: { type: 'sev-snp', registers: [expected] },
    enclaveMeasurement: {
      measurement: { type: 'sev-snp', registers: [measured] },
      tlsPublicKeyFingerprint: '',
      hpkePublicKey: '',
    },
    tlsPublicKey: '',
    hpkePublicKey: '',
    codeFingerprint: expected,
    enclaveFingerprint: measured,
    selectedEnclaveEndpoint: 'harness.example',
    securityVerified: false,
    steps: {
      fetchDigest: { status: 'success' },
      verifyCode: { status: 'success' },
      verifyEnclave: { status: 'success' },
      compareMeasurements: { status: 'failed', error: 'launch mismatch' },
    },
  })
})

it('shows a rejection at a layer the center has no step for as another error', async () => {
  const report = fakeReport({
    schema_version: 1,
    steps: [
      { layer: 'envelope', status: 'passed' },
      { layer: 'gpu', status: 'failed', message: 'GPU evidence invalid' },
      { layer: 'provenance', status: 'not_run' },
    ],
    partial_facts: {},
    metadata: { verified_at: '2026-04-01T09:00:00Z' },
  })
  client.verify.mockRejectedValue(
    new AttestationError('GPU evidence invalid', {
      cause: new VerificationError('GPU evidence invalid', {
        layer: 'gpu',
        report,
      }),
    }),
  )

  const document = await verificationDocument()

  expect(document.securityVerified).toBe(false)
  expect(document.steps).toEqual({
    fetchDigest: { status: 'success' },
    verifyCode: { status: 'pending' },
    verifyEnclave: { status: 'pending' },
    compareMeasurements: { status: 'pending' },
    otherError: { status: 'failed', error: 'GPU evidence invalid' },
  })
})

it('names no enclave endpoint for a report that names no host', async () => {
  const json = VERIFICATION.toJSON()
  client.verify.mockResolvedValue(
    fakeReport({
      ...json,
      metadata: { verified_at: json.metadata.verified_at },
    }),
  )

  const document = await verificationDocument()

  expect(document.enclaveHost).toBe('harness.example')
  expect(document.selectedEnclaveEndpoint).toBe('')
})

it('leaves a verification that could not finish to the caller to retry', async () => {
  const unreachable = new NetworkError('attestation fetch failed')
  client.verify.mockRejectedValue(unreachable)

  await expect(verificationDocument()).rejects.toBe(unreachable)
})

it('leaves an attestation failure without a report to the caller', async () => {
  const expired = new AttestationError('verification freshness expired')
  client.verify.mockRejectedValue(expired)

  await expect(verificationDocument()).rejects.toBe(expired)
})
