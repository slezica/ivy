import { createTrackSession, TrackSessionDeps } from '../../actions/track_session'
import type { Book, Session } from '../../services'

/**
 * Tests for session actions.
 *
 * Bug #3: State inconsistency where db.createSession was called
 * before validating the book exists, leading to orphaned sessions.
 */

describe('createTrackSession', () => {
  // Helper to create a mock book
  function createMockBook(id: string): Book {
    return {
      id,
      uri: `file:///books/${id}.mp3`,
      name: `Book ${id}`,
      duration: 60000,
      position: 0,
      updated_at: 1000,
      title: 'Test Book',
      artist: 'Test Artist',
      artwork: null,
      file_size: 1000000,
      fingerprint: new Uint8Array([1, 2, 3, 4]),
      hidden: false,
    }
  }

  function createMockDeps(storeState: any): TrackSessionDeps {
    return {
      db: {
        getCurrentSession: jest.fn(() => null),
        createSession: jest.fn((bookId: string): Session => ({
          id: `session-${bookId}`,
          book_id: bookId,
          started_at: Date.now(),
          ended_at: Date.now(),
        })),
        updateSessionEndedAt: jest.fn(),
      } as any,
      set: jest.fn((updater: any) => {
        if (typeof updater === 'function') {
          updater(storeState)
        }
      }),
      get: jest.fn(() => storeState),
    }
  }

  it('does not create session for non-existent book', async () => {
    const storeState: any = {
      sessions: [],
      currentSessionBookId: null,
      books: {}, // No books!
    }

    const deps = createMockDeps(storeState)
    const trackSession = createTrackSession(deps)

    await trackSession('nonexistent-book')

    // createSession should NOT have been called
    expect(deps.db.createSession).not.toHaveBeenCalled()
    expect(deps.set).not.toHaveBeenCalled()
  })

  it('creates session when book exists', async () => {
    const book = createMockBook('book-1')
    const storeState: any = {
      sessions: [],
      currentSessionBookId: null,
      books: { 'book-1': book },
    }

    const deps = createMockDeps(storeState)
    const trackSession = createTrackSession(deps)

    await trackSession('book-1')

    // createSession should have been called
    expect(deps.db.createSession).toHaveBeenCalledWith('book-1')
    expect(deps.set).toHaveBeenCalled()
    expect(storeState.sessions.length).toBe(1)
    expect(storeState.sessions[0].book_name).toBe(book.name)
  })

  it('updates existing session instead of creating new one', async () => {
    const book = createMockBook('book-1')

    const existingSession: Session = {
      id: 'session-1',
      book_id: 'book-1',
      started_at: 1000,
      ended_at: 1000,
    }

    const storeState: any = {
      sessions: [{
        ...existingSession,
        book_name: book.name,
        book_title: book.title,
        book_artist: book.artist,
        book_artwork: book.artwork,
      }],
      currentSessionBookId: null,
      books: { 'book-1': book },
    }

    const deps = createMockDeps(storeState)
    deps.db.getCurrentSession = jest.fn(() => existingSession)

    const trackSession = createTrackSession(deps)

    await trackSession('book-1')

    // Should update existing session, not create new
    expect(deps.db.createSession).not.toHaveBeenCalled()
    expect(deps.db.updateSessionEndedAt).toHaveBeenCalledWith('session-1', expect.any(Number))
  })

  it('validates book before creating session (order matters)', async () => {
    const callOrder: string[] = []

    const storeState: any = {
      sessions: [],
      currentSessionBookId: null,
      books: {}, // No book
    }

    const deps = createMockDeps(storeState)

    deps.db.createSession = jest.fn(() => {
      callOrder.push('createSession')
      return {
        id: 'session-1',
        book_id: 'book-1',
        started_at: Date.now(),
        ended_at: Date.now(),
      }
    })

    const trackSession = createTrackSession(deps)

    await trackSession('book-1')

    // createSession should NOT be in the call order (validation failed first)
    expect(callOrder).not.toContain('createSession')
  })
})
