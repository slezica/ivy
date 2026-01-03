import { Audio, AVPlaybackStatus } from 'expo-av'

export interface PlaybackStatus {
  isPlaying: boolean
  position: number
  duration: number
}

export interface AudioServiceListeners {
  onPlaybackStatusChange?: (status: PlaybackStatus) => void
}

export class AudioService {
  private sound: Audio.Sound | null = null
  private listeners: AudioServiceListeners

  constructor(listeners: AudioServiceListeners = {}) {
    this.listeners = listeners
  }

  async load(uri: string): Promise<number> {
    await this.unload()

    const { sound } = await Audio.Sound.createAsync(
      { uri },
      { shouldPlay: false },
      this.handlePlaybackStatusUpdate
    )

    this.sound = sound

    const status = await sound.getStatusAsync()
    if (status.isLoaded) {
      return status.durationMillis || 0
    }

    return 0
  }

  async play(): Promise<void> {
    if (!this.sound) {
      throw new Error('No audio loaded')
    }

    await this.sound.playAsync()
  }

  async pause(): Promise<void> {
    if (!this.sound) {
      throw new Error('No audio loaded')
    }

    await this.sound.pauseAsync()
  }

  async seek(positionMillis: number): Promise<void> {
    if (!this.sound) {
      throw new Error('No audio loaded')
    }

    await this.sound.setPositionAsync(positionMillis)
  }

  async skip(offsetMillis: number): Promise<void> {
    if (!this.sound) {
      throw new Error('No audio loaded')
    }

    const status = await this.sound.getStatusAsync()
    if (status.isLoaded) {
      const newPosition = Math.max(0, status.positionMillis + offsetMillis)
      await this.sound.setPositionAsync(newPosition)
    }
  }

  async getStatus(): Promise<PlaybackStatus | null> {
    if (!this.sound) {
      return null
    }

    const status = await this.sound.getStatusAsync()
    if (status.isLoaded) {
      return {
        isPlaying: status.isPlaying,
        position: status.positionMillis,
        duration: status.durationMillis || 0,
      }
    }

    return null
  }

  async unload(): Promise<void> {
    if (this.sound) {
      await this.sound.unloadAsync()
      this.sound = null
    }
  }

  private handlePlaybackStatusUpdate = (status: AVPlaybackStatus): void => {
    if (status.isLoaded && this.listeners.onPlaybackStatusChange) {
      this.listeners.onPlaybackStatusChange({
        isPlaying: status.isPlaying,
        position: status.positionMillis,
        duration: status.durationMillis || 0,
      })
    }
  }
}
