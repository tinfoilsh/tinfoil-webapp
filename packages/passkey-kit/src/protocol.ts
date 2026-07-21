/**
 * Tinfoil v1 protocol constants. Every client wrapping the same CEK must
 * use identical values: the PRF salt input and HKDF info string both feed
 * the KEK derivation, so changing either changes every derived KEK.
 * Override both to establish a new protocol domain.
 */

/** Input to the WebAuthn PRF `eval.first` salt. */
export const TINFOIL_PRF_SALT_INPUT_V1 = 'tinfoil-chat-key-encryption'

/** HKDF info string for domain separation when deriving the KEK. */
export const TINFOIL_HKDF_INFO_V1 = 'tinfoil-chat-kek-v1'
