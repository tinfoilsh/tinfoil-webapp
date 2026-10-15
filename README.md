# Tinfoil Chat (Web)

The Next.js chat UI for [chat.tinfoil.sh](https://chat.tinfoil.sh). It connects to the confidential Tinfoil harness through the attested Tinfoil JavaScript SDK.

The harness runs conversations and stores the encrypted chats of accounts with cloud sync. This repository contains the existing chat interface, message and widget renderers, project and settings screens, browser key/passkey custody, and the chats kept on the device. It no longer assembles inference requests, runs tools, or replicates chat rows.

Set up the environment from `.env.example`, then install dependencies with `npm install`. The harness URL defaults to `https://chat-api.tinfoil.sh`; set `NEXT_PUBLIC_HARNESS_ENCLAVE_URL` to override it. See [HARNESS.md](./HARNESS.md) for the API integration and [dev.md](./dev.md) for development, verification, and the release process.

With cloud sync, chats require the user's encryption key: the browser sends it through the verified connection, and the harness coordinates encrypted persistence. Passkeys recover the key across devices. Without cloud sync, and for signed-out visitors, chats stay in the browser (IndexedDB, or session storage for the tab) and need no key. Chats the previous client kept on the device open as they are.

## Reporting Vulnerabilities

Please report security vulnerabilities by either:

- Emailing [security@tinfoil.sh](mailto:security@tinfoil.sh)
- Opening an issue on GitHub on this repository

We aim to respond to (legitimate) security reports within 24 hours.
