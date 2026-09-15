# Tinfoil AI Chat Web App

The Next.js chat UI for [chat.tinfoil.sh](https://chat.tinfoil.sh). It connects to the confidential Tinfoil harness through the attested Tinfoil JavaScript SDK.

The harness runs conversations and stores encrypted chat data. This repository contains the existing chat interface, message and widget renderers, project and settings screens, and browser key/passkey custody. It no longer assembles inference requests, runs tools, replicates chat rows, or stores transcripts in IndexedDB.

Set up the environment from `.env.example`, including the required `NEXT_PUBLIC_HARNESS_ENCLAVE_URL`, then install dependencies with `npm install`. See [HARNESS.md](./HARNESS.md) for the API integration and [LOCAL_TESTING.md](./LOCAL_TESTING.md) for development and verification.

Saved chats require the user's encryption key. The browser sends that key through the verified connection; the harness coordinates encrypted persistence. Transcripts and settings are held in memory while displayed. Passkeys recover the key across devices. Existing browser-only chats need to be exported with the previous client before the cutover.

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
