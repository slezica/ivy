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
  action: 'retry' | 'download' | null
}

export function failureLabel(error: BannerInput['error']): string {
  return error?.cause === 'download-failed'
    ? 'Could not download transcription model'
    : 'Could not start transcriptions'
}

export function downloadingMessage(downloadProgress: number | null): string {
  return `Downloading transcription model... (${downloadProgress ?? 0}%)`
}

export function retryingMessage(error: BannerInput['error'], retryAt: number, now: number): string {
  const seconds = Math.ceil((retryAt - now) / 1000)
  const suffix = seconds > 0 ? `Retrying in ${seconds}s...` : 'Retrying...'
  return `${failureLabel(error)}. ${suffix}`
}

export function bannerContent(input: BannerInput, now: number): BannerContent | null {
  if (!input.enabled) {
    return null
  }

  if (input.status === 'downloading') {
    return {
      message: downloadingMessage(input.downloadProgress),
      action: null,
    }
  }

  if (input.status === 'waiting-wifi') {
    return {
      message: 'Waiting for Wi-Fi to download transcription model. Tap to download now.',
      action: 'download',
    }
  }

  // Between automatic start attempts (status is back to 'starting')
  if (input.retryAt != null && input.status === 'starting') {
    return {
      message: retryingMessage(input.error, input.retryAt, now),
      action: null,
    }
  }

  // All automatic attempts exhausted
  if (input.status === 'error') {
    return {
      message: `${failureLabel(input.error)}. Tap to retry.`,
      action: 'retry',
    }
  }

  // 'on', 'off' and plain 'starting' (brief; the banner debounces it away)
  return null
}
