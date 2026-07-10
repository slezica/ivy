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

    // Apply per-book speed for main player, 1× for clips
    const applyRate = async (bookRecord?: { speed: number } | null) => {
      let rate = 1
      if (context.ownerId === MAIN_PLAYER_OWNER_ID) {
        const record = bookRecord ?? await db.getBookByAnyUri(context.fileUri)
        if (record) rate = record.speed / 100
      }
      await audio.setRate(rate)
    }

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

      let duration: number
      try {
        duration = await audio.load(context.fileUri, {
          title: bookRecord.title,
          artist: bookRecord.artist,
          artwork: bookRecord.artwork,
        })
      } catch (error) {
        // Nothing is loaded — reset so the loading guard doesn't block forever
        set(state => {
          state.playback.status = 'idle'
          state.playback.uri = null
        })
        throw error
      }

      set(state => {
        state.playback.uri = context.fileUri
        state.playback.duration = duration
        state.playback.position = context.position
        state.playback.status = 'paused'
        state.playback.ownerId = context.ownerId
      })

      await audio.seek(context.position)
      await applyRate(bookRecord)

      log(`Loaded (${duration}ms)`)

    } else if (playback.position !== context.position) {
      log(`Seeking to ${context.position}ms`)

      set(state => {
        state.playback.position = context.position
        state.playback.ownerId = context.ownerId
      })
      await audio.seek(context.position)
      await applyRate()

    } else {
      set(state => {
        state.playback.ownerId = context.ownerId
      })
      await applyRate()
    }
  }
)
