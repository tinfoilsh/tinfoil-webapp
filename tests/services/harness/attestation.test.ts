import { verificationDocument } from '@/services/harness/attestation'
import { beforeEach, expect, it } from 'vitest'
import { client, signIn, VERIFICATION } from '../../harness-fixture'

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
  client.verify.mockResolvedValue({
    ...VERIFICATION,
    toJSON: () => ({
      ...VERIFICATION.toJSON(),
      codeMeasurement: { platform: 'tdx', rtmr1, rtmr2 },
      enclaveMeasurement: { platform: 'tdx', mrtd, rtmr0, rtmr1, rtmr2, rtmr3 },
    }),
  })

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
