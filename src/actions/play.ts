import type { AudioPlayerService, DatabaseService } from '../services'
import type { SetState, GetState, Action, ActionFactory } from '../store/types'


export interface PlayContext {
  fileUri: string
  position: number
  ownerId?: string
}

export interface PlayDeps {
  audio: AudioPlayerService
  db: DatabaseService
  set: SetState
  get: GetState
}

export type Play = Action<[PlayContext?]>

export const createPlay: ActionFactory<PlayDeps, Play> = (deps) => (
  async (context?) => {
    const { audio, db, set, get } = deps

    try {
      if (!context) {
        // No new context? Just resume playback:
        set(state => {
          state.playback.status = 'playing'
        })
        await audio.play()
        return
      }

      const { playback } = get()
      const isSameFile = (playback.uri == context.fileUri)

      if (!isSameFile) {
        const bookRecord = db.getBookByAnyUri(context.fileUri) // TODO read from store
        if (!bookRecord) {
          throw new Error(`No book or clip found for: ${context.fileUri}`)
        }

        set(state => {
          state.playback.status = 'loading'
          if (context.ownerId != null) {
            state.playback.ownerId = context.ownerId
          }
        })

        const duration = await audio.load(context.fileUri, {
          title: bookRecord.title,
          artist: bookRecord.artist,
          artwork: bookRecord.artwork,
        }) // TODO load() should be able to get metadata on its own and return full playback state

        set(state => {
          state.playback.uri = context.fileUri
          state.playback.duration = duration
          state.playback.position = context.position
        })

        await audio.seek(context.position)

      } else if (playback.position !== context.position) {
        set(state => { state.playback.position = context.position })
        await audio.seek(context.position)
      }

      set(state => {
        state.playback.status = 'playing'
        if (context.ownerId !== undefined) {
          state.playback.ownerId = context.ownerId
        }
      })

      await audio.play()

    } catch (error) {
      set(state => {
        state.playback.status = state.playback.uri ? 'paused' : 'idle'
      })

      console.error('Error playing audio:', error)
      throw error
    }
  }
)
