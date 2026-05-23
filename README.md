# Tinfoil AI Chat Web App

**Live at:** [chat.tinfoil.sh](https://chat.tinfoil.sh)

## Table of Contents

- [Built With](#built-with)
- [Security Architecture](#security-architecture)
  - [How It Works](#how-it-works)
  - [Encrypted Chat Storage](#encrypted-chat-storage)
  - [Verification Steps](#verification-steps)
- [Development](#development)
  - [Quick Start](#quick-start)
  - [Local Testing & Dev Mode](#local-testing--dev-mode)
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

### Quick Start

1. **Clone and install**

   ```bash
   git clone https://github.com/tinfoilsh/tinfoil-webapp.git
   cd tinfoil-webapp
   npm install
   ```

2. **Environment setup**

   ```bash
   cp .env.example .env.local
   ```

   Configure your `.env.local` with the required keys:

   ```env
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=your_clerk_key
   CLERK_SECRET_KEY=your_clerk_secret
   NEXT_PUBLIC_API_BASE_URL=https://api.tinfoil.sh
   ```

3. **Start development server**
   ```bash
   npm run dev
   ```

### Local Testing & Dev Mode

For running the app against a local model router (bypassing attestation and encryption), see **[LOCAL_TESTING.md](./LOCAL_TESTING.md)**.

## Reporting Vulnerabilities

Please report security vulnerabilities by either:

- Emailing [security@tinfoil.sh](mailto:security@tinfoil.sh)

- Opening an issue on GitHub on this repository

We aim to respond to security reports within 24 hours and will keep you updated on our progress.
