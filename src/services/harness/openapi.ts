// Generated from harness-protocol/openapi.yaml by
// `npm run sync:harness-protocol`. Do not edit.
export interface paths {
  '/healthz': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** Report that the harness is serving */
    get: operations['health']
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/session': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /**
     * Open the app
     * @description What a client opens the app with. A signed-out caller is answered too.
     */
    post: operations['session']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/changes': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /**
     * Read the revisions of stored data
     * @description Revisions of the account's stored chats, profile and projects, which change when another device writes them.
     */
    post: operations['changes']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/threads/turn': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /**
     * Run a turn
     * @description Starts a run that carries out one user action on a chat, and streams it.
     */
    post: operations['turn']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/threads/follow': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /**
     * Rejoin a live run
     * @description Streams a live run again, for a client that lost its stream, from after the last event it applied.
     */
    post: operations['follow']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/threads/cancel': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /**
     * Stop a run
     * @description Stops the chat's running reply. The turns queued behind it end too, each with a cancelled RUN_FINISHED, so the harness keeps nothing of a chat once its reply stops.
     */
    post: operations['cancel']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/threads/queue/send': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /**
     * Send a queued turn now
     * @description Starts a turn queued behind the running reply now, stopping that reply.
     */
    post: operations['queueSend']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/threads/queue/remove': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Remove a queued turn */
    post: operations['queueRemove']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/threads/list': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** List stored chats */
    post: operations['list']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/threads/search': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Search stored chats */
    post: operations['search']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/threads/get': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Open a stored chat */
    post: operations['get']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/threads/update': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /**
     * Change a chat's settings
     * @description Changes a chat's settings. A cloud chat answers with its summary, a device chat with its new record.
     */
    post: operations['update']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/threads/fork': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /**
     * Fork a chat
     * @description Copies a chat through one of its messages into a new chat.
     */
    post: operations['fork']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/threads/messages/delete': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Delete a message */
    post: operations['messageDelete']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/threads/messages/update': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /**
     * Edit a reply
     * @description Edits a reply's text in place.
     */
    post: operations['messageUpdate']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/threads/delete': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Delete a stored chat */
    post: operations['delete']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/threads/delete-all': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Delete every stored chat */
    post: operations['deleteAll']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/threads/transcript': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /**
     * Read a stored chat to move it to the device
     * @description A stored chat as a device keeps it, for moving it to the device.
     */
    post: operations['transcript']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/threads/import': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /**
     * Store a device chat in the cloud
     * @description Stores a device chat in the cloud under its id.
     */
    post: operations['threadImport']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/threads/upgrade': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /**
     * Convert device chats an older client kept
     * @description Converts device chats an older client kept to the current record.
     */
    post: operations['upgrade']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/threads/share': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Share a chat */
    post: operations['share']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/threads/share/status': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Read whether a chat is shared */
    post: operations['shareStatus']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/threads/share/revoke': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Stop sharing a chat */
    post: operations['shareRevoke']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/shares/open': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Open a shared chat */
    post: operations['shareOpen']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/profile/get': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Read the profile */
    post: operations['profileGet']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/profile/update': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Change the profile */
    post: operations['profileUpdate']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/profile/upgrade': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /**
     * Convert settings an older client kept
     * @description Converts settings an older client kept on its device to the current profile.
     */
    post: operations['profileUpgrade']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/profile/merge': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /**
     * Merge a device's settings into the profile
     * @description Merges a device's settings into the account's profile when cloud sync is turned on.
     */
    post: operations['profileMerge']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/projects/list': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** List projects */
    post: operations['projectsList']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/projects/get': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Open a project */
    post: operations['projectsGet']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/projects/create': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Create a project */
    post: operations['projectsCreate']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/projects/update': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Change a project */
    post: operations['projectsUpdate']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/projects/delete': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Delete a project */
    post: operations['projectsDelete']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/projects/delete-all': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Delete every project */
    post: operations['projectsDeleteAll']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/projects/documents/upload': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Add a document to a project */
    post: operations['projectDocumentUpload']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/projects/documents/delete': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Remove a document from a project */
    post: operations['projectDocumentDelete']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/keys/current': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /**
     * Read the current content key
     * @description The account's current content key id and its passkey bundles.
     */
    post: operations['keysCurrent']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/keys/register': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Register a content key */
    post: operations['keysRegister']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/keys/add-bundle': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Add a passkey bundle to the content key */
    post: operations['keysAddBundle']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/keys/remove-bundle': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Remove a passkey bundle from the content key */
    post: operations['keysRemoveBundle']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/keys/migrate-all': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /**
     * Reseal stored data under the current key
     * @description Seals every row an older key sealed under the target key, which must
     *     be the account's registered key, in the background. A call while the
     *     reseal runs, or shortly after it ends, reports on that reseal rather
     *     than starting another.
     */
    post: operations['keysMigrateAll']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/attachments/upload': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /**
     * Convert a file into an attachment
     * @description Converts a file into the attachment a turn sends. The harness keeps nothing of it.
     */
    post: operations['attachmentUpload']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/attachments/get': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Download an attachment */
    post: operations['attachmentGet']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/attachments/get-public': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /**
     * Download a shared chat's attachment
     * @description Reads an attachment of a shared chat with the key the share names.
     */
    post: operations['attachmentGetPublic']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/transcriptions': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Transcribe a recording */
    post: operations['transcriptions']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/speech': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /**
     * Read text aloud
     * @description Reads a message, or text a client sends, aloud.
     */
    post: operations['speech']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/import': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /**
     * Import an archive
     * @description Imports an archive, either as device chats streamed back to the client or into the cloud through an import job.
     */
    post: operations['import']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/import/status': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Read an import job's progress */
    post: operations['importStatus']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/export': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /**
     * Export chats as an archive
     * @description Exports the account's stored chats and the device chats the client sends, as an archive.
     */
    post: operations['export']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/metadata/favicon': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Read a site's favicon */
    post: operations['favicon']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/metadata/link': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Read a page's link preview */
    post: operations['linkMetadata']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
}
export type webhooks = Record<string, never>
export interface components {
  schemas: {
    /** @description Any JSON value. */
    Json: unknown
    /** @description A JSON object with any members. */
    JsonObject: {
      [key: string]: unknown
    }
    /** @description An id a client names a row with. Printable ASCII without / \ ? or */
    Identifier: string
    /** @description An RFC 3339 time in UTC. */
    Timestamp: string
    Keyed: {
      /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
      key?: string
    }
    KeyedId: {
      /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
      key?: string
      id: components['schemas']['Identifier']
    }
    ThreadIdRequest: {
      threadId: components['schemas']['Identifier']
    }
    PageRequest: {
      url: string
    }
    ErrorResponse: {
      error: components['schemas']['ErrorBody']
    }
    /**
     * @description Why a request or a run failed. A client may handle a code it knows in
     *     its own way, and handles every other code by its action, so a code
     *     added after the client was released is still handled.
     */
    ErrorBody: {
      code: components['schemas']['ErrorCode']
      /** @description A description for logs and developers, in English. Clients choose what to show from the code and action. */
      message: string
      action: components['schemas']['ErrorAction']
      /** @description For QUOTA_EXHAUSTED, the kind of quota: free_daily or hourly. */
      kind?: string
      /** @description Seconds to wait before retrying. */
      retryAfter?: number
      resetsAt?: components['schemas']['Timestamp']
      /** @description The status a downstream service answered with. */
      status?: number
      /** @description For KEY_MISMATCH, the id of the key the stored data uses. */
      keyId?: string
      /** @description For a document that failed to convert, the converter's document_* code. */
      upstreamCode?: string
      rateLimit?: components['schemas']['RateLimit']
    }
    /**
     * @description What a client does about an error it has no handling of its own for.
     *     An error with an action the client does not know fails the request:
     *     the client shows the error and offers nothing more.
     *
     *     - reauthenticate: refresh the caller's identity and chat access, and
     *       send the request again once, without telling the user. Ask the user
     *       to sign in if it is refused again.
     *     - reload: the client's copy of the chat or run is out of date. Read it
     *       again and show it, without telling the user.
     *     - retry: sending the request again, unchanged, may succeed. Wait
     *       retryAfter seconds first when it is given. A client may resend a
     *       request that starts no run on its own; it offers a failed turn to the
     *       user to try again.
     *     - wait: a quota is used up until resetsAt. Tell the user when they can
     *       continue, and send nothing it limits before then.
     *     - unlock: the request needs the account's content key, which this
     *       device does not hold or holds an old copy of. Ask the user to unlock
     *       or recover it.
     *     - revise: the request cannot succeed as sent. Tell the user what to
     *       change, such as a smaller file, another file or model, or a shorter
     *       chat.
     *     - stop: nothing the client or the user does makes the request succeed
     *       now. Tell the user, and do not offer to try again.
     */
    ErrorAction:
      | (
          | 'reauthenticate'
          | 'reload'
          | 'retry'
          | 'wait'
          | 'unlock'
          | 'revise'
          | 'stop'
        )
      | string
    /** @description A client handles a code it does not know by the error's action. */
    ErrorCode:
      | (
          | 'ALREADY_APPLIED'
          | 'ARCHIVE_TOO_LARGE'
          | 'ATTACHMENT_TOO_LARGE'
          | 'ATTACHMENT_UNSUPPORTED'
          | 'ATTACHMENTS_UNAVAILABLE'
          | 'BAD_REQUEST'
          | 'CHAT_FLAGGED'
          | 'CONTEXT_TOO_LARGE'
          | 'CREDENTIAL_REQUIRED'
          | 'IMPORT_INVALID'
          | 'IMPORT_TOO_LARGE'
          | 'KEY_MISMATCH'
          | 'KEY_REQUIRED'
          | 'MAX_TURNS'
          | 'MISSING_ATTACHMENT'
          | 'MODEL_UNAVAILABLE'
          | 'PAYLOAD_TOO_LARGE'
          | 'PROJECTS_REQUIRE_CLOUD'
          | 'QUEUE_FULL'
          | 'QUOTA_EXHAUSTED'
          | 'RATE_LIMITED'
          | 'RECORD_UNSUPPORTED'
          | 'REQUEST_TIMEOUT'
          | 'REVISION_CONFLICT'
          | 'RUN_IN_FLIGHT'
          | 'RUN_LOG_FULL'
          | 'RUN_NOT_FOUND'
          | 'SEARCH_INDEX_FAILED'
          | 'SYNC_OUTCOME_UNKNOWN'
          | 'TEMP_SPACE_BUSY'
          | 'THREAD_EXISTS'
          | 'THREAD_NOT_FOUND'
          | 'THREAD_TOO_LARGE'
          | 'TOOL_UNAVAILABLE'
          | 'UNAUTHENTICATED'
          | 'UPSTREAM_REFUSED'
        )
      | string
    Session: {
      /** @description The versions of this document the harness speaks. A client knows its own as the info.version of the document it was built from. */
      protocol: {
        /** @description The version this harness speaks. */
        version: number
        /** @description The oldest version whose clients this harness still serves. A client built from an older one asks the user to update it. */
        minimum: number
      }
      user: {
        /** @description Empty for a signed-out caller. */
        id: string
        anonymous: boolean
      }
      rateLimit: components['schemas']['RateLimit']
      models: components['schemas']['SessionModel'][]
      /** @description How hard Auto works, its default level, and each level's labels. */
      auto: {
        default: string
        levels: {
          id: string
          label: string
          displayLabel: string
        }[]
      }
      defaultModel: string
      /** @description The widgets a turn may offer the model. */
      widgets: string[]
      profileDefaults: components['schemas']['Profile']
      composer: components['schemas']['Composer']
      presets: components['schemas']['Preset'][]
      /** @description Optional behaviors this harness offers. A client acts on a feature only when it is true here. */
      features: {
        [key: string]: boolean
      }
    }
    SessionModel: {
      id: string
      label: string
      shortLabel: string
      icon: string
      description: string
      badges: {
        /** @description A client shows no badge of a kind it does not know. */
        kind: ('experimental' | 'deprecated') | string
        label: string
        tooltip: string
      }[]
      reasoning: {
        toggle: boolean
        effort: boolean
        defaultEnabled: boolean
      } | null
      deprecated: boolean
      /** @description The entry that has the router choose a model for each turn. */
      auto?: boolean
    }
    Preset: {
      id: string
      name: string
      description: string
      systemPrompt: string
      icon: string
      builtIn: boolean
    }
    /** @description What the composer takes. */
    Composer: {
      attachments: components['schemas']['FileGroup'][]
      projectDocuments: components['schemas']['FileGroup'][]
      pasteAsFileChars: number
      dictationMaxSeconds: number
    }
    /** @description Files the composer takes by extension, and the largest each may be. */
    FileGroup: {
      accept: string[]
      maxBytes: number
      imageMaxSide?: number
    }
    /** @description A free key's daily request quota, or a subscriber's hourly token budgets. */
    RateLimit: {
      /** @description A client shows no quota of a kind it does not know. */
      kind: ('free_daily' | 'hourly' | null) | string
      maxRequests?: number
      remaining?: number
      resetsAt?: components['schemas']['Timestamp']
      inputTokens?: components['schemas']['TokenBudget']
      outputTokens?: components['schemas']['TokenBudget']
    }
    TokenBudget: {
      max: number
      used: number
      remaining: number
    }
    /** @description One user action on a chat, which its run carries out. */
    Turn: {
      /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
      key?: string
      /**
       * Format: uuid
       * @description A nonce. A turn sent again with it is answered with the run it started.
       */
      clientRequestId: string
      threadId: components['schemas']['Identifier']
      /**
       * @description send when absent.
       * @enum {string}
       */
      kind?:
        | 'send'
        | 'edit'
        | 'regenerate'
        | 'continue'
        | 'retry'
        | 'retryToolCall'
        | 'ask'
      /** @description An ask that is never stored. */
      ephemeral?: boolean
      /** @description The chat is kept on the device, which sends it as thread. */
      local?: boolean
      thread?: components['schemas']['ThreadInput']
      profile?: components['schemas']['ProfileInput']
      projectId?: string | null
      presetId?: string | null
      content?: string
      quote?: string
      /** @description The message an edit, regenerate, continue or retry acts on. */
      messageId?: string
      /** @description The widget call a retryToolCall regenerates. */
      toolCallId?: string
      attachments?: components['schemas']['SentAttachment'][]
      /** @description The widgets this client renders. */
      widgets?: string[]
      options?: components['schemas']['TurnOptions']
    }
    TurnOptions: {
      model?: string
      autoIntelligence?: string
      reasoningEffort?: string
      timezone?: string
      locale?: string
      thinking?: boolean
      webSearch?: boolean
      piiCheck?: boolean
      genUI?: boolean
      /** @description 256 random bits the client keeps, hex encoded, which scope the model enclaves' prompt cache to the client. Turns without one share a cache only within their chat. */
      cacheSecret?: string
    }
    /** @description An upload's attachment as a turn sends it back, or the id alone of one the chat already holds. */
    SentAttachment: {
      id: components['schemas']['Identifier']
      kind?: components['schemas']['AttachmentKind']
      fileName?: string
      mimeType?: string
      size?: number
      thumbnail?: string
      textContent?: string
      description?: string
      pages?: components['schemas']['DocumentPage'][]
      base64?: string
    }
    FollowInput: {
      /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
      key?: string
      threadId: components['schemas']['Identifier']
      runId: string
    }
    /** @description A run, or a turn queued behind one, of a chat. */
    RunRequest: {
      /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
      key?: string
      threadId: components['schemas']['Identifier']
      runId?: string
      queueId?: string
    }
    /** @description One event of a run. */
    HarnessEvent:
      | components['schemas']['RunStartedEvent']
      | components['schemas']['MessagesSnapshotEvent']
      | components['schemas']['StateSnapshotEvent']
      | components['schemas']['StateDeltaEvent']
      | components['schemas']['TextMessageChunkEvent']
      | components['schemas']['ReasoningMessageChunkEvent']
      | components['schemas']['ReasoningSummaryEvent']
      | components['schemas']['ToolCallStartEvent']
      | components['schemas']['ToolCallArgsEvent']
      | components['schemas']['ToolCallEndEvent']
      | components['schemas']['ToolCallResultEvent']
      | components['schemas']['ActivitySnapshotEvent']
      | components['schemas']['ActivityDeltaEvent']
      | components['schemas']['RunFinishedEvent']
      | components['schemas']['RunErrorEvent']
    /** @description Opens a run. A continuation names the reply it streams into. */
    RunStartedEvent: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      type: 'RUN_STARTED'
      timestamp?: components['schemas']['Timestamp']
      threadId: string
      runId: string
      /** @description The instance holding the run, which requests about the run send as X-Tinfoil-Harness-Instance. */
      instance: string
      messageId?: string
    }
    /** @description The chat's latest messages as the run begins. */
    MessagesSnapshotEvent: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      type: 'MESSAGES_SNAPSHOT'
      timestamp?: components['schemas']['Timestamp']
      messages: components['schemas']['MessageView'][]
      hasOlder: boolean
    }
    StateSnapshotEvent: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      type: 'STATE_SNAPSHOT'
      timestamp?: components['schemas']['Timestamp']
      /** @description The run's chat, its queue, and the caller's quota. */
      snapshot: {
        thread: components['schemas']['ThreadSummary']
        queue: components['schemas']['QueueItem'][]
        rateLimit: components['schemas']['RateLimit']
      }
    }
    /** @description Changes to the run's state. One that names a run is about a turn queued behind the running reply. */
    StateDeltaEvent: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      type: 'STATE_DELTA'
      timestamp?: components['schemas']['Timestamp']
      threadId?: string
      runId?: string
      delta: components['schemas']['StatePatch'][]
    }
    StatePatch:
      | {
          /** @constant */
          op: 'add'
          /** @constant */
          path: '/queue/-'
          value: components['schemas']['QueueItem']
        }
      | {
          /** @constant */
          op: 'replace'
          /** @constant */
          path: '/queue'
          value: components['schemas']['QueueItem'][]
        }
      | {
          /** @constant */
          op: 'replace'
          /** @constant */
          path: '/thread/title'
          value: string
        }
      | {
          /** @constant */
          op: 'replace'
          /** @constant */
          path: '/thread/titleState'
          value: components['schemas']['TitleState']
        }
    /** @description A turn waiting behind its chat's running reply. */
    QueueItem: {
      queueId: string
      kind: string
      content: string | null
      quote: string | null
      attachments: {
        id?: string
        kind?: components['schemas']['AttachmentKind']
        fileName?: string
        mimeType?: string
        size?: number
        thumbnail?: string
      }[]
      createdAt: components['schemas']['Timestamp']
    }
    TextMessageChunkEvent: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      type: 'TEXT_MESSAGE_CHUNK'
      timestamp?: components['schemas']['Timestamp']
      messageId: string
      /** @constant */
      role: 'assistant'
      delta: string
    }
    /** @description Reasoning streamed into a reply. Its messageId is the reply's with "-reasoning" after it. */
    ReasoningMessageChunkEvent: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      type: 'REASONING_MESSAGE_CHUNK'
      timestamp?: components['schemas']['Timestamp']
      messageId: string
      delta: string
    }
    /** @description A short summary of a reasoning block while it goes on. It is not stored with the chat. */
    ReasoningSummaryEvent: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      type: 'REASONING_SUMMARY'
      timestamp?: components['schemas']['Timestamp']
      messageId: string
      blockId: string
      content: string
    }
    ToolCallStartEvent: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      type: 'TOOL_CALL_START'
      timestamp?: components['schemas']['Timestamp']
      toolCallId: string
      toolCallName: string
      parentMessageId?: string
    }
    ToolCallArgsEvent: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      type: 'TOOL_CALL_ARGS'
      timestamp?: components['schemas']['Timestamp']
      toolCallId: string
      delta: string
    }
    ToolCallEndEvent: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      type: 'TOOL_CALL_END'
      timestamp?: components['schemas']['Timestamp']
      toolCallId: string
    }
    ToolCallResultEvent: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      type: 'TOOL_CALL_RESULT'
      timestamp?: components['schemas']['Timestamp']
      messageId: string
      toolCallId: string
      /** @constant */
      role: 'tool'
      content: components['schemas']['Json']
      metadata?: components['schemas']['JsonObject']
      display?: components['schemas']['ToolDisplay']
    }
    /** @description Opens a tool's output while it runs. Its messageId is the call's id with "act_" before it. */
    ActivitySnapshotEvent: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      type: 'ACTIVITY_SNAPSHOT'
      timestamp?: components['schemas']['Timestamp']
      messageId: string
      /** @constant */
      activityType: 'TOOL'
      content: components['schemas']['ToolActivity']
      display?: components['schemas']['ToolDisplay']
    }
    ActivityDeltaEvent: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      type: 'ACTIVITY_DELTA'
      timestamp?: components['schemas']['Timestamp']
      messageId: string
      /** @constant */
      activityType: 'TOOL'
      patch: components['schemas']['ActivityPatch'][]
      display?: components['schemas']['ToolDisplay']
    }
    /** @description A tool's output as it runs, its progress and the lines it printed. */
    ToolActivity: {
      toolCallId: string
      tool: string
      progress: number
      output: components['schemas']['Json'][]
    }
    ActivityPatch:
      | {
          /** @constant */
          op: 'replace'
          /** @constant */
          path: '/progress'
          value: number
        }
      | {
          /** @constant */
          op: 'add'
          /** @constant */
          path: '/output/-'
          value: string
        }
    RunFinishedEvent: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      type: 'RUN_FINISHED'
      timestamp?: components['schemas']['Timestamp']
      threadId: string
      runId: string
      metadata: components['schemas']['RunMetadata']
    }
    /** @description Ends a run that failed, with the members of ErrorBody. One a stream ends with after its run was lost names neither the chat nor the run. */
    RunErrorEvent: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      type: 'RUN_ERROR'
      timestamp?: components['schemas']['Timestamp']
      threadId?: string
      runId?: string
      code: components['schemas']['ErrorCode']
      message: string
      action: components['schemas']['ErrorAction']
      kind?: string
      retryAfter?: number
      resetsAt?: components['schemas']['Timestamp']
      status?: number
      keyId?: string
      upstreamCode?: string
      rateLimit?: components['schemas']['RateLimit']
      metadata?: components['schemas']['RunMetadata']
    }
    /** @description What a run's last event reports. A device chat's run returns the whole chat. */
    RunMetadata: {
      messages?: components['schemas']['CommittedReply'][]
      thread?: components['schemas']['ThreadRecord']
      usage?: {
        prompt_tokens: number
        completion_tokens: number
        total_tokens: number
      }
      rateLimit?: components['schemas']['RateLimit']
      cancelled?: boolean
    }
    /** @description What a run commits to a reply beyond its streamed content. */
    CommittedReply: {
      id: string
      model?: string
      modelDisplayName?: string
      usage?: components['schemas']['MessageUsage']
      isError?: boolean
      isInterrupted?: boolean
      annotations?: components['schemas']['Annotation'][]
    }
    /** @description How a chat came by its title. A client shows the title of a state it does not know as it is. */
    TitleState: ('placeholder' | 'generated' | 'manual') | string
    /** @description How much of the model's window the chat's last prompt filled. */
    ContextUsage: {
      usedTokens: number
      limitTokens: number
      percentage: number
    }
    /** @description A chat as a list shows it. */
    ThreadSummary: {
      id: string
      title: string
      titleState: components['schemas']['TitleState']
      createdAt: string | null
      updatedAt: string | null
      /** @description When the chat's latest message was written. */
      activityAt: string
      projectId: string | null
      model: string
      webSearchEnabled: boolean
      pinned: boolean
      /** @description How much of the model's window the chat's last prompt filled. */
      contextUsage: {
        usedTokens: number
        limitTokens: number
        percentage: number
      } | null
      /** @description A hint that a reply may be streaming, until the run's deadline. It never locks the chat. */
      activeRun: {
        runId: string
        expiresAt: components['schemas']['Timestamp']
        /** @description The instance holding the run, which a client following or cancelling it after a reload sends as X-Tinfoil-Harness-Instance. */
        instance: string
      } | null
      messageCount: number
      /** @description The safeguards flagged the chat, which takes no more turns. */
      flagged?: boolean
    }
    /** @description A chat shown from its latest messages back. */
    ThreadWindow: {
      id: string
      title: string
      titleState: components['schemas']['TitleState']
      createdAt: string | null
      updatedAt: string | null
      /** @description When the chat's latest message was written. */
      activityAt: string
      projectId: string | null
      model: string
      webSearchEnabled: boolean
      pinned: boolean
      /** @description How much of the model's window the chat's last prompt filled. */
      contextUsage: {
        usedTokens: number
        limitTokens: number
        percentage: number
      } | null
      /** @description A hint that a reply may be streaming, until the run's deadline. It never locks the chat. */
      activeRun: {
        runId: string
        expiresAt: components['schemas']['Timestamp']
        /** @description The instance holding the run, which a client following or cancelling it after a reload sends as X-Tinfoil-Harness-Instance. */
        instance: string
      } | null
      messageCount: number
      /** @description The safeguards flagged the chat, which takes no more turns. */
      flagged?: boolean
      revision: string
      presetId: string | null
      messages: components['schemas']['MessageView'][]
      hasOlder: boolean
    }
    /** @description A message as a client shows it, a question's text or a reply's timeline, with its attachments' metadata. */
    MessageView: {
      id: string
      role: components['schemas']['Role']
      createdAt: string
      /** @description A question's text. */
      content?: string
      /** @description A reply's steps. */
      timeline?: components['schemas']['Block'][]
      quote?: string
      model?: string
      modelDisplayName?: string
      isError?: boolean
      isInterrupted?: boolean
      usage?: components['schemas']['MessageUsage']
      annotations?: components['schemas']['Annotation'][]
      attachments?: components['schemas']['AttachmentView'][]
    }
    /** @description Who wrote a message. A client leaves out a message whose role it does not know. */
    Role: ('user' | 'assistant') | string
    MessageUsage: {
      promptTokens: number
      completionTokens: number
    }
    /** @description One step of a reply, text, reasoning, or a tool call. What a tool returned is kept as it came. */
    Block: {
      id: string
      /** @description A client leaves out a block of a type it does not know. */
      type: ('content' | 'thinking' | 'tool_call') | string
      content?: string
      toolCallId?: string
      name?: string
      arguments?: string
      complete?: boolean
      result?: components['schemas']['Json']
      metadata?: components['schemas']['Json']
      progress?: components['schemas']['Json'][]
      activity?: components['schemas']['Json']
      display?: components['schemas']['ToolDisplay']
      /** @description Epoch milliseconds. */
      startedAt?: number
      /** @description Epoch milliseconds. */
      endedAt?: number
      /** @description How long a reasoning step thought, in seconds. */
      duration?: number
      /** @description The widget's current declaration refuses the call's arguments, so the client offers to regenerate them. */
      invalidArguments?: boolean
    }
    /** @description What a web search or page fetch shows, kept current while it runs. */
    ToolDisplay: {
      query?: string
      url?: string
      /** @description A client shows a status it does not know as completed. */
      status: ('running' | 'completed' | 'failed') | string
      sources: {
        url: string
        title: string
        snippet?: string
      }[]
    }
    /** @description A reply's citation of a page. */
    Annotation: {
      /** @constant */
      type: 'url_citation'
      url_citation?: {
        url: string
        title: string
        start_index: number
        end_index: number
      }
    }
    /** @description What an attachment holds. A client shows an attachment of a kind it does not know as a file. */
    AttachmentKind: ('image' | 'document' | 'audio') | string
    /** @description An attachment's metadata, thumbnail and any text it holds inline. */
    AttachmentView: {
      id: string
      kind: components['schemas']['AttachmentKind']
      fileName: string
      mimeType: string
      size?: number
      thumbnail?: string
      textContent?: string
      description?: string
    }
    /** @description An attachment as an upload returns it and a device chat keeps it. */
    Attachment: {
      id: string
      kind: components['schemas']['AttachmentKind']
      fileName: string
      mimeType: string
      size?: number
      thumbnail?: string
      textContent?: string
      description?: string
      pages?: components['schemas']['DocumentPage'][]
      /** @description The copy of an image models read. */
      base64?: string
      /** @description An imported image's original, only in an import's lines. A client keeps it apart from the chat. */
      originalBase64?: string
    }
    DocumentPage: {
      image: string
      is_scanned: boolean
      page: number
      text: string
    }
    /**
     * @description A whole chat, as a device keeps it. A device chat's run returns it, and
     *     the next turn sends it back as thread. A client keeps every member,
     *     including members this document does not list, and sends them back
     *     unchanged.
     */
    ThreadRecord: {
      id: string
      title: string
      titleState: components['schemas']['TitleState']
      createdAt?: string
      updatedAt?: string
      model: string
      projectId?: string | null
      presetId: string | null
      pinned: boolean
      webSearchEnabled: boolean
      messages: components['schemas']['MessageRecord'][]
      lastRequestId?: string
      /** @description What the last request's turn did, which a retry repeats. */
      lastRequestKind?: string
      /** @description A hint that a reply may be streaming, until the run's deadline. It never locks the chat. */
      activeRun?: {
        runId: string
        expiresAt: components['schemas']['Timestamp']
        /** @description The instance holding the run, which a client following or cancelling it after a reload sends as X-Tinfoil-Harness-Instance. */
        instance: string
      } | null
      contextUsage?: components['schemas']['ContextUsage']
      flagged?: boolean
      /** @description How many leading messages an ask's chat holds as context without showing them. */
      harnessHiddenCount?: number
      /** @description The format the harness wrote the record in. */
      recordVersion: number
    }
    MessageRecord: {
      id: string
      role: components['schemas']['Role']
      createdAt: string
      content: string
      quote?: string
      model?: string
      modelDisplayName?: string
      timeline?: components['schemas']['Block'][]
      attachments?: components['schemas']['Attachment'][]
      annotations?: components['schemas']['Annotation'][]
      usage?: components['schemas']['MessageUsage']
      isError?: boolean
      isInterrupted?: boolean
    }
    /** @description A device chat as its client sends it: a ThreadRecord the harness returned, sent back whole, or a record without a recordVersion that an older client kept or a client made for a new chat. The harness refuses a ThreadRecord with a member its version does not have. */
    ThreadInput: {
      /** @description The version of the ThreadRecord the harness returned. Absent from a record an older client kept or a client made. */
      recordVersion?: number
      title?: string
      titleState?: string
      model?: string
      lastRequestId?: string
      pinned?: boolean
      webSearchEnabled?: boolean
      presetId?: string | null
      messages?: ({
        id?: components['schemas']['Identifier']
        role: components['schemas']['Role']
        content?: string | null
        attachments?: unknown[]
        timeline?: unknown[]
      } & {
        [key: string]: unknown
      })[]
    } & {
      [key: string]: unknown
    }
    MessageRequest: {
      /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
      key?: string
      local?: boolean
      thread?: components['schemas']['ThreadInput']
      profile?: components['schemas']['ProfileInput']
      threadId: components['schemas']['Identifier']
      messageId: components['schemas']['Identifier']
      content?: string
    }
    DeviceThreadReply: {
      thread: components['schemas']['ThreadRecord']
    }
    /** @description An opened share, whose attachments name the key that reads each blob. */
    SharedThread: {
      title: string
      createdAt: string | null
      messages: {
        id: string
        role: components['schemas']['Role']
        createdAt: string
        /** @description A question's text. */
        content?: string
        /** @description A reply's steps. */
        timeline?: components['schemas']['Block'][]
        quote?: string
        model?: string
        modelDisplayName?: string
        isError?: boolean
        isInterrupted?: boolean
        usage?: components['schemas']['MessageUsage']
        annotations?: components['schemas']['Annotation'][]
        attachments?: {
          id: string
          kind: components['schemas']['AttachmentKind']
          fileName: string
          mimeType: string
          size?: number
          thumbnail?: string
          textContent?: string
          description?: string
          attKey: string | null
        }[]
      }[]
    }
    /** @description An attachment of a stored chat, or one a share names by the key its link carries. */
    AttachmentRequest: {
      type?: string
      /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
      key?: string
      id: components['schemas']['Identifier']
      threadId?: components['schemas']['Identifier']
      attKey?: string
      kind?: components['schemas']['AttachmentKind']
      fileName?: string
      mimeType?: string
      textContent?: string
      pages?: components['schemas']['DocumentPage'][]
    }
    /** @description The account's settings. A field a profile leaves out takes its value from the session's profileDefaults. */
    Profile: {
      /** @description A client applies its own default for a value it does not know, and keeps the value. */
      themeMode?: ('light' | 'dark' | 'system') | string
      /** @description A client applies its own default for a value it does not know, and keeps the value. */
      chatFont?: ('system' | 'serif' | 'mono' | 'dyslexic') | string
      language?: string
      nickname?: string
      profession?: string
      traits?: string[]
      additionalContext?: string
      isUsingPersonalization?: boolean
      isUsingCustomPrompt?: boolean
      customSystemPrompt?: string
      customPromptPresets?: components['schemas']['CustomPreset'][]
      favoritePromptPresetIds?: string[]
      defaultPromptPresetId?: string
      selectedModel?: string
      autoIntelligence?: string
      reasoningEffort?: string
      thinkingEnabled?: boolean
      webSearchEnabled?: boolean
      webSearchAvailable?: boolean
      piiCheckEnabled?: boolean
      genUIEnabled?: boolean
      pixelateSidebarChatTitlesEnabled?: boolean
      browserTabChatTitleEnabled?: boolean
      enterToNewlineEnabled?: boolean
      hasSeenOnboarding?: boolean
      hasSeenWebSearchIntro?: boolean
      dismissed?: {
        [key: string]: boolean
      }
    }
    ProfileView: {
      /** @description A client applies its own default for a value it does not know, and keeps the value. */
      themeMode?: ('light' | 'dark' | 'system') | string
      /** @description A client applies its own default for a value it does not know, and keeps the value. */
      chatFont?: ('system' | 'serif' | 'mono' | 'dyslexic') | string
      language?: string
      nickname?: string
      profession?: string
      traits?: string[]
      additionalContext?: string
      isUsingPersonalization?: boolean
      isUsingCustomPrompt?: boolean
      customSystemPrompt?: string
      customPromptPresets?: components['schemas']['CustomPreset'][]
      favoritePromptPresetIds?: string[]
      defaultPromptPresetId?: string
      selectedModel?: string
      autoIntelligence?: string
      reasoningEffort?: string
      thinkingEnabled?: boolean
      webSearchEnabled?: boolean
      webSearchAvailable?: boolean
      piiCheckEnabled?: boolean
      genUIEnabled?: boolean
      pixelateSidebarChatTitlesEnabled?: boolean
      browserTabChatTitleEnabled?: boolean
      enterToNewlineEnabled?: boolean
      hasSeenOnboarding?: boolean
      hasSeenWebSearchIntro?: boolean
      dismissed?: {
        [key: string]: boolean
      }
      updatedAt?: components['schemas']['Timestamp']
    }
    /** @description Settings a device keeps, which a client sends as a Profile. They may hold values older clients wrote, so the harness reads them leniently, ignoring fields it does not know and fields of the wrong type. */
    ProfileInput: {
      [key: string]: unknown
    }
    /** @description A prompt the user saved. Its timestamps are kept as the client wrote them. */
    CustomPreset: {
      id: string
      name: string
      description?: string
      systemPrompt?: string
      model?: string
      webSearchEnabled?: boolean
      createdAt?: components['schemas']['Json']
      updatedAt?: components['schemas']['Json']
    }
    Project: {
      id: string
      name: string
      description: string
      systemInstructions: string
      color: string | null
      createdAt?: components['schemas']['Timestamp']
      updatedAt?: components['schemas']['Timestamp']
    }
    /** @description A document's extracted text, which every chat of its project reads. */
    ProjectDocument: {
      id: string
      projectId: string
      filename: string
      contentType: string
      sizeBytes: number
      content?: string
      thumbnailBase64?: string
      createdAt?: components['schemas']['Timestamp']
      updatedAt?: components['schemas']['Timestamp']
    }
    /** @description How the account's key was set up. A client treats an origin it does not know as unknown. */
    KeyOrigin: ('passkey' | 'manual' | 'recovery' | 'start_fresh') | string
    KeyRef: {
      /** @description A content key, base64. */
      key: string
    }
    KeyBundleInput: {
      credential_id: string
      /** @description The AES-GCM IV, hex. */
      kek_iv: string
      /** @description The wrapped content key, hex. */
      encrypted_keys: string
    }
    KeyCurrent: {
      /** @description Hex. Null while the account has no key. */
      key_id: string | null
      etag?: string
      /** @description The passkey bundles by credential id. Null before the key has any. */
      bundles: {
        [key: string]: {
          credential_id: string
          kek_iv: string
          encrypted_keys: string
          bundle_version?: number
          created_at?: string
          updated_at?: string
        }
      } | null
      created_via?: components['schemas']['KeyOrigin']
      created_at?: string
      /** @description The account has rows not sealed under this key. */
      has_data?: boolean
    }
    /** @description Where a reseal stands: the rows resealed so far, the rows still to try, and the rows no given key opens. */
    ResealReport: {
      /** @description A client treats a status it does not know as running. */
      status: ('running' | 'complete' | 'failed') | string
      migrated: number
      remaining: number
      blocked: number
      /** @description The reseal's time or the account's credential ran out before every row was tried; a later call continues it. */
      partial: boolean
    }
    /** @description One line of a device import. */
    ImportLine: {
      /** @description A device chat. Its images' attachments carry the archive's original as originalBase64. */
      thread?: components['schemas']['ThreadRecord']
      done?: {
        /** @description The cloud import job, whose status the client polls. */
        jobId: string | null
        warnings: string[]
      }
      error?: components['schemas']['ErrorBody']
    }
    ImportStatus: {
      jobId: string
      status: string
      phase?: string
      imported: number
      failed: number
      total: number
      counts?: {
        [key: string]: {
          imported: number
          skipped: number
          failed: number
          blocked: number
        }
      }
      warnings?: string[]
      errors?: string[]
      failureReason?: string
      failureDetail?: string
    }
    LinkPreview: {
      url: string
      title: string | null
      description: string | null
      siteName: string | null
      image: string | null
    }
  }
  responses: {
    /** @description A refusal. */
    Error: {
      headers: {
        [name: string]: unknown
      }
      content: {
        'application/json': components['schemas']['ErrorResponse']
      }
    }
    /** @description Done. */
    Empty: {
      headers: {
        [name: string]: unknown
      }
      content: {
        'application/json': Record<string, never>
      }
    }
    /** @description Done. */
    Ok: {
      headers: {
        [name: string]: unknown
      }
      content: {
        'application/json': {
          ok: boolean
        }
      }
    }
    /** @description How many rows were deleted. */
    Deleted: {
      headers: {
        [name: string]: unknown
      }
      content: {
        'application/json': {
          deleted: number
        }
      }
    }
    /** @description The attachment's bytes. */
    Bytes: {
      headers: {
        [name: string]: unknown
      }
      content: {
        'application/octet-stream': string
      }
    }
    /** @description The run's events. */
    RunEvents: {
      headers: {
        [name: string]: unknown
      }
      content: {
        'text/event-stream': string
      }
    }
    /** @description The session. */
    Session: {
      headers: {
        [name: string]: unknown
      }
      content: {
        'application/json': components['schemas']['Session']
      }
    }
    /** @description The chat, from its latest messages back. */
    ThreadWindow: {
      headers: {
        [name: string]: unknown
      }
      content: {
        'application/json': components['schemas']['ThreadWindow']
      }
    }
    /** @description The changed chat. A cloud chat answers with its latest messages, a device chat with its new record. */
    ChangedThread: {
      headers: {
        [name: string]: unknown
      }
      content: {
        'application/json':
          | components['schemas']['ThreadWindow']
          | components['schemas']['DeviceThreadReply']
      }
    }
    /** @description The profile. */
    Profile: {
      headers: {
        [name: string]: unknown
      }
      content: {
        'application/json': components['schemas']['ProfileView']
      }
    }
    /** @description The project. */
    Project: {
      headers: {
        [name: string]: unknown
      }
      content: {
        'application/json': components['schemas']['Project']
      }
    }
  }
  parameters: {
    /** @description The cursor of the last event of the run the client applied. The stream resumes after it, and starts from the run's first event without it. A cursor the run never sent is refused. */
    LastEventId: number
    /** @description The instance a run's RUN_STARTED named. A deployment of several harnesses routes a request about the run to it by this header, which says nothing about the caller. */
    HarnessInstance: string
  }
  requestBodies: never
  headers: never
  pathItems: never
}
export type $defs = Record<string, never>
export interface operations {
  health: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description The harness is serving. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            /** @constant */
            ok: true
          }
        }
      }
    }
  }
  session: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: {
      content: {
        'application/json': Record<string, never>
      }
    }
    responses: {
      200: components['responses']['Session']
      default: components['responses']['Error']
    }
  }
  changes: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: {
      content: {
        'application/json': Record<string, never>
      }
    }
    responses: {
      /** @description The current revisions. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            chats: string
            profile: string
            projects: string
          }
        }
      }
      default: components['responses']['Error']
    }
  }
  turn: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['Turn']
      }
    }
    responses: {
      200: components['responses']['RunEvents']
      default: components['responses']['Error']
    }
  }
  follow: {
    parameters: {
      query?: never
      header?: {
        /** @description The instance a run's RUN_STARTED named. A deployment of several harnesses routes a request about the run to it by this header, which says nothing about the caller. */
        'X-Tinfoil-Harness-Instance'?: components['parameters']['HarnessInstance']
        /** @description The cursor of the last event of the run the client applied. The stream resumes after it, and starts from the run's first event without it. A cursor the run never sent is refused. */
        'Last-Event-ID'?: components['parameters']['LastEventId']
      }
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['FollowInput']
      }
    }
    responses: {
      200: components['responses']['RunEvents']
      default: components['responses']['Error']
    }
  }
  cancel: {
    parameters: {
      query?: never
      header?: {
        /** @description The instance a run's RUN_STARTED named. A deployment of several harnesses routes a request about the run to it by this header, which says nothing about the caller. */
        'X-Tinfoil-Harness-Instance'?: components['parameters']['HarnessInstance']
      }
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['RunRequest']
      }
    }
    responses: {
      200: components['responses']['Empty']
      default: components['responses']['Error']
    }
  }
  queueSend: {
    parameters: {
      query?: never
      header?: {
        /** @description The instance a run's RUN_STARTED named. A deployment of several harnesses routes a request about the run to it by this header, which says nothing about the caller. */
        'X-Tinfoil-Harness-Instance'?: components['parameters']['HarnessInstance']
      }
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['RunRequest']
      }
    }
    responses: {
      200: components['responses']['Empty']
      default: components['responses']['Error']
    }
  }
  queueRemove: {
    parameters: {
      query?: never
      header?: {
        /** @description The instance a run's RUN_STARTED named. A deployment of several harnesses routes a request about the run to it by this header, which says nothing about the caller. */
        'X-Tinfoil-Harness-Instance'?: components['parameters']['HarnessInstance']
      }
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['RunRequest']
      }
    }
    responses: {
      200: components['responses']['Empty']
      default: components['responses']['Error']
    }
  }
  list: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
          key?: string
          cursor?: string
          projectId?: string
          limit?: number
        }
      }
    }
    responses: {
      /** @description A page of the account's stored chats, newest first, and its pinned chats. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            threads: components['schemas']['ThreadSummary'][]
            /** @description Empty on the last page. */
            nextCursor: string
            pinned: components['schemas']['ThreadSummary'][]
          }
        }
      }
      default: components['responses']['Error']
    }
  }
  search: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
          key?: string
          query: string
          limit?: number
        }
      }
    }
    responses: {
      /** @description The stored chats that match, how many more match that the harness could not open, and whether the search index is still being built. A chat the control plane could not serve in time fails the search with UPSTREAM_REFUSED, and a failed rebuild of the search index with SEARCH_INDEX_FAILED. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            results: components['schemas']['ThreadSummary'][]
            /** @description Matching chats left out of results because they cannot be opened, such as one sealed with another key or stored in a format this harness cannot read. */
            unreadable: number
            indexing: boolean
          }
        }
      }
      default: components['responses']['Error']
    }
  }
  get: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
          key?: string
          id: components['schemas']['Identifier']
          /** @description A message id; the window ends before it. */
          before?: string
          /** @description At most 200; 50 when absent. */
          limit?: number
        }
      }
    }
    responses: {
      200: components['responses']['ThreadWindow']
      default: components['responses']['Error']
    }
  }
  update: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
          key?: string
          local?: boolean
          thread?: components['schemas']['ThreadInput']
          profile?: components['schemas']['ProfileInput']
          id: components['schemas']['Identifier']
          title?: string
          model?: string
          webSearchEnabled?: boolean
          /** @description Cloud chats only. */
          pinned?: boolean
          /** @description Cloud chats only. Null takes the chat out of its project. */
          projectId?: string | null
          /** @description Choosing another prompt takes the settings it chooses, except those this request sets. */
          presetId?: string | null
        }
      }
    }
    responses: {
      /** @description The changed chat. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json':
            | components['schemas']['ThreadSummary']
            | components['schemas']['DeviceThreadReply']
        }
      }
      default: components['responses']['Error']
    }
  }
  fork: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['MessageRequest']
      }
    }
    responses: {
      /** @description The new chat. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json':
            | components['schemas']['ThreadSummary']
            | components['schemas']['DeviceThreadReply']
        }
      }
      default: components['responses']['Error']
    }
  }
  messageDelete: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['MessageRequest']
      }
    }
    responses: {
      200: components['responses']['ChangedThread']
      default: components['responses']['Error']
    }
  }
  messageUpdate: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
          key?: string
          local?: boolean
          thread?: components['schemas']['ThreadInput']
          profile?: components['schemas']['ProfileInput']
          threadId: components['schemas']['Identifier']
          messageId: components['schemas']['Identifier']
          content: string
        }
      }
    }
    responses: {
      200: components['responses']['ChangedThread']
      default: components['responses']['Error']
    }
  }
  delete: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
          key?: string
          id: components['schemas']['Identifier']
          /** @description Set when a chat moved to the device is deleted from the cloud; the delete then needs the revision the move read. */
          revision?: string
        }
      }
    }
    responses: {
      200: components['responses']['Empty']
      default: components['responses']['Error']
    }
  }
  deleteAll: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
          key?: string
          projectId?: string | null
        }
      }
    }
    responses: {
      200: components['responses']['Deleted']
      default: components['responses']['Error']
    }
  }
  transcript: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
          key?: string
          threadId: components['schemas']['Identifier']
        }
      }
    }
    responses: {
      /** @description The chat and the revision a delete that finishes the move names. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            thread: components['schemas']['ThreadRecord']
            revision: string
          }
        }
      }
      default: components['responses']['Error']
    }
  }
  threadImport: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
          key?: string
          threadId: components['schemas']['Identifier']
          thread: components['schemas']['ThreadInput']
        }
      }
    }
    responses: {
      /** @description The stored chat. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ThreadSummary']
        }
      }
      default: components['responses']['Error']
    }
  }
  upgrade: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          threads: Record<string, never>[]
        }
      }
    }
    responses: {
      /** @description The chats, in the order sent. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            threads: components['schemas']['ThreadRecord'][]
          }
        }
      }
      default: components['responses']['Error']
    }
  }
  share: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
          key?: string
          threadId: components['schemas']['Identifier']
          local?: boolean
          thread?: components['schemas']['ThreadInput']
        }
      }
    }
    responses: {
      /** @description The share link, whose fragment holds the key that opens it. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            url: string
          }
        }
      }
      default: components['responses']['Error']
    }
  }
  shareStatus: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['ThreadIdRequest']
      }
    }
    responses: {
      /** @description Whether the chat has a live share. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            shared: boolean
          }
        }
      }
      default: components['responses']['Error']
    }
  }
  shareRevoke: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['ThreadIdRequest']
      }
    }
    responses: {
      200: components['responses']['Empty']
      default: components['responses']['Error']
    }
  }
  shareOpen: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          shareId: components['schemas']['Identifier']
          /** @description The share link's fragment. */
          fragment: string
        }
      }
    }
    responses: {
      /** @description The shared chat. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['SharedThread']
        }
      }
      default: components['responses']['Error']
    }
  }
  profileGet: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['Keyed']
      }
    }
    responses: {
      200: components['responses']['Profile']
      default: components['responses']['Error']
    }
  }
  profileUpdate: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
          key?: string
          /** @description The fields to set. A field the profile does not have is refused. A null defaultPromptPresetId clears the default prompt. */
          patch: {
            /** @enum {string} */
            themeMode?: 'light' | 'dark' | 'system'
            /** @enum {string} */
            chatFont?: 'system' | 'serif' | 'mono' | 'dyslexic'
            language?: string
            nickname?: string
            profession?: string
            traits?: string[]
            additionalContext?: string
            isUsingPersonalization?: boolean
            isUsingCustomPrompt?: boolean
            customSystemPrompt?: string
            customPromptPresets?: components['schemas']['CustomPreset'][]
            favoritePromptPresetIds?: string[]
            defaultPromptPresetId?: string | null
            selectedModel?: string
            autoIntelligence?: string
            reasoningEffort?: string
            thinkingEnabled?: boolean
            webSearchEnabled?: boolean
            webSearchAvailable?: boolean
            piiCheckEnabled?: boolean
            genUIEnabled?: boolean
            pixelateSidebarChatTitlesEnabled?: boolean
            browserTabChatTitleEnabled?: boolean
            enterToNewlineEnabled?: boolean
            hasSeenOnboarding?: boolean
            hasSeenWebSearchIntro?: boolean
            dismissed?: {
              [key: string]: boolean
            }
          }
        }
      }
    }
    responses: {
      200: components['responses']['Profile']
      default: components['responses']['Error']
    }
  }
  profileUpgrade: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          profile: components['schemas']['ProfileInput']
        }
      }
    }
    responses: {
      /** @description The settings as a profile. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            profile: components['schemas']['Profile']
          }
        }
      }
      default: components['responses']['Error']
    }
  }
  profileMerge: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
          key?: string
          profile: components['schemas']['ProfileInput']
          /** @description The fields the device changed, which win over the account's. */
          changedFields?: string[]
        }
      }
    }
    responses: {
      200: components['responses']['Profile']
      default: components['responses']['Error']
    }
  }
  projectsList: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
          key?: string
          cursor?: string
          limit?: number
        }
      }
    }
    responses: {
      /** @description A page of the account's projects. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            projects: components['schemas']['Project'][]
            /** @description Empty on the last page. */
            nextCursor: string
          }
        }
      }
      default: components['responses']['Error']
    }
  }
  projectsGet: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['KeyedId']
      }
    }
    responses: {
      /** @description The project and its documents. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            id: string
            name: string
            description: string
            systemInstructions: string
            color: string | null
            createdAt?: components['schemas']['Timestamp']
            updatedAt?: components['schemas']['Timestamp']
            documents: components['schemas']['ProjectDocument'][]
          }
        }
      }
      default: components['responses']['Error']
    }
  }
  projectsCreate: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
          key?: string
          id?: components['schemas']['Identifier']
          name: string
          description?: string
          systemInstructions?: string
          color?: string | null
        }
      }
    }
    responses: {
      200: components['responses']['Project']
      default: components['responses']['Error']
    }
  }
  projectsUpdate: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
          key?: string
          id: components['schemas']['Identifier']
          name?: string
          description?: string
          systemInstructions?: string
          color?: string | null
        }
      }
    }
    responses: {
      200: components['responses']['Project']
      default: components['responses']['Error']
    }
  }
  projectsDelete: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['KeyedId']
      }
    }
    responses: {
      200: components['responses']['Empty']
      default: components['responses']['Error']
    }
  }
  projectsDeleteAll: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['Keyed']
      }
    }
    responses: {
      200: components['responses']['Deleted']
      default: components['responses']['Error']
    }
  }
  projectDocumentUpload: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'multipart/form-data': {
          file: string
          projectId: string
          /** @description The account's content key, base64. */
          key?: string
        }
      }
    }
    responses: {
      /** @description The stored document. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ProjectDocument']
        }
      }
      default: components['responses']['Error']
    }
  }
  projectDocumentDelete: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
          key?: string
          projectId: components['schemas']['Identifier']
          documentId: components['schemas']['Identifier']
        }
      }
    }
    responses: {
      200: components['responses']['Empty']
      default: components['responses']['Error']
    }
  }
  keysCurrent: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: {
      content: {
        'application/json': Record<string, never>
      }
    }
    responses: {
      /** @description The current key. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['KeyCurrent']
        }
      }
      default: components['responses']['Error']
    }
  }
  keysRegister: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          /** @description The content key, base64. */
          key: string
          /** @description The current key's etag, or "*" while the account has none. */
          if_match: string
          created_via: components['schemas']['KeyOrigin']
          idempotency_key: string
          initial_bundle?: components['schemas']['KeyBundleInput']
        }
      }
    }
    responses: {
      /** @description The registered key. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            /** @constant */
            ok: true
            key_id: string
          }
        }
      }
      default: components['responses']['Error']
    }
  }
  keysAddBundle: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          credential_id: string
          /** @description The AES-GCM IV, hex. */
          kek_iv: string
          /** @description The wrapped content key, hex. */
          encrypted_keys: string
          key_id: string
          /** @description The content key, base64. */
          key: string
          idempotency_key: string
        }
      }
    }
    responses: {
      200: components['responses']['Ok']
      default: components['responses']['Error']
    }
  }
  keysRemoveBundle: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          key_id: string
          /** @description The content key, base64. */
          key: string
          credential_id: string
          idempotency_key: string
        }
      }
    }
    responses: {
      200: components['responses']['Ok']
      default: components['responses']['Error']
    }
  }
  keysMigrateAll: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          keys: components['schemas']['KeyRef'][]
          target: components['schemas']['KeyRef']
        }
      }
    }
    responses: {
      /** @description The harness's report of the reseal when the call returns. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ResealReport']
        }
      }
      default: components['responses']['Error']
    }
  }
  attachmentUpload: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'multipart/form-data': {
          file: string
        }
      }
    }
    responses: {
      /** @description The attachment. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            attachment: components['schemas']['Attachment']
          }
        }
      }
      default: components['responses']['Error']
    }
  }
  attachmentGet: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['AttachmentRequest']
      }
    }
    responses: {
      200: components['responses']['Bytes']
      default: components['responses']['Error']
    }
  }
  attachmentGetPublic: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['AttachmentRequest']
      }
    }
    responses: {
      200: components['responses']['Bytes']
      default: components['responses']['Error']
    }
  }
  transcriptions: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'multipart/form-data': {
          file: string
        }
      }
    }
    responses: {
      /** @description The recording's text. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            text: string
          }
        }
      }
      default: components['responses']['Error']
    }
  }
  speech: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          /** @description The account's content key, base64. Absent for device chats and signed-out callers. */
          key?: string
          local?: boolean
          thread?: components['schemas']['ThreadInput']
          profile?: components['schemas']['ProfileInput']
          threadId?: components['schemas']['Identifier']
          messageId?: components['schemas']['Identifier']
          /** @description Text to read when no message is named, such as a selection or a shared chat's message. */
          text?: string
        }
      }
    }
    responses: {
      /** @description The audio, streamed as it is made. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'audio/pcm': string
        }
      }
      default: components['responses']['Error']
    }
  }
  import: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'multipart/form-data': {
          file: string
          options?: string
        }
      }
    }
    responses: {
      /** @description One line per device chat, then a line that says the import is done. An import that fails after its first line ends with an error line. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/x-ndjson': string
        }
      }
      default: components['responses']['Error']
    }
  }
  importStatus: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          jobId: components['schemas']['Identifier']
        }
      }
    }
    responses: {
      /** @description The import job's progress. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ImportStatus']
        }
      }
      default: components['responses']['Error']
    }
  }
  export: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'multipart/form-data': {
          options?: string
          /** @description Device chats, one per part. */
          thread?: string[]
          /** @description The originals of the device chats' images. */
          file?: string[]
        }
      }
    }
    responses: {
      /** @description The archive. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/zip': string
          'application/json': string
        }
      }
      default: components['responses']['Error']
    }
  }
  favicon: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['PageRequest']
      }
    }
    responses: {
      /** @description The site's favicon, which the harness reads from DuckDuckGo by the site's host. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            /** @description found when the site has a favicon. */
            status: string
            /** @description Base64. */
            favicon_bytes?: string
            favicon_content_type?: string
          }
        }
      }
      default: components['responses']['Error']
    }
  }
  linkMetadata: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['PageRequest']
      }
    }
    responses: {
      /** @description A page's link preview. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['LinkPreview']
        }
      }
      default: components['responses']['Error']
    }
  }
}
