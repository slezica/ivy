import { createSessionSlice, SessionSliceDeps } from '../session'
import type { Book, Session } from '../../services'

/**
 * Tests for the session store slice.
 *
 * Bug #3: State inconsistency where db.createSession was called
 * before validating the book exists, leading to orphaned sessions.
 */

describe('createSessionSlice', () => {
  // Mock dependencies
  function createMockDeps(): SessionSliceDeps {
    return {
      db: {
        getAllSessions: jest.fn(() => []),
        getCurrentSession: jest.fn(() => null),
        createSession: jest.fn((bookId: string): Session => ({
          id: `session-${bookId}`,
          book_id: bookId,
          started_at: Date.now(),
          ended_at: Date.now(),
        })),
        updateSessionEndedAt: jest.fn(),
      } as any,
      audio: {
        on: jest.fn(),
      } as any,
    }
  }

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

  describe('trackSession', () => {
    it('does not create session for non-existent book', () => {
      const deps = createMockDeps()

      const storeState: any = {
        sessions: [],
        currentSessionBookId: null,
        books: {}, // No books!
      }

      const set = jest.fn()
      const get = jest.fn(() => storeState)

      const slice = createSessionSlice(deps)(set, get)

      slice.trackSession('nonexistent-book')

      // createSession should NOT have been called
      expect(deps.db.createSession).not.toHaveBeenCalled()
      expect(set).not.toHaveBeenCalled()
    })

    it('creates session when book exists', () => {
      const deps = createMockDeps()
      const book = createMockBook('book-1')

      const storeState: any = {
        sessions: [],
        currentSessionBookId: null,
        books: { 'book-1': book },
      }

      const set = jest.fn((updater: any) => {
        if (typeof updater === 'function') {
          updater(storeState)
        }
      })
      const get = jest.fn(() => storeState)

      const slice = createSessionSlice(deps)(set, get)

      slice.trackSession('book-1')

      // createSession should have been called
      expect(deps.db.createSession).toHaveBeenCalledWith('book-1')
      expect(set).toHaveBeenCalled()
      expect(storeState.sessions.length).toBe(1)
      expect(storeState.sessions[0].book_name).toBe(book.name)
    })

    it('updates existing session instead of creating new one', () => {
      const deps = createMockDeps()
      const book = createMockBook('book-1')

      const existingSession: Session = {
        id: 'session-1',
        book_id: 'book-1',
        started_at: 1000,
        ended_at: 1000,
      }

      deps.db.getCurrentSession = jest.fn(() => existingSession)

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

      const set = jest.fn((updater: any) => {
        if (typeof updater === 'function') {
          updater(storeState)
        }
      })
      const get = jest.fn(() => storeState)

      const slice = createSessionSlice(deps)(set, get)

      slice.trackSession('book-1')

      // Should update existing session, not create new
      expect(deps.db.createSession).not.toHaveBeenCalled()
      expect(deps.db.updateSessionEndedAt).toHaveBeenCalledWith('session-1', expect.any(Number))
    })

    it('validates book before creating session (order matters)', () => {
      const deps = createMockDeps()

      const callOrder: string[] = []

      // Track call order
      const originalGet = jest.fn((): any => ({
        sessions: [],
        currentSessionBookId: null,
        books: {}, // No book
      }))

      deps.db.createSession = jest.fn(() => {
        callOrder.push('createSession')
        return {
          id: 'session-1',
          book_id: 'book-1',
          started_at: Date.now(),
          ended_at: Date.now(),
        }
      })

      const set = jest.fn()

      const slice = createSessionSlice(deps)(set, originalGet)

      slice.trackSession('book-1')

      // createSession should NOT be in the call order (validation failed first)
      expect(callOrder).not.toContain('createSession')
    })
  })
})
