import { createUpdateBook, UpdateBookDeps } from '../update_book'
import {
  createMockBook, createMockState, createImmerSet, createMockGet,
  createMockDb, createMockSyncQueue,
} from './helpers'

function createMockDeps(
  state: ReturnType<typeof createMockState>,
  overrides: Partial<UpdateBookDeps> = {},
): UpdateBookDeps {
  return {
    db: createMockDb(),
    syncQueue: createMockSyncQueue(),
    set: createImmerSet(state),
    get: createMockGet(state),
    ...overrides,
  }
}

describe('createUpdateBook', () => {
  it('persists the given fields, updates the store and queues sync', async () => {
    const state = createMockState({ books: { 'book-1': createMockBook({ title: 'Old' }) } })
    const deps = createMockDeps(state)

    await createUpdateBook(deps)('book-1', { title: 'New', narrator: 'A Voice' })

    expect(deps.db.updateBookFields).toHaveBeenCalledWith('book-1', { title: 'New', narrator: 'A Voice' })
    expect(deps.syncQueue.queueChange).toHaveBeenCalledWith('book', 'book-1', 'upsert')
    expect(state.books['book-1'].title).toBe('New')
    expect(state.books['book-1'].narrator).toBe('A Voice')
  })

  it('leaves fields not present in the updates untouched', async () => {
    const state = createMockState({
      books: { 'book-1': createMockBook({ title: 'Kept', summary: 'Kept too' }) },
    })
    const deps = createMockDeps(state)

    await createUpdateBook(deps)('book-1', { narrator: '' })

    expect(state.books['book-1'].title).toBe('Kept')
    expect(state.books['book-1'].summary).toBe('Kept too')
    expect(state.books['book-1'].narrator).toBe('')
  })

  it('does nothing for an unknown book', async () => {
    const state = createMockState()
    const deps = createMockDeps(state)

    await createUpdateBook(deps)('missing', { title: 'New' })

    expect(deps.db.updateBookFields).not.toHaveBeenCalled()
    expect(deps.syncQueue.queueChange).not.toHaveBeenCalled()
  })
})
