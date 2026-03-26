import type { AudioPlayerService, DatabaseService } from '../services'
import type { SetState, GetState, Action, ActionFactory } from '../store/types'
import { createLogger, MAIN_PLAYER_OWNER_ID } from '../utils'


export interface LoadBookContext {
  fileUri: string
  position: number
  ownerId: string
}

export interface LoadBookDeps {
  audio: AudioPlayerService
  db: DatabaseService
  set: SetState
  get: GetState
}

export type LoadBook = Action<[LoadBookContext]>

export const createLoadBook: ActionFactory<LoadBookDeps, LoadBook> = (deps) => (
  async (context) => {
    const { audio, db, set, get } = deps
    const log = createLogger('LoadBook')
    const { playback } = get()

    if (playback.status === 'loading') return

    const isSameFile = (playback.uri === context.fileUri)

    if (!isSameFile) {
      const bookRecord = await db.getBookByAnyUri(context.fileUri)
      if (!bookRecord) {
        throw new Error(`No book or clip found for: ${context.fileUri}`)
      }

      log(`Loading "${bookRecord.title || bookRecord.name}" at ${context.position}ms`)

      set(state => {
        state.playback.status = 'loading'
        state.playback.uri = null
        state.playback.ownerId = context.ownerId
      })

      const duration = await audio.load(context.fileUri, {
        title: bookRecord.title,
        artist: bookRecord.artist,
        artwork: bookRecord.artwork,
      })

      set(state => {
        state.playback.uri = context.fileUri
        state.playback.duration = duration
        state.playback.position = context.position
        state.playback.status = 'paused'
        state.playback.ownerId = context.ownerId
      })

      await audio.seek(context.position)

      // Apply per-book speed for main player, 1× for clips
      const rate = context.ownerId === MAIN_PLAYER_OWNER_ID ? bookRecord.speed / 100 : 1
      await audio.setRate(rate)

      log(`Loaded (${duration}ms)`)

    } else if (playback.position !== context.position) {
      log(`Seeking to ${context.position}ms`)

      set(state => {
        state.playback.position = context.position
        state.playback.ownerId = context.ownerId
      })
      await audio.seek(context.position)

    } else {
      set(state => {
        state.playback.ownerId = context.ownerId
      })
    }
  }
)
