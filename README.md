# Tinfoil AI Chat Web App

**Live at:** [chat.tinfoil.sh](https://chat.tinfoil.sh)

## Table of Contents

- [Built With](#built-with)
- [Security Architecture](#security-architecture)
  - [How It Works](#how-it-works)
  - [Encrypted Chat Storage](#encrypted-chat-storage)
  - [Verification Steps](#verification-steps)
- [Development](#development)
- [Releases](#releases)
- [Reporting Vulnerabilities](#reporting-vulnerabilities)

## Built With

- **[Next.js 15](https://nextjs.org/)** - React framework
- **[TypeScript](https://www.typescriptlang.org/)** - Type safety
- **[Tailwind CSS](https://tailwindcss.com/)** - Styling
- **[Radix UI](https://www.radix-ui.com/)** - Accessible components

## Security Architecture

Tinfoil Chat is designed to ensure that only the AI model inside a verified secure enclave can read your messages - not Tinfoil, not cloud providers, not network intermediaries.

### How It Works

We use [EHBP (Encrypted HTTP Body Protocol)](https://docs.tinfoil.sh/resources/ehbp) with [HPKE encryption (RFC 9180)](https://www.rfc-editor.org/rfc/rfc9180.html) to secure messages in transit to the enclave. All data from the chat application running in the browser is encrypted with the HPKE key that is generated and lives only inside the secure enclave.

Before sending any message:

1. **Attestation Verification**: Your browser cryptographically verifies that the remote server is a genuine secure enclave running unmodified code via the [Wasm verifier](https://github.com/tinfoilsh/verifier).
2. **Key Exchange**: The verified enclave provides its HPKE public key
3. **End-to-End Encryption**: Messages are encrypted directly to the verified enclave's public key before transmission

This guarantees that only the attested enclave possessing the corresponding private key can decrypt your messages.

### Encrypted Chat Storage

Saved chats are encrypted with AES-GCM-256 using a key only you control before being uploaded to the cloud sync service. The cloud copy is opaque to our servers — only the holder of the key can decrypt it. If you lose this key, your cloud-stored chat history cannot be recovered.

On-device caches (IndexedDB, sessionStorage) hold chat content in plaintext while you are signed in so the app can read and render messages without round-tripping the cloud. Anyone with access to the browser profile while signed in can read those caches; sign out (or use the in-app "Clear all data" flow) to evict them.

Learn more: [Private Chat Backups](https://tinfoil.sh/blog/2025-09-24-private-chat-backups-local-first)

### Verification Steps

The chat interface shows real-time verification status for:

- **Hardware Attestation**: Confirms genuine AMD SEV-SNP or Intel TDX enclave and genuine NVIDIA Hopper/Blackwell GPU
- **Code Integrity**: Verifies enclave runs the exact, unmodified code version matching the pinned code on Sigstore
- **Chat Security**: Validates measurements fetched from Sigstore match measurements fetched from enclave

Learn more about the security model:

- [Tinfoil JavaScript SDK Documentation](https://docs.tinfoil.sh/sdk/javascript-sdk)
- [EHBP Protocol Details](https://docs.tinfoil.sh/resources/ehbp)

## Development

See **[dev.md](./dev.md)** for environment setup, the recommended local workflow, Dev Simulator commands, controlplane mocks, safeguard testing, and optional local model-router usage.

## Releases

Releases use a two-step local command so package versions are committed before the matching tag is created. Start with a clean `main` branch and an authenticated GitHub CLI (`gh auth status`).

### 1. Prepare the version

```bash
git switch main
npm run release -- prepare 1.0.3
```

The command:

1. Updates `package.json` and `package-lock.json`.
2. Creates and pushes a release branch.
3. Opens a version pull request.
4. Verifies the pull request head and immediately squash-merges it.

The merge does not wait for CI checks. If it fails, the command prints the pull request URL and a manual recovery command.

### 2. Publish the tag

After preparation finishes, publish the same version:

```bash
git switch main
npm run release -- publish 1.0.3
```

This updates local `main`, verifies the committed package version, creates one annotated tag, and pushes only that tag. The tag push starts the GitHub workflow that publishes the release and generated release notes.

Do not use `git push --tags`; GitHub does not emit workflow events when more than three tags are pushed together. If a valid tag misses its release, run the **Create Release** workflow manually with that tag.

## Reporting Vulnerabilities

Please report security vulnerabilities by either:

- Emailing [security@tinfoil.sh](mailto:security@tinfoil.sh)

- Opening an issue on GitHub on this repository

We aim to respond to security reports within 24 hours and will keep you updated on our progress.
