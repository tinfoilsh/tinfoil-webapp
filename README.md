# Tinfoil Chat (Web)

The Next.js chat UI for [chat.tinfoil.sh](https://chat.tinfoil.sh). It connects to the confidential Tinfoil harness through the attested Tinfoil JavaScript SDK.

The harness runs conversations and stores encrypted chat data. This repository contains the existing chat interface, message and widget renderers, project and settings screens, and browser key/passkey custody. It no longer assembles inference requests, runs tools, replicates chat rows, or stores transcripts in IndexedDB.

Set up the environment from `.env.example`, then install dependencies with `npm install`. The harness URL defaults to `https://chat-api.tinfoil.sh`; set `NEXT_PUBLIC_HARNESS_ENCLAVE_URL` to override it. See [HARNESS.md](./HARNESS.md) for the API integration and [dev.md](./dev.md) for development, verification, and the release process.

Saved chats require the user's encryption key. The browser sends that key through the verified connection; the harness coordinates encrypted persistence. Transcripts and settings are held in memory while displayed. Passkeys recover the key across devices. Existing browser-only chats need to be exported with the previous client before the cutover.

## Reporting Vulnerabilities

Please report security vulnerabilities by either:

- Emailing [security@tinfoil.sh](mailto:security@tinfoil.sh)
- Opening an issue on GitHub on this repository

We aim to respond to (legitimate) security reports within 24 hours.
