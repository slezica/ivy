import type {
  AudioPlayerService,
  DatabaseService,
  PlaybackStatus,
} from '../services'
import type { PlaybackSlice, PlaybackContext, SetState, GetState } from './types'


const SKIP_FORWARD_MS = 25 * 1000
const SKIP_BACKWARD_MS = 30 * 1000


export interface PlaybackSliceDeps {
  audio: AudioPlayerService
  db: DatabaseService
}


export function createPlaybackSlice(deps: PlaybackSliceDeps) {
  const { audio: audioService, db: dbService } = deps

  return (set: SetState, get: GetState): PlaybackSlice => {
    audioService.on('status', onPlaybackStatus)

    return {
      playback: {
        status: 'idle',
        ownerId: null,
        uri: null,
        position: 0,
        duration: 0,
      },

      play,
      pause,
      seek,
      seekClip,
      skipForward,
      skipBackward,
      syncPlaybackState,
    }

    function onPlaybackStatus(status: PlaybackStatus) {
      set((state) => {
        if (state.playback.status !== 'loading') {
          state.playback.status = status.status
        }
        state.playback.position = status.position
      })
    }

    async function play(context?: PlaybackContext): Promise<void> {
      try {
        if (!context) {
          // No new context? Just resume playback:
          set(state => {
            state.playback.status = 'playing'
          })
          await audioService.play()
          return
        }

        const { playback } = get()
        const isSameFile = (playback.uri == context.fileUri)

        if (!isSameFile) {
          const bookRecord = dbService.getBookByAnyUri(context.fileUri) // TODO read from store
          if (!bookRecord) {
            throw new Error(`No book or clip found for: ${context.fileUri}`)
          }

          set(state => {
            state.playback.status = 'loading'
            if (context.ownerId != null) {
              state.playback.ownerId = context.ownerId
            }
          })

          const duration = await audioService.load(context.fileUri, {
            title: bookRecord.title,
            artist: bookRecord.artist,
            artwork: bookRecord.artwork,
          }) // TODO load() should be able to get metadata on its own and return full playback state

          set(state => {
            state.playback.uri = context.fileUri
            state.playback.duration = duration
            state.playback.position = context.position
          })

          await audioService.seek(context.position)

        } else if (playback.position !== context.position) {
          set(state => { state.playback.position = context.position })
          await audioService.seek(context.position)
        }

        set(state => {
          state.playback.status = 'playing'
          if (context.ownerId !== undefined) {
            state.playback.ownerId = context.ownerId
          }
        })

        await audioService.play()

      } catch (error) {
        set(state => {
          state.playback.status = state.playback.uri ? 'paused' : 'idle'
        })

        console.error('Error playing audio:', error)
        throw error
      }
    }

    async function pause(): Promise<void> {
      set(state => {
        state.playback.status = 'paused'
      })

      try {
        await audioService.pause()
      } catch (error) {
        console.error('Error pausing audio:', error)
        throw error
      }
    }

    async function seek(context: PlaybackContext): Promise<void> {
      const { playback } = get()

      // Only seek if the requested file is currently loaded
      if (playback.uri !== context.fileUri) {
        console.log('Seek ignored: file not loaded', context.fileUri)
        return
      }

      set(state => {
        state.playback.position = context.position
      })

      try {
        await audioService.seek(context.position)
      } catch (error) {
        console.error('Error seeking:', error)
        throw error
      }
    }

    async function seekClip(clipId: string): Promise<void> {
      const clip = get().clips[clipId]
      if (!clip) {
        throw new Error('Clip not found')
      }
      if (!clip.file_uri) {
        throw new Error('Cannot seek to clip: source file has been removed')
      }

      // Seek to clip includes loading the file if different
      await play({ fileUri: clip.file_uri, position: clip.start })
    }

    async function skipForward(): Promise<void> {
      try {
        await audioService.skip(SKIP_FORWARD_MS)
      } catch (error) {
        console.error('Error skipping forward:', error)
        throw error
      }
    }

    async function skipBackward(): Promise<void> {
      try {
        await audioService.skip(-SKIP_BACKWARD_MS)
      } catch (error) {
        console.error('Error skipping backward:', error)
        throw error
      }
    }

    async function syncPlaybackState(): Promise<void> {
      const status = await audioService.getStatus()
      if (!status) return

      set(state => {
        if (state.playback.status !== 'loading') {
          state.playback.status = status.status
        }
        state.playback.position = status.position
      })
    }
  }
}
