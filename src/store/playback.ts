/**
 * Playback Slice
 *
 * State and actions for audio playback control.
 */

import type {
  AudioPlayerService,
  DatabaseService,
} from '../services'
import type { PlaybackSlice, PlaybackContext, SetState, GetState } from './types'

// =============================================================================
// Constants
// =============================================================================

const SKIP_FORWARD_MS = 25 * 1000
const SKIP_BACKWARD_MS = 30 * 1000

// =============================================================================
// Types
// =============================================================================

/** Dependencies required by this slice */
export interface PlaybackSliceDeps {
  audio: AudioPlayerService
  db: DatabaseService
}

// =============================================================================
// Slice Creator
// =============================================================================

export function createPlaybackSlice(deps: PlaybackSliceDeps) {
  const { audio: audioService, db: dbService } = deps

  return (set: SetState, get: GetState): PlaybackSlice => {
    // -----------------------------------------------------------------
    // Actions
    // -----------------------------------------------------------------

    async function play(context?: PlaybackContext): Promise<void> {
      try {
        // If context provided, may need to load file and seek first
        if (context) {
          const { playback } = get()
          const isFileSame = playback.uri === context.fileUri

          if (!isFileSame) {
            // Need to load a different file (could be book or clip audio)
            const bookRecord = dbService.getBookByAnyUri(context.fileUri)
            if (!bookRecord) {
              throw new Error(`No book or clip found for: ${context.fileUri}`)
            }

            set((state) => {
              state.playback.status = 'loading'
              if (context.ownerId !== undefined) {
                state.playback.ownerId = context.ownerId
              }
            })

            const duration = await audioService.load(context.fileUri, {
              title: bookRecord.title,
              artist: bookRecord.artist,
              artwork: bookRecord.artwork,
            })

            set((state) => {
              state.playback.uri = context.fileUri
              state.playback.duration = duration
              state.playback.position = context.position
            })

            await audioService.seek(context.position)
          } else if (playback.position !== context.position) {
            // Same file, different position - just seek
            await audioService.seek(context.position)
            set((state) => {
              state.playback.position = context.position
            })
          }

          // Set status to playing, and owner if provided
          set((state) => {
            state.playback.status = 'playing'
            if (context.ownerId !== undefined) {
              state.playback.ownerId = context.ownerId
            }
          })
        } else {
          // No context - just resume, keep existing owner
          set((state) => {
            state.playback.status = 'playing'
          })
        }

        await audioService.play()
      } catch (error) {
        console.error('Error playing audio:', error)
        set((state) => {
          state.playback.status = state.playback.uri ? 'paused' : 'idle'
        })
        throw error
      }
    }

    async function pause(): Promise<void> {
      set((state) => {
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

      set((state) => {
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

      set((state) => {
        if (state.playback.status !== 'loading') {
          state.playback.status = status.status
        }
        state.playback.position = status.position
      })
    }

    // -----------------------------------------------------------------
    // Return slice
    // -----------------------------------------------------------------

    return {
      // Initial state
      playback: {
        status: 'idle',
        position: 0,
        uri: null,
        duration: 0,
        ownerId: null,
      },

      // Actions
      play,
      pause,
      seek,
      seekClip,
      skipForward,
      skipBackward,
      syncPlaybackState,
    }
  }
}
