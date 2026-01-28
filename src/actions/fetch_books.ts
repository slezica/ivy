import type { DatabaseService, Book } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'


export interface FetchBooksDeps {
  db: DatabaseService
  set: SetState
}

export type FetchBooks = Action<[]>

export const createFetchBooks: ActionFactory<FetchBooksDeps, FetchBooks> = (deps) => (
  async () => {
    const { db, set } = deps

    const books: Record<string, Book> = {}

    for (const book of db.getAllBooks()) {
      books[book.id] = book
    }

    set({ books, library: { status: 'idle' } })
  }
)
