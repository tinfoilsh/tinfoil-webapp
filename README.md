# Tinfoil Chat (Web)

**Live at:** [chat.tinfoil.sh](https://chat.tinfoil.sh)

Tinfoil Chat is a private AI chat app. Messages are encrypted in the browser directly to a verified secure enclave, so only the model inside the enclave can read them. Learn more at [docs.tinfoil.sh](https://docs.tinfoil.sh/chat/overview).

## Architecture Overview

A static [Next.js](https://nextjs.org/) app (TypeScript, [Tailwind CSS](https://tailwindcss.com/), [Radix UI](https://www.radix-ui.com/)) with no server of its own. The browser talks to the Tinfoil model router through the [Tinfoil JavaScript SDK](https://docs.tinfoil.sh/sdk/javascript-sdk), which handles enclave attestation and [EHBP](https://docs.tinfoil.sh/resources/ehbp) encryption. Authentication uses [Clerk](https://clerk.com/).

- **[src/services/inference/](src/services/inference/)**: Streaming chat requests to the model router
- **[src/services/encryption/](src/services/encryption/)**, **[src/services/cloud/](src/services/cloud/)**: Client-side encryption and sync of saved chats
- **[src/services/passkey/](src/services/passkey/)**: Passkey-protected backup keys via [passkey-kit](https://github.com/tinfoilsh/tinfoil-passkey-kit)
- **[src/services/storage/](src/services/storage/)**: Local IndexedDB cache
- **[src/components/chat/](src/components/chat/)**: Chat UI
- **[src/components/verification-sidebar.tsx](src/components/verification-sidebar.tsx)**: Live enclave verification status

## Development

See **[dev.md](./dev.md)** for environment setup, the local workflow, Dev Simulator commands, controlplane mocks, safeguard testing, and the release process.

## Reporting Vulnerabilities

Please report security vulnerabilities by either:

- Emailing [security@tinfoil.sh](mailto:security@tinfoil.sh)
- Opening an issue on GitHub on this repository

We aim to respond to (legitimate) security reports within 24 hours.
