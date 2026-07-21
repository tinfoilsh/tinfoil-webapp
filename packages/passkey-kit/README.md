# @tinfoilsh/passkey-kit

Browser SDK for passkey-based key protection. It wraps the WebAuthn PRF
extension into a small, typed API:

- Device support detection (`isPrfSupported`)
- Passkey ceremonies (create / authenticate with the PRF extension)
- KEK derivation from PRF output (HKDF-SHA-256)
- CEK wrap/unwrap under the KEK (AES-256-GCM)
- Device-local state (PRF output cache, this device's credential id) via a
  pluggable storage adapter

## Usage

```ts
import { createPasskeyKit, generateCek } from '@tinfoilsh/passkey-kit'

const kit = createPasskeyKit({
  rpId: 'example.com',
  rpName: 'Example App',
})

// Bring your own 32-byte CEK, or generate a fresh one.
const cek = generateCek()

// Enroll: create a passkey and wrap the user's 32-byte CEK under it.
// `wrappedCek` is safe to persist server-side; `prfResult` is cached
// locally through the storage adapter automatically.
const enrolled = await kit.enroll({
  user: { id: userId, name: email, displayName },
  cek,
})
if (enrolled) {
  await api.saveBundle(enrolled.wrappedCek)
}

// Unlock: prompt for a passkey and recover the CEK from the matching bundle.
const unlocked = await kit.unlock(bundlesFromServer)
if (unlocked) {
  useCek(unlocked.cek)
}

// Silent unlock via the cached PRF output (no biometric prompt).
// Returns null when nothing usable is cached — fall back to unlock().
const silent = await kit.unlockWithCachedPrf(bundlesFromServer)

// Re-wrap without a biometric prompt using the cached PRF output.
const rewrapped = await kit.rewrapWithCachedPrf(newCek)
```

Lower-level building blocks (`createPasskey`, `authenticate`, `deriveKek`,
`generateCek`, `isValidCek`, `wrapCek`, `unwrapCek`, `deriveKeyId`) are
exported for flows that need finer control.

## Conventions

- High-level ceremony methods return `null` when the user cancels; they
  throw `PrfNotSupportedError` when the authenticator lacks PRF support and
  `PasskeyTimeoutError` when the provider hangs. Branch on `instanceof`,
  never on message strings.
- `prfSaltInput` and `hkdfInfo` default to the Tinfoil v1 protocol
  constants so wrapped CEKs interoperate across Tinfoil clients. Override
  both to establish a new protocol domain.
- The default storage adapter is best-effort `localStorage`; pass
  `storage: null` to disable local persistence, or supply your own
  `StorageAdapter`.
- Error messages default to brand-neutral text; pass `errorMessages` to
  brand or localize them without affecting the error classes.

## Security

The cached PRF output is raw key material: anyone who can read it can
re-derive the KEK and unwrap the CEK. The default adapter stores it in
`localStorage` as plaintext, which is only as strong as the origin's
script-injection defenses. Hosts that need at-rest protection should
supply a `StorageAdapter` with their own encryption, or set
`storage: null` to keep nothing on device and re-prompt biometrics
instead.
