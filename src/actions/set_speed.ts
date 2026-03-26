import type { AudioPlayerService, DatabaseService, SyncQueueService } from '../services'
import type { SetState, GetState, Action, ActionFactory } from '../store/types'
import { MAIN_PLAYER_OWNER_ID } from '../utils'


export interface SetSpeedDeps {
  audio: AudioPlayerService
  db: DatabaseService
  syncQueue: SyncQueueService
  set: SetState
  get: GetState
}

export type SetSpeed = Action<[string, number]>

export const createSetSpeed: ActionFactory<SetSpeedDeps, SetSpeed> = (deps) => (
  async (bookId, speed) => {
    const { audio, db, syncQueue, set, get } = deps

    await db.updateBookSpeed(bookId, speed)
    await syncQueue.queueChange('book', bookId, 'upsert')

    set((state) => {
      const book = state.books[bookId]
      if (book) {
        book.speed = speed
        book.updated_at = Date.now()
      }
    })

    // Apply rate immediately if this book is currently playing in the main player
    const { playback, books } = get()
    const book = books[bookId]
    if (book?.uri && playback.uri === book.uri && playback.ownerId === MAIN_PLAYER_OWNER_ID) {
      await audio.setRate(speed / 100)
    }
  }
)
