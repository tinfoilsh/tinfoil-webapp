# Document attachment rollout

This PR adds readers for document attachment blobs and a disabled writer.
`CLOUD_SYNC.DOCUMENT_ATTACHMENT_WRITES_ENABLED` in `src/config.ts` is `false`;
there is no environment override. Documents stay inline on upload, including
text and scanned-page images. Existing key-only documents must be downloaded
and validated before being written inline. Failed hydration blocks the upload.

The chat plaintext limit remains **32 MiB**. Inline document content counts
toward that limit before attachment uploads begin. This reader-first release
does not immediately solve large-document sync failures.

## Requirements before enabling writes

- Ship document-blob readers on all supported clients, including iOS/mobile,
  and preserve these attachments through sanitization, export, backup, local
  conversion, forks, sharing, and inference.
- Deploy a server-enforced protocol/version boundary that rejects incompatible
  writers. Old web clients can otherwise drop key-only documents and overwrite
  the cloud chat, even after newer web readers have deployed. Waiting for a web
  deployment alone is not a safe rollout boundary.
- Verify server fork and attachment cleanup support for document blobs before
  changing the named config constant in a separately reviewed release.

Inference waits for missing documents and validates their payloads before
building the request. Failed reads surface an error and can be retried; inline
documents need no attachment fetch or authentication. Reads are serial and
stop on cancellation, account changes, or sync opt-out. Local forks with missing
documents refuse while sync is disabled and explain how to download the content.
Cloud-to-local conversion retains content and removes server keys before deletion.
