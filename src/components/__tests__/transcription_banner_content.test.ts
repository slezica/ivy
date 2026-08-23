import { bannerContent, BannerInput } from '../transcription_banner_content'

const NOW = 1_000_000

function input(overrides: Partial<BannerInput> = {}): BannerInput {
  return {
    enabled: true,
    status: 'on',
    downloadProgress: null,
    error: null,
    retryAt: null,
    ...overrides,
  }
}

describe('bannerContent', () => {
  it('shows nothing when disabled, whatever the status', () => {
    expect(bannerContent(input({ enabled: false, status: 'off' }), NOW)).toBeNull()
    expect(bannerContent(input({ enabled: false, status: 'error' }), NOW)).toBeNull()
    expect(bannerContent(input({ enabled: false, status: 'downloading' }), NOW)).toBeNull()
  })

  it('shows nothing for the expected states', () => {
    expect(bannerContent(input({ status: 'on' }), NOW)).toBeNull()
    expect(bannerContent(input({ status: 'off' }), NOW)).toBeNull()
    expect(bannerContent(input({ status: 'starting' }), NOW)).toBeNull()
  })

  it('shows download progress', () => {
    expect(bannerContent(input({ status: 'downloading', downloadProgress: 42 }), NOW)).toEqual({
      message: 'Downloading transcription model... (42%)',
      action: null,
    })
  })

  it('shows a retry countdown between attempts', () => {
    const result = bannerContent(input({
      status: 'starting',
      retryAt: NOW + 15_000,
      error: { cause: 'download-failed', message: 'network down' },
    }), NOW)

    expect(result).toEqual({
      message: 'Could not download transcription model. Retrying in 15s...',
      action: null,
    })
  })

  it('shows "Retrying..." once the countdown expires', () => {
    const result = bannerContent(input({
      status: 'starting',
      retryAt: NOW - 500,
      error: { cause: 'download-failed', message: 'network down' },
    }), NOW)

    expect(result?.message).toBe('Could not download transcription model. Retrying...')
  })

  it('offers tap-to-download while waiting for wifi', () => {
    expect(bannerContent(input({ status: 'waiting-wifi' }), NOW)).toEqual({
      message: 'Waiting for Wi-Fi to download transcription model. Tap to download now.',
      action: 'download',
    })
  })

  it('offers tap-to-retry when attempts are exhausted', () => {
    const result = bannerContent(input({
      status: 'error',
      error: { cause: 'download-failed', message: 'network down' },
    }), NOW)

    expect(result).toEqual({
      message: 'Could not download transcription model. Tap to retry.',
      action: 'retry',
    })
  })

  it('uses generic copy for non-download failures', () => {
    const retrying = bannerContent(input({
      status: 'starting',
      retryAt: NOW + 5_000,
      error: { cause: 'init-failed', message: 'oom' },
    }), NOW)
    const gaveUp = bannerContent(input({
      status: 'error',
      error: { cause: 'unknown', message: 'what even' },
    }), NOW)

    expect(retrying?.message).toBe('Could not start transcriptions. Retrying in 5s...')
    expect(gaveUp?.message).toBe('Could not start transcriptions. Tap to retry.')
  })

  it('prefers download progress over a stale retry countdown', () => {
    const result = bannerContent(input({
      status: 'downloading',
      downloadProgress: 10,
      retryAt: NOW + 5_000,
      error: { cause: 'download-failed', message: 'network down' },
    }), NOW)

    expect(result?.message).toBe('Downloading transcription model... (10%)')
  })
})
