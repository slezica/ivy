import { createTrackSession, TrackSessionDeps } from '../track_session'
import {
  createMockBook, createMockSession, createMockState, createMockGet, createImmerSet,
  createMockDb,
} from './helpers'


// -- Helpers ------------------------------------------------------------------

function createDeps(overrides: {
  hasCurrentSession?: boolean
  bookId?: string
  book?: Parameters<typeof createMockBook>[0]
  session?: Parameters<typeof createMockSession>[0]
  db?: any
} = {}) {
  const { bookId = 'book-1', hasCurrentSession = false } = overrides

  const book = createMockBook({ id: bookId, ...overrides.book })
  const currentSession = hasCurrentSession
    ? createMockSession({ id: 'session-1', book_id: bookId, ...overrides.session })
    : null

  const state = createMockState({
    books: { [bookId]: book },
    sessions: currentSession ? { [currentSession.id]: currentSession } : {},
  })
  const set = createImmerSet(state)

  const deps: TrackSessionDeps = {
    db: overrides.db ?? createMockDb({
      getCurrentSession: jest.fn(() => currentSession),
      createSession: jest.fn(() => createMockSession({ id: 'new-session', book_id: bookId })),
    }),
    set,
    get: createMockGet(state),
  }

  return { state, deps }
}


// -- Tests --------------------------------------------------------------------

describe('createTrackSession', () => {

  describe('existing session (extend)', () => {
    it('updates ended_at in db', async () => {
      const { deps } = createDeps({ hasCurrentSession: true })
      const trackSession = createTrackSession(deps)

      await trackSession('book-1')

      expect(deps.db.updateSessionEndedAt).toHaveBeenCalledWith('session-1', expect.any(Number))
    })

    it('updates ended_at in store', async () => {
      const { state, deps } = createDeps({ hasCurrentSession: true, session: { ended_at: 2000 } })
      const trackSession = createTrackSession(deps)

      await trackSession('book-1')

      expect(state.sessions['session-1'].ended_at).toBeGreaterThan(2000)
    })

    it('does not create a new session', async () => {
      const { deps } = createDeps({ hasCurrentSession: true })
      const trackSession = createTrackSession(deps)

      await trackSession('book-1')

      expect(deps.db.createSession).not.toHaveBeenCalled()
    })
  })

  describe('no existing session (create)', () => {
    it('creates a new session in db', async () => {
      const { deps } = createDeps()
      const trackSession = createTrackSession(deps)

      await trackSession('book-1')

      expect(deps.db.createSession).toHaveBeenCalledWith('book-1')
    })

    it('adds session with book metadata to store', async () => {
      const { state, deps } = createDeps({
        book: { name: 'My Book.mp3', title: 'My Book', artist: 'Author', artwork: 'data:img' },
      })
      const trackSession = createTrackSession(deps)

      await trackSession('book-1')

      const session = state.sessions['new-session']
      expect(session).toBeDefined()
      expect(session.book_name).toBe('My Book.mp3')
      expect(session.book_title).toBe('My Book')
      expect(session.book_artist).toBe('Author')
      expect(session.book_artwork).toBe('data:img')
    })

    it('does nothing if book does not exist', async () => {
      const { deps } = createDeps()
      const trackSession = createTrackSession(deps)

      await trackSession('nonexistent')

      expect(deps.db.createSession).not.toHaveBeenCalled()
    })
  })
})
