import type { DatabaseService, SyncQueueService, BookEditableFields } from '../services'
import type { SetState, GetState, Action, ActionFactory } from '../store/types'
import { createLogger } from '../utils'


export interface UpdateBookDeps {
  db: DatabaseService
  syncQueue: SyncQueueService
  set: SetState
  get: GetState
}

export type UpdateBookUpdates = Partial<BookEditableFields>

export type UpdateBook = Action<[string, UpdateBookUpdates]>

export const createUpdateBook: ActionFactory<UpdateBookDeps, UpdateBook> = (deps) => (
  async (id, updates) => {
    const { db, syncQueue, set, get } = deps
    const log = createLogger('UpdateBook')

    const book = get().books[id]
    if (!book) return

    log(`Updating "${book.name}" metadata`)

    await db.updateBookFields(id, updates)
    await syncQueue.queueChange('book', id, 'upsert')

    set((state) => {
      const book = state.books[id]
      if (!book) return
      Object.assign(book, updates)
      book.updated_at = Date.now()
    })
  }
)
