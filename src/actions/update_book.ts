import type { DatabaseService, SyncQueueService } from '../services'
import type { SetState, GetState, Action, ActionFactory } from '../store/types'
import { createLogger } from '../utils'


export interface UpdateBookDeps {
  db: DatabaseService
  syncQueue: SyncQueueService
  set: SetState
  get: GetState
}

export type UpdateBookUpdates = {
  title?: string | null
  artist?: string | null
}

export type UpdateBook = Action<[string, UpdateBookUpdates]>

export const createUpdateBook: ActionFactory<UpdateBookDeps, UpdateBook> = (deps) => (
  async (id, updates) => {
    const { db, syncQueue, set, get } = deps
    const log = createLogger('UpdateBook')

    const { books } = get()
    const book = books[id]
    if (!book) return

    const newTitle = updates.title !== undefined ? updates.title : book.title
    const newArtist = updates.artist !== undefined ? updates.artist : book.artist

    log(`Updating "${book.name}" metadata`)

    db.updateBookMetadata(id, newTitle, newArtist)
    syncQueue.queueChange('book', id, 'upsert')

    set((state) => {
      const book = state.books[id]
      if (!book) return
      book.title = newTitle
      book.artist = newArtist
      book.updated_at = Date.now()
    })
  }
)
