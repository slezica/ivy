/**
 * Whisper initialization failures, typed by phase so callers can tell the
 * user what went wrong (download = retryable/network, init = model load failed).
 *
 * Kept free of native imports so actions and tests can import them directly.
 */

export class ModelDownloadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'ModelDownloadError'
  }
}

export class ModelInitError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'ModelInitError'
  }
}
