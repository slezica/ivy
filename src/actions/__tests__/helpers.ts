/**
 * Shared test helpers for action factory tests.
 */

import type { Book } from '../../services'
import type { AppState } from '../../store/types'


// -- Data factories -----------------------------------------------------------

export function createMockBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'book-1',
    uri: 'file:///audio/book-1.mp3',
    name: 'Test Book.mp3',
    duration: 60000,
    position: 5000,
    updated_at: 1000,
    title: 'Test Title',
    artist: 'Test Artist',
    artwork: 'data:image/png;base64,abc',
    file_size: 1024,
    fingerprint: new Uint8Array([1, 2, 3]),
    hidden: false,
    ...overrides,
  }
}

export function createMockPlayback(overrides: Partial<AppState['playback']> = {}): AppState['playback'] {
  return {
    status: 'idle',
    position: 0,
    uri: null,
    duration: 0,
    ownerId: null,
    ...overrides,
  }
}

export function createMockState(overrides: { playback?: Partial<AppState['playback']>, library?: Partial<AppState['library']> } = {}) {
  return {
    playback: createMockPlayback(overrides.playback),
    library: { status: 'idle' as string, ...overrides.library },
  }
}


// -- Store mocks --------------------------------------------------------------

/**
 * Creates a jest.fn() that behaves like Zustand's immer-based `set`:
 * - Object arg: merged into state (shallow)
 * - Function arg: called with state as draft
 *
 * Returns [setMock, state] so tests can inspect the mutated state.
 */
export function createImmerSet(state: ReturnType<typeof createMockState>) {
  const set = jest.fn((updater: any) => {
    if (typeof updater === 'function') {
      updater(state)
    } else {
      Object.assign(state, updater)
    }
  })
  return set
}

export function createMockGet(state: ReturnType<typeof createMockState>) {
  return jest.fn(() => state) as any
}


// -- Service mocks ------------------------------------------------------------

export function createMockAudio(overrides: Record<string, jest.Mock> = {}) {
  return {
    play: jest.fn(async () => {}),
    load: jest.fn(async () => 60000),
    seek: jest.fn(async () => {}),
    ...overrides,
  } as any
}

export function createMockDb(overrides: Record<string, jest.Mock | jest.Mock<any>> = {}) {
  return {
    getBookByFingerprint: jest.fn(() => null),
    getBookByUri: jest.fn(() => null),
    getBookByAnyUri: jest.fn(() => createMockBook()),
    getBookById: jest.fn(() => createMockBook()),
    upsertBook: jest.fn(() => createMockBook()),
    restoreBook: jest.fn(() => createMockBook()),
    touchBook: jest.fn(),
    ...overrides,
  } as any
}

export function createMockFiles(overrides: Record<string, jest.Mock> = {}) {
  return {
    copyToAppStorage: jest.fn(async () => 'file:///audio/temp-abc.mp3'),
    readFileFingerprint: jest.fn(async () => ({ fileSize: 1024, fingerprint: new Uint8Array([1, 2, 3]) })),
    rename: jest.fn(async (_uri: string, newName: string) => `file:///audio/${newName}.mp3`),
    deleteFile: jest.fn(async () => {}),
    ...overrides,
  } as any
}

export function createMockMetadata(overrides: Record<string, jest.Mock> = {}) {
  return {
    readMetadata: jest.fn(async () => ({
      title: 'Test Title',
      artist: 'Test Artist',
      artwork: 'data:image/png;base64,abc',
      duration: 60000,
    })),
    ...overrides,
  } as any
}

export function createMockSyncQueue(overrides: Record<string, jest.Mock> = {}) {
  return {
    queueChange: jest.fn(),
    ...overrides,
  } as any
}
