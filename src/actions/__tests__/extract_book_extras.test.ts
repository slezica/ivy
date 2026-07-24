import { createExtractBookExtras, ExtractBookExtrasDeps } from '../extract_book_extras'
import {
  createMockBook, createMockState, createImmerSet, createMockGet,
  createMockDb, createMockFFmetadata, createMockSyncQueue,
} from './helpers'

const TAGS = {
  comment: 'A story.',
  composer: 'A Voice',
  series: 'Saga',
  part: '2',
  date: '2012',
  language: 'English',
}

function createMockDeps(
  state: ReturnType<typeof createMockState>,
  overrides: Partial<ExtractBookExtrasDeps> = {},
): ExtractBookExtrasDeps {
  return {
    db: createMockDb(),
    ffmetadata: createMockFFmetadata({ read: jest.fn(async () => ({ tags: TAGS, chapters: [] })) }),
    syncQueue: createMockSyncQueue(),
    set: createImmerSet(state),
    get: createMockGet(state),
    ...overrides,
  }
}

describe('createExtractBookExtras', () => {
  it('extracts, persists and queues sync for a never-extracted book', async () => {
    const state = createMockState({ books: { 'book-1': createMockBook() } })
    const deps = createMockDeps(state)

    await createExtractBookExtras(deps)('book-1')

    expect(deps.db.setBookExtras).toHaveBeenCalledWith(
      'book-1',
      expect.objectContaining({ summary: 'A story.', narrator: 'A Voice', series: 'Saga' }),
      1,
    )
    expect(deps.syncQueue.queueChange).toHaveBeenCalledWith('book', 'book-1', 'upsert')
  })

  it('updates the store book in place', async () => {
    const state = createMockState({ books: { 'book-1': createMockBook() } })
    const deps = createMockDeps(state)

    await createExtractBookExtras(deps)('book-1')

    const book = state.books['book-1']
    expect(book.summary).toBe('A story.')
    expect(book.narrator).toBe('A Voice')
    expect(book.metadata_version).toBe(1)
  })

  it('skips books already at the current extractor version', async () => {
    const state = createMockState({ books: { 'book-1': createMockBook({ metadata_version: 1 }) } })
    const deps = createMockDeps(state)

    await createExtractBookExtras(deps)('book-1')

    expect(deps.ffmetadata.read).not.toHaveBeenCalled()
    expect(deps.db.setBookExtras).not.toHaveBeenCalled()
  })

  it('skips archived books (no file to read)', async () => {
    const state = createMockState({ books: { 'book-1': createMockBook({ uri: null }) } })
    const deps = createMockDeps(state)

    await createExtractBookExtras(deps)('book-1')

    expect(deps.ffmetadata.read).not.toHaveBeenCalled()
  })

  it('persists nothing on ffmpeg failure, so a later call retries', async () => {
    const state = createMockState({ books: { 'book-1': createMockBook() } })
    const deps = createMockDeps(state, {
      ffmetadata: createMockFFmetadata({ read: jest.fn(async () => ({ tags: null, chapters: [] })) }),
    })

    await createExtractBookExtras(deps)('book-1')

    expect(deps.db.setBookExtras).not.toHaveBeenCalled()
    expect(state.books['book-1'].metadata_version).toBeNull()
  })
})
