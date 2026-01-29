import { createUpdateClip, UpdateClipDeps } from '../update_clip'
import {
  createMockClip, createMockState, createMockGet, createImmerSet,
  createMockDb, createMockSyncQueue, createMockSlicer, createMockTranscription,
} from './helpers'


// -- Helpers ------------------------------------------------------------------

function createDeps(overrides: {
  clipId?: string
  clip?: Parameters<typeof createMockClip>[0]
  db?: any
  slicer?: any
  syncQueue?: any
  transcription?: any
} = {}) {
  const { clipId = 'clip-1' } = overrides
  const clip = createMockClip({ id: clipId, ...overrides.clip })
  const state = createMockState({ clips: { [clipId]: clip } })
  const set = createImmerSet(state)

  const deps: UpdateClipDeps = {
    db: overrides.db ?? createMockDb(),
    slicer: overrides.slicer ?? createMockSlicer(),
    syncQueue: overrides.syncQueue ?? createMockSyncQueue(),
    transcription: overrides.transcription ?? createMockTranscription(),
    set,
    get: createMockGet(state),
  }

  return { state, deps, set }
}


// -- Tests --------------------------------------------------------------------

describe('createUpdateClip', () => {

  describe('note-only update', () => {
    it('updates note in db and store without re-slicing', async () => {
      const { state, deps } = createDeps()
      const updateClip = createUpdateClip(deps)

      await updateClip('clip-1', { note: 'new note' })

      expect(deps.slicer.slice).not.toHaveBeenCalled()
      expect(deps.db.updateClip).toHaveBeenCalledWith('clip-1', { note: 'new note', uri: undefined })
      expect(state.clips['clip-1'].note).toBe('new note')
    })

    it('does not queue for transcription', async () => {
      const { deps } = createDeps()
      const updateClip = createUpdateClip(deps)

      await updateClip('clip-1', { note: 'new note' })

      expect(deps.transcription.queueClip).not.toHaveBeenCalled()
    })
  })

  describe('bounds change', () => {
    it('re-slices audio from source file', async () => {
      const { deps } = createDeps()
      const updateClip = createUpdateClip(deps)

      await updateClip('clip-1', { start: 20000, duration: 3000 })

      expect(deps.slicer.ensureDir).toHaveBeenCalled()
      expect(deps.slicer.slice).toHaveBeenCalledWith({
        sourceUri: 'file:///audio/book-1.mp3',
        startMs: 20000,
        endMs: 23000,
        outputPrefix: 'clip-1',
        outputDir: expect.any(String),
      })
    })

    it('deletes old clip file after re-slicing', async () => {
      const { deps } = createDeps()
      const updateClip = createUpdateClip(deps)

      await updateClip('clip-1', { start: 20000 })

      expect(deps.slicer.cleanup).toHaveBeenCalledWith('file:///clips/clip-1.mp3')
    })

    it('clears transcription and re-queues', async () => {
      const { state, deps } = createDeps({
        clip: { transcription: 'old transcription' },
      })
      const updateClip = createUpdateClip(deps)

      await updateClip('clip-1', { start: 20000 })

      expect(state.clips['clip-1'].transcription).toBeNull()
      expect(deps.transcription.queueClip).toHaveBeenCalledWith('clip-1')
    })

    it('updates store uri to new slice result', async () => {
      const newUri = 'file:///clips/clip-1-new.m4a'
      const { state, deps } = createDeps({
        slicer: createMockSlicer({ slice: jest.fn(async () => ({ uri: newUri })) }),
      })
      const updateClip = createUpdateClip(deps)

      await updateClip('clip-1', { duration: 8000 })

      expect(state.clips['clip-1'].uri).toBe(newUri)
    })

    it('uses existing value when only start changes', async () => {
      const { deps } = createDeps({ clip: { start: 10000, duration: 5000 } })
      const updateClip = createUpdateClip(deps)

      await updateClip('clip-1', { start: 15000 })

      expect(deps.slicer.slice).toHaveBeenCalledWith(
        expect.objectContaining({ startMs: 15000, endMs: 20000 })
      )
    })

    it('uses existing value when only duration changes', async () => {
      const { deps } = createDeps({ clip: { start: 10000, duration: 5000 } })
      const updateClip = createUpdateClip(deps)

      await updateClip('clip-1', { duration: 9000 })

      expect(deps.slicer.slice).toHaveBeenCalledWith(
        expect.objectContaining({ startMs: 10000, endMs: 19000 })
      )
    })

    it('throws if source file is missing', async () => {
      const { deps } = createDeps({ clip: { file_uri: null } })
      const updateClip = createUpdateClip(deps)

      await expect(updateClip('clip-1', { start: 5000 })).rejects.toThrow(
        'Cannot edit clip bounds: source file has been removed'
      )
    })
  })

  describe('no-op cases', () => {
    it('does nothing if clip does not exist', async () => {
      const { deps } = createDeps()
      const updateClip = createUpdateClip(deps)

      await updateClip('nonexistent', { note: 'x' })

      expect(deps.db.updateClip).not.toHaveBeenCalled()
      expect(deps.syncQueue.queueChange).not.toHaveBeenCalled()
    })

    it('does not re-slice when start matches current value', async () => {
      const { deps } = createDeps({ clip: { start: 10000 } })
      const updateClip = createUpdateClip(deps)

      await updateClip('clip-1', { start: 10000, note: 'updated' })

      expect(deps.slicer.slice).not.toHaveBeenCalled()
    })
  })

  describe('persistence', () => {
    it('queues clip for sync', async () => {
      const { deps } = createDeps()
      const updateClip = createUpdateClip(deps)

      await updateClip('clip-1', { note: 'x' })

      expect(deps.syncQueue.queueChange).toHaveBeenCalledWith('clip', 'clip-1', 'upsert')
    })

    it('passes new uri to db when bounds changed', async () => {
      const newUri = 'file:///clips/resliced.m4a'
      const { deps } = createDeps({
        slicer: createMockSlicer({ slice: jest.fn(async () => ({ uri: newUri })) }),
      })
      const updateClip = createUpdateClip(deps)

      await updateClip('clip-1', { start: 30000 })

      expect(deps.db.updateClip).toHaveBeenCalledWith('clip-1', expect.objectContaining({ uri: newUri }))
    })
  })
})
