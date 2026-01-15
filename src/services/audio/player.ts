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

// =============================================================================
// Public Interface
// =============================================================================

export type PlayerStatus = 'adding' | 'loading' | 'paused' | 'playing'

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

export interface AudioPlayerListeners {
  onPlaybackStatusChange?: (status: PlaybackStatus) => void
}

// =============================================================================
// Service
// =============================================================================

export class AudioPlayerService {
  private listeners: AudioPlayerListeners
  private isSetup = false
  private currentDuration: number = 0

  constructor(listeners: AudioPlayerListeners = {}) {
    this.listeners = listeners
  }

  async load(uri: string, metadata?: TrackMetadata): Promise<number> {
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
      const timeout = setTimeout(() => {
        reject(new Error('Failed to load audio file: timeout after 10 seconds'))
      }, 10000)

      const checkDuration = async () => {
        try {
          const progress = await TrackPlayer.getProgress()
          if (progress.duration > 0) {
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

    await TrackPlayer.setupPlayer({
      autoHandleInterruptions: true,
    })

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

    // Subscribe to playback events
    TrackPlayer.addEventListener(Event.PlaybackState, (event) => {
      this.notifyStatusChange(event.state)
    })

    TrackPlayer.addEventListener(Event.PlaybackProgressUpdated, async (event) => {
      if (this.listeners.onPlaybackStatusChange) {
        const { state } = await TrackPlayer.getPlaybackState()
        this.listeners.onPlaybackStatusChange({
          status: this.mapState(state),
          position: event.position * 1000,  // Convert to ms
          duration: event.duration * 1000,  // Convert to ms
        })
      }
    })

    this.isSetup = true
  }

  private async notifyStatusChange(state: State): Promise<void> {
    if (!this.listeners.onPlaybackStatusChange) return

    try {
      const progress = await TrackPlayer.getProgress()
      this.listeners.onPlaybackStatusChange({
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

// =============================================================================
// Singleton (for simple use cases without custom listeners)
// =============================================================================

export const audioPlayerService = new AudioPlayerService()
