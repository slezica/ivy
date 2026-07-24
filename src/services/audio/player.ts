/**
 * Audio Player Service
 *
 * Wraps react-native-track-player for playback control. Handles loading,
 * play/pause, seeking, and provides system media controls integration.
 */

import TrackPlayer, {
  Capability,
  Event,
  State,
  AppKilledPlaybackBehavior,
} from 'react-native-track-player'
import type { EmitterSubscription } from 'react-native'

import { BaseService } from '../base'
import { createLogger } from '../../utils'

const log = createLogger('AudioPlayer')

// =============================================================================
// Public Interface
// =============================================================================

export type PlayerStatus = 'idle' | 'loading' | 'paused' | 'playing'

export interface PlaybackStatus {
  status: PlayerStatus
  position: number  // milliseconds
  duration: number  // milliseconds
}

export interface TrackMetadata {
  title?: string | null
  artist?: string | null
  artwork?: string | null  // base64 data URI or file:// path
}

export type AudioPlayerEvents = {
  status: PlaybackStatus
}

// =============================================================================
// Service
// =============================================================================

const FADE_STEP_MS = 250

export class AudioPlayerService extends BaseService<AudioPlayerEvents> {
  private isSetup = false
  private currentDuration: number = 0
  private eventSubscriptions: EmitterSubscription[] = []
  private fadeTimer: ReturnType<typeof setInterval> | null = null
  private fadeResolve: ((completed: boolean) => void) | null = null

  async load(uri: string, metadata?: TrackMetadata): Promise<number> {
    log(`Loading: ${metadata?.title || 'unknown'}`)

    await this.ensureSetup()
    await TrackPlayer.reset()

    const track = {
      id: uri,
      url: uri,
      title: metadata?.title || 'Unknown',
      artist: metadata?.artist || 'Unknown Artist',
      artwork: metadata?.artwork || undefined,
    }

    await TrackPlayer.add(track)

    // Wait for duration to be available
    return new Promise((resolve, reject) => {
      let settled = false

      const timeout = setTimeout(() => {
        settled = true
        reject(new Error('Failed to load audio file: timeout after 10 seconds'))
      }, 10000)

      const checkDuration = async () => {
        if (settled) return

        try {
          const progress = await TrackPlayer.getProgress()
          if (progress.duration > 0) {
            settled = true
            clearTimeout(timeout)
            this.currentDuration = progress.duration * 1000  // Convert to ms
            resolve(this.currentDuration)
          } else {
            setTimeout(checkDuration, 100)
          }
        } catch {
          setTimeout(checkDuration, 100)
        }
      }
      checkDuration()
    })
  }

  async play(): Promise<void> {
    await TrackPlayer.play()
  }

  async pause(): Promise<void> {
    await TrackPlayer.pause()
  }

  async seek(positionMillis: number): Promise<void> {
    await TrackPlayer.seekTo(positionMillis / 1000)  // Convert to seconds
  }

  async setRate(rate: number): Promise<void> {
    await TrackPlayer.setRate(rate)
  }

  /**
   * Ramp volume from full to zero over durationMs. Resolves true when the
   * ramp completes, false if cancelled by resetVolume() before finishing.
   */
  async fadeOut(durationMs: number): Promise<boolean> {
    await this.resetVolume()

    return new Promise((resolve) => {
      const startedAt = Date.now()
      this.fadeResolve = resolve
      this.fadeTimer = setInterval(async () => {
        const progress = (Date.now() - startedAt) / durationMs
        if (progress >= 1) {
          this.clearFade(true)
          await TrackPlayer.setVolume(0)
        } else if (this.fadeTimer) {
          await TrackPlayer.setVolume(1 - progress)
        }
      }, FADE_STEP_MS)
    })
  }

  /** Cancel any running fade and restore full volume. */
  async resetVolume(): Promise<void> {
    this.clearFade(false)
    await TrackPlayer.setVolume(1)
  }

  async skip(offsetMillis: number): Promise<void> {
    const progress = await TrackPlayer.getProgress()
    const newPosition = Math.max(0, Math.min(progress.position + offsetMillis / 1000, progress.duration))
    await TrackPlayer.seekTo(newPosition)
  }

  async getStatus(): Promise<PlaybackStatus | null> {
    try {
      const { state } = await TrackPlayer.getPlaybackState()
      const progress = await TrackPlayer.getProgress()

      return {
        status: this.mapState(state),
        position: progress.position * 1000,  // Convert to ms
        duration: this.currentDuration,
      }
    } catch {
      return null
    }
  }

  async unload(): Promise<void> {
    log('Unloading')
    if (this.isSetup) {
      await TrackPlayer.reset()
    }
    this.currentDuration = 0
  }

  async updateMetadata(metadata: TrackMetadata): Promise<void> {
    const trackIndex = await TrackPlayer.getActiveTrackIndex()
    if (trackIndex !== undefined) {
      await TrackPlayer.updateNowPlayingMetadata({
        title: metadata.title || 'Unknown',
        artist: metadata.artist || 'Unknown Artist',
        artwork: metadata.artwork || undefined,
      })
    }
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  private async ensureSetup(): Promise<void> {
    if (this.isSetup) return

    log('Setting up TrackPlayer')

    try {
      await TrackPlayer.setupPlayer({
        autoHandleInterruptions: true,
      })
    } catch (error: any) {
      if (!error?.message?.includes('already been initialized')) throw error
      // Player was initialized in a previous instance (e.g. dev reload) — safe to continue
    }

    await TrackPlayer.updateOptions({
      android: {
        appKilledPlaybackBehavior: AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification,
      },
      capabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.SeekTo,
        Capability.JumpForward,
        Capability.JumpBackward,
      ],
      forwardJumpInterval: 25,  // seconds
      backwardJumpInterval: 30,  // seconds
      progressUpdateEventInterval: 1,  // seconds - fires PlaybackProgressUpdated
    })

    // Clean up any existing subscriptions before registering new ones
    this.eventSubscriptions.forEach(sub => sub.remove())
    this.eventSubscriptions = []

    // Subscribe to playback events
    this.eventSubscriptions.push(
      TrackPlayer.addEventListener(Event.PlaybackState, (event) => {
        this.notifyStatusChange(event.state)
      })
    )

    this.eventSubscriptions.push(
      TrackPlayer.addEventListener(Event.PlaybackProgressUpdated, async (event) => {
        const { state } = await TrackPlayer.getPlaybackState()
        this.emit('status', {
          status: this.mapState(state),
          position: event.position * 1000,  // Convert to ms
          duration: event.duration * 1000,  // Convert to ms
        })
      })
    )

    this.isSetup = true
  }

  private clearFade(completed: boolean) {
    if (this.fadeTimer) {
      clearInterval(this.fadeTimer)
      this.fadeTimer = null
    }
    if (this.fadeResolve) {
      this.fadeResolve(completed)
      this.fadeResolve = null
    }
  }

  private async notifyStatusChange(state: State): Promise<void> {
    try {
      const progress = await TrackPlayer.getProgress()
      this.emit('status', {
        status: this.mapState(state),
        position: progress.position * 1000,
        duration: this.currentDuration,
      })
    } catch {
      // Player may not be ready yet
    }
  }

  private mapState(state: State): PlayerStatus {
    switch (state) {
      case State.Playing:
        return 'playing'
      case State.Paused:
      case State.Stopped:
      case State.Ready:
      case State.None:
      default:
        return 'paused'
    }
  }
}

