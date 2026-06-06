/**
 * Minimal ambient declaration for `@novnc/novnc/core/rfb.js`. The package
 * ships no type definitions; we type only what the live-view component
 * touches. Extend here if more API surface is needed.
 */

declare module '@novnc/novnc' {
  export interface RFBOptions {
    credentials?: { password?: string; username?: string; target?: string }
    shared?: boolean
    repeaterID?: string
    wsProtocols?: string[]
  }

  export default class RFB {
    constructor(target: HTMLElement, urlOrChannel: string, options?: RFBOptions)
    viewOnly: boolean
    scaleViewport: boolean
    resizeSession: boolean
    background: string
    disconnect(): void
    sendCredentials(creds: RFBOptions['credentials']): void
    addEventListener(
      type: string,
      handler: (event: { detail: unknown }) => void,
    ): void
    removeEventListener(
      type: string,
      handler: (event: { detail: unknown }) => void,
    ): void
  }
}
