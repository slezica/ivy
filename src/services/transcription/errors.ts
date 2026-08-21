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

export type TranscriptionErrorCause = 'download-failed' | 'init-failed' | 'unknown'

export function classifyTranscriptionError(error: unknown): TranscriptionErrorCause {
  if (error instanceof ModelDownloadError) return 'download-failed'
  if (error instanceof ModelInitError) return 'init-failed'
  return 'unknown'
}

export function transcriptionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
