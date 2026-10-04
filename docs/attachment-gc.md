# Live-chat attachment cleanup

`CLOUD_SYNC.ATTACHMENT_GC_ENABLED` is false. Automatic live-chat GC must
remain disabled, including against older enclaves exposing the unsafe endpoint.
Successful chat synchronization is not evidence that attachment cleanup ran.

A grace window only delays eligibility; it does not protect a later offline
save that references an old blob. A list-then-delete pass can also race a
re-registration or a changed chat. Removing index rows before bucket deletion
loses cleanup work if a request fails or is canceled.

Before enabling cleanup, the protocol needs reference-aware commits/recovery,
atomic eligibility checks, durable deletion work acknowledged after bucket
deletion, and protection against delayed deletes wiping reused blob IDs.
Scheduling must persist deferred work across sessions and revisit rows omitted
by a grace window; `remaining: 0` is not completion when rows were deferred.

The controlplane and enclave currently return `ATTACHMENT_GC_DISABLED` for
destructive GC. Existing accumulated blobs are not reclaimed by these PRs.
Stable upload identities and per-attachment persistence prevent repeated
uploads from continuously creating new blobs; they do not delete old blobs.
