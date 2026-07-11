import { createUpdateClip, UpdateClipDeps } from '../../actions/update_clip'
import type { ClipWithFile } from '../../services'

// immer ships untransformed ESM under the react-native export condition;
// point Jest at its CJS build so the real store (zustand + immer) can load
jest.mock('immer', () => jest.requireActual('../../../node_modules/immer/dist/cjs/index.js'))

// whisper.ts imports this native-only module at the top level
jest.mock('react-native-audio-api', () => ({
  decodeAudioData: jest.fn(),
}))

// files.ts constructs a Directory from Paths.document at import time
jest.mock('expo-file-system', () => ({
  Paths: { document: '/mock/documents' },
  Directory: jest.fn(),
  File: jest.fn(),
}))

// Full-featured expo-sqlite mock (the global one lacks the async API) so the
// real store and services below can be imported and driven end to end
jest.mock('expo-sqlite', () => ({
  openDatabaseSync: jest.fn(() => ({
    execSync: jest.fn(),
    execAsync: jest.fn(async () => {}),
    runSync: jest.fn(),
    runAsync: jest.fn(async () => ({ changes: 0, lastInsertRowId: 0 })),
    getFirstSync: jest.fn(),
    getFirstAsync: jest.fn(async () => null),
    getAllSync: jest.fn(() => []),
    getAllAsync: jest.fn(async () => []),
  })),
}))

/**
 * Tests for clip actions.
 *
 * Bug #1: Race condition where clip could be deleted between
 * the initial check and the set callback in updateClip.
 */

describe('createUpdateClip', () => {
  // Helper to create a mock clip
  function createMockClip(id: string): ClipWithFile {
    return {
      id,
      source_id: 'book-1',
      uri: `file:///clips/${id}.mp3`,
      start: 0,
      duration: 5000,
      note: 'test note',
      transcription: null,
      created_at: 1000,
      updated_at: 1000,
      updated_by: null,
      file_uri: 'file:///books/book-1.mp3',
      file_name: 'Book 1',
      file_title: 'Book Title',
      file_artist: 'Artist',
      file_duration: 60000,
    }
  }

  function createMockDeps(storeState: any): UpdateClipDeps {
    return {
      db: {
        updateClip: jest.fn(),
      } as any,
      slicer: {
        ensureDir: jest.fn(),
        slice: jest.fn(),
        cleanup: jest.fn(),
      } as any,
      syncQueue: {
        queueChange: jest.fn(),
      } as any,
      transcription: {
        queueClip: jest.fn(),
      } as any,
      set: jest.fn((updater: any) => {
        if (typeof updater === 'function') {
          updater(storeState)
        } else {
          Object.assign(storeState, updater)
        }
      }),
      get: jest.fn(() => storeState),
    }
  }

  it('handles clip deleted between check and set callback', async () => {
    let storeState: any = {
      clips: { 'clip-1': createMockClip('clip-1') },
    }

    const deps = createMockDeps(storeState)

    // Override set to simulate deletion mid-operation
    deps.set = jest.fn((updater: any) => {
      if (typeof updater === 'function') {
        delete storeState.clips['clip-1']
        updater(storeState)
      }
    })

    const updateClip = createUpdateClip(deps)

    // This should not throw even though clip is deleted mid-operation
    await expect(
      updateClip('clip-1', { note: 'updated note' })
    ).resolves.not.toThrow()

    expect(deps.set).toHaveBeenCalled()
  })

  it('updates clip note when clip exists', async () => {
    const clip = createMockClip('clip-1')
    const storeState: any = {
      clips: { 'clip-1': clip },
    }

    const deps = createMockDeps(storeState)
    const updateClip = createUpdateClip(deps)

    await updateClip('clip-1', { note: 'updated note' })

    expect(deps.db.updateClip).toHaveBeenCalledWith('clip-1', { note: 'updated note', uri: undefined })
    expect(storeState.clips['clip-1'].note).toBe('updated note')
  })

  it('does nothing when clip does not exist initially', async () => {
    const storeState: any = {
      clips: {},
    }

    const deps = createMockDeps(storeState)
    const updateClip = createUpdateClip(deps)

    await updateClip('nonexistent', { note: 'updated note' })

    // Should return early without calling db or set
    expect(deps.db.updateClip).not.toHaveBeenCalled()
    expect(deps.set).not.toHaveBeenCalled()
  })
})

/**
 * Store-level test for bug M2: a bounds edit during an in-flight transcription
 * must not keep the old audio's text. Drives the REAL store event wiring and
 * the REAL transcription queue; only whisper/slicer/db IO is faked.
 */
describe('store: transcription finish handling', () => {
  // Imported lazily so the expo-sqlite mock above is in place first
  const { useStore } = require('../index') as typeof import('../index') & { useStore: any }
  const services = require('../../services') as typeof import('../../services') & Record<string, any>

  function createStoreClip(id: string): ClipWithFile {
    return {
      id,
      source_id: 'book-1',
      uri: `file:///clips/${id}.m4a`,
      start: 0,
      duration: 5000,
      note: '',
      transcription: null,
      created_at: 1000,
      updated_at: 1000,
      updated_by: null,
      file_uri: 'file:///books/book-1.mp3',
      file_name: 'Book 1',
      file_title: 'Book Title',
      file_artist: 'Artist',
      file_duration: 60000,
    }
  }

  const flush = () => new Promise(resolve => setTimeout(resolve, 25))

  afterEach(() => {
    services.transcription.stop()
    jest.restoreAllMocks()
  })

  it('discards the in-flight result after a bounds edit, then applies the re-queued one', async () => {
    const clip = createStoreClip('clip-1')

    // Fake the IO around the real queue and real store handler
    jest.spyOn(services.whisper, 'initialize').mockResolvedValue(undefined)
    jest.spyOn(services.whisper, 'isReady').mockReturnValue(true)
    jest.spyOn(services.slicer, 'slice').mockResolvedValue({ path: '/tmp/slice.m4a', uri: 'file:///tmp/slice.m4a' })
    jest.spyOn(services.slicer, 'cleanup').mockResolvedValue(undefined)
    jest.spyOn(services.slicer, 'move').mockResolvedValue(undefined)
    const dbUpdateClip = jest.spyOn(services.db, 'updateClip').mockResolvedValue(undefined)

    // The in-flight job reads the old bounds; the re-queued job reads the new
    // bounds written by updateClip
    jest.spyOn(services.db, 'getClipsNeedingTranscription')
      .mockResolvedValueOnce([])                                        // start() seeding
      .mockResolvedValueOnce([{ ...clip }])                             // in-flight job
      .mockResolvedValue([{ ...clip, start: 2000, duration: 4000 }])    // re-queued job

    // First transcription blocks until released; the second resolves directly
    let releaseFirst!: (text: string) => void
    jest.spyOn(services.whisper, 'transcribe')
      .mockImplementationOnce(() => new Promise<string>(resolve => { releaseFirst = resolve }))
      .mockResolvedValue('new text')

    useStore.setState({ clips: { 'clip-1': clip }, transcription: { status: 'on', pending: {} } })

    await services.transcription.start()
    services.transcription.queueClip('clip-1')
    await flush()

    // Job is in flight, spinner on
    expect(useStore.getState().transcription.pending['clip-1']).toBe(true)

    // User edits bounds while the job is in flight — re-slices and re-queues
    await useStore.getState().updateClip('clip-1', { start: 2000, duration: 4000 })
    expect(useStore.getState().clips['clip-1'].transcription).toBeNull()

    // Old-audio result lands: discarded, and the spinner survives for the
    // re-queued job still in flight
    releaseFirst('old text')
    await flush()

    expect(useStore.getState().clips['clip-1'].transcription).toBe('new text')
    expect(useStore.getState().transcription.pending['clip-1']).toBeUndefined()

    // The stale text never landed anywhere
    expect(dbUpdateClip).not.toHaveBeenCalledWith('clip-1', expect.objectContaining({ transcription: 'old text' }))
  })

  it('keeps the spinner on a discarded stale result while the re-queued job runs', async () => {
    const clip = createStoreClip('clip-2')

    jest.spyOn(services.whisper, 'initialize').mockResolvedValue(undefined)
    jest.spyOn(services.whisper, 'isReady').mockReturnValue(true)
    jest.spyOn(services.slicer, 'slice').mockResolvedValue({ path: '/tmp/slice.m4a', uri: 'file:///tmp/slice.m4a' })
    jest.spyOn(services.slicer, 'cleanup').mockResolvedValue(undefined)
    jest.spyOn(services.slicer, 'move').mockResolvedValue(undefined)
    jest.spyOn(services.db, 'updateClip').mockResolvedValue(undefined)

    jest.spyOn(services.db, 'getClipsNeedingTranscription')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...clip }])
      .mockResolvedValue([{ ...clip, start: 1000, duration: 3000 }])

    // Both jobs block until released, so the intermediate state is observable
    let releaseFirst!: (text: string) => void
    let releaseSecond!: (text: string) => void
    jest.spyOn(services.whisper, 'transcribe')
      .mockImplementationOnce(() => new Promise<string>(resolve => { releaseFirst = resolve }))
      .mockImplementationOnce(() => new Promise<string>(resolve => { releaseSecond = resolve }))

    useStore.setState({ clips: { 'clip-2': clip }, transcription: { status: 'on', pending: {} } })

    await services.transcription.start()
    services.transcription.queueClip('clip-2')
    await flush()

    await useStore.getState().updateClip('clip-2', { start: 1000, duration: 3000 })

    releaseFirst('old text')
    await flush()

    // Stale result discarded — but the spinner must survive for the newer job
    expect(useStore.getState().clips['clip-2'].transcription).toBeNull()
    expect(useStore.getState().transcription.pending['clip-2']).toBe(true)

    releaseSecond('new text')
    await flush()

    expect(useStore.getState().clips['clip-2'].transcription).toBe('new text')
    expect(useStore.getState().transcription.pending['clip-2']).toBeUndefined()
  })
})
