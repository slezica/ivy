/**
 * Pure content logic for the clips-screen transcription banner.
 *
 * Kept free of React/store imports so it can be unit-tested directly.
 * The banner shows a message for every transcription state that is not
 * what the user already expects ('on' when enabled, 'off' when disabled).
 */

import type { AppState } from '../store/types'

export interface BannerInput {
  enabled: boolean
  status: AppState['transcription']['status']
  downloadProgress: number | null
  error: AppState['transcription']['error']
  retryAt: number | null
}

export interface BannerContent {
  message: string
  action: 'retry' | null
}

function failureLabel(error: BannerInput['error']): string {
  return error?.cause === 'download-failed'
    ? 'Failed to download transcription model'
    : 'Failed to start transcription process'
}

export function bannerContent(input: BannerInput, now: number): BannerContent | null {
  if (!input.enabled) {
    return null
  }

  if (input.status === 'downloading') {
    return {
      message: `Downloading transcription model... (${input.downloadProgress ?? 0}%)`,
      action: null,
    }
  }

  // Between automatic start attempts (status is back to 'starting')
  if (input.retryAt != null && input.status === 'starting') {
    const seconds = Math.ceil((input.retryAt - now) / 1000)
    const suffix = seconds > 0 ? `Retrying in ${seconds}s...` : 'Retrying...'
    return {
      message: `${failureLabel(input.error)}. ${suffix}`,
      action: null,
    }
  }

  // All automatic attempts exhausted
  if (input.status === 'error') {
    return {
      message: `${failureLabel(input.error)}. Tap to retry`,
      action: 'retry',
    }
  }

  // 'on', 'off' and plain 'starting' (brief; the banner debounces it away)
  return null
}
