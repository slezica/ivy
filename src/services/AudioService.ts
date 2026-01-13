import { createAudioPlayer, setAudioModeAsync } from 'expo-audio'
import type { AudioPlayer } from 'expo-audio'

type PlayerStatus = 'loading' | 'paused' | 'playing'

export interface PlaybackStatus {
  status: PlayerStatus
  position: number
  duration: number
}

export interface AudioServiceListeners {
  onPlaybackStatusChange?: (status: PlaybackStatus) => void
}

export class AudioService {
  private player: AudioPlayer | null = null
  private listeners: AudioServiceListeners
  private statusInterval: ReturnType<typeof setInterval> | null = null
  private currentDuration: number = 0

  constructor(listeners: AudioServiceListeners = {}) {
    this.listeners = listeners
    this.initializeAudioMode()
  }

  private async initializeAudioMode(): Promise<void> {
    try {
      await setAudioModeAsync({
        playsInSilentMode: true,
        shouldPlayInBackground: true,
      })
    } catch (error) {
      console.error('Failed to set audio mode:', error)
    }
  }

  async load(uri: string): Promise<number> {
    await this.unload()

    this.player = createAudioPlayer(uri)

    // Start polling for status updates
    this.startStatusPolling()

    // Wait for player to be ready and get duration
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Failed to load audio file: timeout after 10 seconds'))
      }, 10000) // 10 second timeout

      const checkDuration = () => {
        if (!this.player) {
          clearTimeout(timeout)
          reject(new Error('Player was unloaded during loading'))
          return
        }

        if (this.player.duration > 0) {
          clearTimeout(timeout)
          this.currentDuration = this.player.duration * 1000 // Convert to milliseconds
          resolve(this.currentDuration)
        } else {
          setTimeout(checkDuration, 100)
        }
      }
      checkDuration()
    })
  }

  private startStatusPolling(): void {
    if (this.statusInterval) {
      clearInterval(this.statusInterval)
    }

    this.statusInterval = setInterval(() => {
      if (this.player && this.listeners.onPlaybackStatusChange) {
        this.listeners.onPlaybackStatusChange({
          status: this.player.playing ? 'playing' : 'paused',
          position: this.player.currentTime * 1000, // Convert to milliseconds
          duration: this.currentDuration,
        })
      }
    }, 100) // Update every 100ms
  }

  private stopStatusPolling(): void {
    if (this.statusInterval) {
      clearInterval(this.statusInterval)
      this.statusInterval = null
    }
  }

  async play(): Promise<void> {
    if (!this.player) {
      throw new Error('No audio loaded')
    }

    this.player.play()
  }

  async pause(): Promise<void> {
    if (!this.player) {
      throw new Error('No audio loaded')
    }

    this.player.pause()
  }

  async seek(positionMillis: number): Promise<void> {
    if (!this.player) {
      throw new Error('No audio loaded')
    }

    this.player.seekTo(positionMillis / 1000) // Convert to seconds
  }

  async skip(offsetMillis: number): Promise<void> {
    if (!this.player) {
      throw new Error('No audio loaded')
    }

    const currentPosition = this.player.currentTime * 1000
    const newPosition = Math.max(0, currentPosition + offsetMillis)
    this.player.seekTo(newPosition / 1000) // Convert to seconds
  }

  async getStatus(): Promise<PlaybackStatus | null> {
    if (!this.player) {
      return null
    }

    return {
      status: this.player.playing ? 'playing' : 'paused',
      position: this.player.currentTime * 1000,
      duration: this.currentDuration,
    }
  }

  async unload(): Promise<void> {
    this.stopStatusPolling()

    if (this.player) {
      // Stop playback before removing player
      if (this.player.playing) {
        this.player.pause()
      }
      this.player.remove()
      this.player = null
    }

    this.currentDuration = 0
  }
}
