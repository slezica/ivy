import { createTrackSession, TrackSessionDeps } from '../../actions/track_session'
import type { Book, Session } from '../../services'
import * as services from '../../services'
import { MAIN_PLAYER_OWNER_ID } from '../../utils'
import { useStore } from '../index'

/**
 * Tests for session actions and the store's onAudioStatus session lifecycle.
 *
 * Bug #3: State inconsistency where db.createSession was called
 * before validating the book exists, leading to orphaned sessions.
 */

// Mock the service singletons so importing the store doesn't touch native
// modules. Only what the store accesses at creation time (plus the db methods
// exercised by onAudioStatus) needs to exist.
jest.mock('../../services', () => {
  const listener = () => ({ on: jest.fn(), off: jest.fn() })
  return {
    db: {
      // Store creation
      getSettings: jest.fn(() => ({ sync_enabled: false, transcription_enabled: false })),
      getLastSyncTime: jest.fn(() => null),
      queueChange: jest.fn(async () => {}),
      getQueueCount: jest.fn(async () => 0),
      // Position persistence + session tracking
      updateBookPosition: jest.fn(),
      getCurrentSession: jest.fn(async () => null),
      createSession: jest.fn(async (bookId: string) => ({
        id: `session-${bookId}`, book_id: bookId,
        started_at: Date.now(), ended_at: Date.now(), updated_at: Date.now(), updated_by: null,
      })),
      updateSessionEndedAt: jest.fn(),
      deleteSession: jest.fn(async () => {}),
    },
    files: {},
    audio: listener(),
    sync: listener(),
    transcription: listener(),
  }
})

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
      updated_by: null,
      chapters: null,
      speed: 100,
    }
  }

  function createMockDeps(storeState: any): TrackSessionDeps {
    return {
      db: {
        getCurrentSession: jest.fn(async () => null),
        createSession: jest.fn(async (bookId: string): Promise<Session> => ({
          id: `session-${bookId}`,
          book_id: bookId,
          started_at: Date.now(),
          ended_at: Date.now(),
          updated_at: Date.now(),
          updated_by: null,
        })),
        updateSessionEndedAt: jest.fn(),
      } as any,
      syncQueue: {
        queueChange: jest.fn(async () => {}),
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
      sessions: {},
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
      sessions: {},
      currentSessionBookId: null,
      books: { 'book-1': book },
    }

    const deps = createMockDeps(storeState)
    const trackSession = createTrackSession(deps)

    await trackSession('book-1')

    // createSession should have been called
    expect(deps.db.createSession).toHaveBeenCalledWith('book-1')
    expect(deps.set).toHaveBeenCalled()
    const sessionValues = Object.values(storeState.sessions)
    expect(sessionValues.length).toBe(1)
    expect((sessionValues[0] as any).book_name).toBe(book.name)
  })

  it('updates existing session instead of creating new one', async () => {
    const book = createMockBook('book-1')

    const existingSession: Session = {
      id: 'session-1',
      book_id: 'book-1',
      started_at: 1000,
      ended_at: 1000,
      updated_at: 1000,
      updated_by: null,
    }

    const storeState: any = {
      sessions: {
        'session-1': {
          ...existingSession,
          book_name: book.name,
          book_title: book.title,
          book_artist: book.artist,
          book_artwork: book.artwork,
        },
      },
      currentSessionBookId: null,
      books: { 'book-1': book },
    }

    const deps = createMockDeps(storeState)
    deps.db.getCurrentSession = jest.fn(async () => existingSession)

    const trackSession = createTrackSession(deps)

    await trackSession('book-1')

    // Should update existing session, not create new
    expect(deps.db.createSession).not.toHaveBeenCalled()
    expect(deps.db.updateSessionEndedAt).toHaveBeenCalledWith('session-1', expect.any(Number))
  })

  it('validates book before creating session (order matters)', async () => {
    const callOrder: string[] = []

    const storeState: any = {
      sessions: {},
      currentSessionBookId: null,
      books: {}, // No book
    }

    const deps = createMockDeps(storeState)

    deps.db.createSession = jest.fn(async () => {
      callOrder.push('createSession')
      return {
        id: 'session-1',
        book_id: 'book-1',
        started_at: Date.now(),
        ended_at: Date.now(),
        updated_at: Date.now(),
        updated_by: null,
      }
    })

    const trackSession = createTrackSession(deps)

    await trackSession('book-1')

    // createSession should NOT be in the call order (validation failed first)
    expect(callOrder).not.toContain('createSession')
  })
})

describe('onAudioStatus session lifecycle (store)', () => {
  const mockDb = services.db as jest.Mocked<any>

  // The handler the store registered on the (mocked) audio service at creation
  const onAudioStatus = (services.audio.on as jest.Mock).mock.calls
    .find(([event]) => event === 'status')![1] as (status: any) => void

  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  let uidCounter = 0
  const uid = () => `book-${++uidCounter}`

  function makeBook(id: string): Book {
    return {
      id,
      uri: `file:///books/${id}.mp3`,
      name: `Book ${id}`,
      duration: 60000,
      position: 0,
      updated_at: 1000,
      updated_by: null,
      title: null,
      artist: null,
      artwork: null,
      file_size: 1000,
      fingerprint: new Uint8Array([1, 2, 3, 4]),
      hidden: false,
      chapters: null,
      speed: 100,
    }
  }

  function makeSession(bookId: string, startedAgoMs: number): Session {
    const now = Date.now()
    return {
      id: `sess-${bookId}`,
      book_id: bookId,
      started_at: now - startedAgoMs,
      ended_at: now,
      updated_at: now,
      updated_by: null,
    }
  }

  function stage(opts: {
    books: Book[]
    currentSessionBookId?: string | null
    uri?: string | null
    ownerId?: string | null
  }) {
    useStore.setState({
      books: Object.fromEntries(opts.books.map(b => [b.id, b])),
      sessions: {},
      currentSessionBookId: opts.currentSessionBookId ?? null,
      playback: {
        status: 'paused',
        position: 0,
        uri: opts.uri ?? null,
        duration: 60000,
        ownerId: opts.ownerId ?? null,
      },
    })
  }

  beforeEach(() => {
    for (const fn of Object.values(mockDb)) (fn as jest.Mock).mockClear()
    mockDb.getCurrentSession.mockImplementation(async () => null)
  })

  it('finalizes the previous session when the book changes while playing', async () => {
    const bookA = makeBook(uid())
    const bookB = makeBook(uid())
    const sessionA = makeSession(bookA.id, 60_000)
    mockDb.getCurrentSession.mockImplementation(async (bookId: string) => (
      bookId === bookA.id ? sessionA : null
    ))

    stage({ books: [bookA, bookB], currentSessionBookId: bookA.id, uri: bookB.uri, ownerId: MAIN_PLAYER_OWNER_ID })
    onAudioStatus({ status: 'playing', position: 1000, duration: 60000 })
    await flush()

    expect(mockDb.updateSessionEndedAt).toHaveBeenCalledWith(sessionA.id, expect.any(Number))
    expect(mockDb.createSession).toHaveBeenCalledWith(bookB.id)
    expect(useStore.getState().currentSessionBookId).toBe(bookB.id)
  })

  it('deletes a sub-second session on book switch', async () => {
    const bookA = makeBook(uid())
    const bookB = makeBook(uid())
    const sessionA = makeSession(bookA.id, 200) // below MIN_SESSION_DURATION_MS
    mockDb.getCurrentSession.mockImplementation(async (bookId: string) => (
      bookId === bookA.id ? sessionA : null
    ))

    stage({ books: [bookA, bookB], currentSessionBookId: bookA.id, uri: bookB.uri, ownerId: MAIN_PLAYER_OWNER_ID })
    onAudioStatus({ status: 'playing', position: 1000, duration: 60000 })
    await flush()

    expect(mockDb.deleteSession).toHaveBeenCalledWith(sessionA.id)
    expect(mockDb.queueChange).toHaveBeenCalledWith('session', sessionA.id, 'delete')
  })

  it('finalizes the session when a clip player takes ownership', async () => {
    const bookA = makeBook(uid())
    const sessionA = makeSession(bookA.id, 60_000)
    mockDb.getCurrentSession.mockImplementation(async () => sessionA)

    stage({ books: [bookA], currentSessionBookId: bookA.id, uri: 'file:///clips/clip-1.m4a', ownerId: 'clip-viewer' })
    onAudioStatus({ status: 'playing', position: 0, duration: 5000 })
    await flush()

    expect(mockDb.updateSessionEndedAt).toHaveBeenCalledWith(sessionA.id, expect.any(Number))
    expect(mockDb.createSession).not.toHaveBeenCalled()
    expect(mockDb.updateBookPosition).not.toHaveBeenCalled()
    expect(useStore.getState().currentSessionBookId).toBeNull()
  })

  it('finalizes the session when playback.uri is nulled during a transition', async () => {
    const bookA = makeBook(uid())
    const sessionA = makeSession(bookA.id, 60_000)
    mockDb.getCurrentSession.mockImplementation(async () => sessionA)

    stage({ books: [bookA], currentSessionBookId: bookA.id, uri: null, ownerId: MAIN_PLAYER_OWNER_ID })
    onAudioStatus({ status: 'playing', position: 0, duration: 0 })
    await flush()

    expect(mockDb.updateSessionEndedAt).toHaveBeenCalledWith(sessionA.id, expect.any(Number))
    expect(useStore.getState().currentSessionBookId).toBeNull()
  })

  it('still finalizes the session on a plain pause', async () => {
    const bookA = makeBook(uid())
    const sessionA = makeSession(bookA.id, 60_000)
    mockDb.getCurrentSession.mockImplementation(async () => sessionA)

    stage({ books: [bookA], currentSessionBookId: bookA.id, uri: bookA.uri, ownerId: MAIN_PLAYER_OWNER_ID })
    onAudioStatus({ status: 'paused', position: 5000, duration: 60000 })
    await flush()

    expect(mockDb.updateSessionEndedAt).toHaveBeenCalledWith(sessionA.id, expect.any(Number))
    expect(mockDb.updateBookPosition).toHaveBeenCalledWith(bookA.id, 5000)
    expect(useStore.getState().currentSessionBookId).toBeNull()
  })

  it('does not finalize while the same book keeps playing', async () => {
    const bookA = makeBook(uid())
    const sessionA = makeSession(bookA.id, 60_000)
    mockDb.getCurrentSession.mockImplementation(async () => sessionA)

    stage({ books: [bookA], currentSessionBookId: bookA.id, uri: bookA.uri, ownerId: MAIN_PLAYER_OWNER_ID })
    onAudioStatus({ status: 'playing', position: 1000, duration: 60000 })
    await flush()

    // Only trackSession read the current session — no finalize ran
    expect(mockDb.getCurrentSession).toHaveBeenCalledTimes(1)
    expect(mockDb.deleteSession).not.toHaveBeenCalled()
    expect(useStore.getState().currentSessionBookId).toBe(bookA.id)
  })

  it('serializes a finalize behind an in-flight track', async () => {
    const bookA = makeBook(uid())
    const order: string[] = []

    let releaseTrackRead!: (session: Session | null) => void
    mockDb.getCurrentSession
      .mockImplementationOnce(() => {
        order.push('track:read')
        return new Promise((resolve) => { releaseTrackRead = resolve })
      })
      .mockImplementation(async () => {
        order.push('finalize:read')
        return null
      })
    mockDb.createSession.mockImplementationOnce(async (bookId: string) => {
      order.push('track:create')
      return {
        id: `session-${bookId}`, book_id: bookId,
        started_at: Date.now(), ended_at: Date.now(), updated_at: Date.now(), updated_by: null,
      }
    })

    stage({ books: [bookA], currentSessionBookId: null, uri: bookA.uri, ownerId: MAIN_PLAYER_OWNER_ID })
    onAudioStatus({ status: 'playing', position: 1000, duration: 60000 }) // track starts, read blocked
    onAudioStatus({ status: 'paused', position: 1500, duration: 60000 })  // finalize lands mid-track
    await flush()

    // Finalize must not start while track's read-then-write is in flight
    expect(order).toEqual(['track:read'])

    releaseTrackRead(null)
    await flush()

    expect(order).toEqual(['track:read', 'track:create', 'finalize:read'])
  })

  it('queues position sync immediately when the book changes', async () => {
    const bookA = makeBook(uid())
    const bookB = makeBook(uid())

    stage({ books: [bookA, bookB], uri: bookA.uri, ownerId: MAIN_PLAYER_OWNER_ID })
    onAudioStatus({ status: 'playing', position: 1000, duration: 60000 })

    // Switch books well inside the 30s throttle window — the new book's
    // first position sync must not be suppressed by the old book's
    useStore.setState((state) => { state.playback.uri = bookB.uri })
    onAudioStatus({ status: 'playing', position: 0, duration: 60000 })
    await flush()

    expect(mockDb.queueChange).toHaveBeenCalledWith('book', bookA.id, 'upsert')
    expect(mockDb.queueChange).toHaveBeenCalledWith('book', bookB.id, 'upsert')
  })
})
