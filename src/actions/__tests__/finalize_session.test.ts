import { createFinalizeSession, FinalizeSessionDeps } from '../finalize_session'
import { MIN_SESSION_DURATION_MS } from '../constants'
import {
  createMockSession, createMockState, createImmerSet,
  createMockDb,
} from './helpers'


// -- Helpers ------------------------------------------------------------------

function createDeps(overrides: {
  startedAt?: number,
  now?: number,
  hasSession?: boolean,
} = {}) {
  const {
    startedAt = 1000,
    now = startedAt + MIN_SESSION_DURATION_MS + 1, // long enough by default
    hasSession = true,
  } = overrides

  const sessionId = 'session-1'
  const bookId = 'book-1'

  const session = createMockSession({ id: sessionId, book_id: bookId, started_at: startedAt })
  const state = createMockState({
    sessions: hasSession ? { [sessionId]: session } : {},
  })

  const db = createMockDb({
    getCurrentSession: jest.fn(() => hasSession ? { id: sessionId, book_id: bookId, started_at: startedAt, ended_at: 0 } : null),
  })

  jest.spyOn(Date, 'now').mockReturnValue(now)

  const deps: FinalizeSessionDeps = {
    db,
    set: createImmerSet(state),
  }

  return { state, deps, db, sessionId, bookId }
}

afterEach(() => {
  jest.restoreAllMocks()
})


// -- Tests --------------------------------------------------------------------

describe('createFinalizeSession', () => {

  describe('no current session', () => {
    it('does nothing if there is no current session', async () => {
      const { deps, db } = createDeps({ hasSession: false })
      const finalizeSession = createFinalizeSession(deps)

      await finalizeSession('book-1')

      expect(db.deleteSession).not.toHaveBeenCalled()
      expect(db.updateSessionEndedAt).not.toHaveBeenCalled()
      expect(deps.set).not.toHaveBeenCalled()
    })
  })

  describe('short session (below threshold)', () => {
    const shortSessionOpts = { startedAt: 1000, now: 1000 + MIN_SESSION_DURATION_MS - 1 }

    it('deletes the session from the database', async () => {
      const { deps, db, sessionId } = createDeps(shortSessionOpts)
      const finalizeSession = createFinalizeSession(deps)

      await finalizeSession('book-1')

      expect(db.deleteSession).toHaveBeenCalledWith(sessionId)
    })

    it('removes the session from state', async () => {
      const { state, deps, sessionId } = createDeps(shortSessionOpts)
      const finalizeSession = createFinalizeSession(deps)

      await finalizeSession('book-1')

      expect(state.sessions[sessionId]).toBeUndefined()
    })

    it('does not update ended_at', async () => {
      const { deps, db } = createDeps(shortSessionOpts)
      const finalizeSession = createFinalizeSession(deps)

      await finalizeSession('book-1')

      expect(db.updateSessionEndedAt).not.toHaveBeenCalled()
    })
  })

  describe('long enough session (at or above threshold)', () => {
    const longSessionOpts = { startedAt: 1000, now: 1000 + MIN_SESSION_DURATION_MS }

    it('updates ended_at in the database', async () => {
      const { deps, db, sessionId } = createDeps(longSessionOpts)
      const finalizeSession = createFinalizeSession(deps)

      await finalizeSession('book-1')

      expect(db.updateSessionEndedAt).toHaveBeenCalledWith(sessionId, longSessionOpts.now)
    })

    it('updates ended_at in state', async () => {
      const { state, deps, sessionId } = createDeps(longSessionOpts)
      const finalizeSession = createFinalizeSession(deps)

      await finalizeSession('book-1')

      expect(state.sessions[sessionId].ended_at).toBe(longSessionOpts.now)
    })

    it('does not delete the session', async () => {
      const { deps, db } = createDeps(longSessionOpts)
      const finalizeSession = createFinalizeSession(deps)

      await finalizeSession('book-1')

      expect(db.deleteSession).not.toHaveBeenCalled()
    })
  })

  describe('threshold boundary', () => {
    it('deletes session at duration = MIN_SESSION_DURATION_MS - 1', async () => {
      const { deps, db } = createDeps({ startedAt: 0, now: MIN_SESSION_DURATION_MS - 1 })
      const finalizeSession = createFinalizeSession(deps)

      await finalizeSession('book-1')

      expect(db.deleteSession).toHaveBeenCalled()
      expect(db.updateSessionEndedAt).not.toHaveBeenCalled()
    })

    it('keeps session at duration = MIN_SESSION_DURATION_MS exactly', async () => {
      const { deps, db } = createDeps({ startedAt: 0, now: MIN_SESSION_DURATION_MS })
      const finalizeSession = createFinalizeSession(deps)

      await finalizeSession('book-1')

      expect(db.deleteSession).not.toHaveBeenCalled()
      expect(db.updateSessionEndedAt).toHaveBeenCalled()
    })
  })

  describe('state resilience', () => {
    it('handles missing session in state gracefully during update', async () => {
      const { deps, db } = createDeps({ startedAt: 0, now: MIN_SESSION_DURATION_MS + 1000 })
      // Remove session from state but keep it in DB
      const state = createMockState({ sessions: {} })
      deps.set = createImmerSet(state)

      const finalizeSession = createFinalizeSession(deps)

      // Should not throw — the action guards with `if (session)`
      await finalizeSession('book-1')

      expect(db.updateSessionEndedAt).toHaveBeenCalled()
    })
  })
})
