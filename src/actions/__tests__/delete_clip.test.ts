import { createDeleteClip, DeleteClipDeps } from '../delete_clip'
import {
  createMockClip, createMockState, createImmerSet, createMockGet,
  createMockDb, createMockSlicer, createMockSyncQueue,
} from './helpers'


// -- Helpers ------------------------------------------------------------------

function createDeps(clipId: string, clipUri: string | null = 'file:///clips/clip-1.mp3') {
  const clip = createMockClip({ id: clipId, uri: clipUri ?? 'file:///clips/clip-1.mp3' })
  if (clipUri === null) {
    delete (clip as any).uri
  }
  const state = createMockState({ clips: { [clipId]: clip } })

  const deps: DeleteClipDeps = {
    db: createMockDb(),
    slicer: createMockSlicer(),
    syncQueue: createMockSyncQueue(),
    set: createImmerSet(state),
    get: createMockGet(state),
  }

  return { state, deps, clip }
}


// -- Tests --------------------------------------------------------------------

describe('createDeleteClip', () => {

  describe('happy path', () => {
    it('removes clip from state', async () => {
      const { state, deps } = createDeps('clip-1')
      const deleteClip = createDeleteClip(deps)

      await deleteClip('clip-1')

      expect(state.clips['clip-1']).toBeUndefined()
    })

    it('calls db.deleteClip', async () => {
      const { deps } = createDeps('clip-1')
      const deleteClip = createDeleteClip(deps)

      await deleteClip('clip-1')

      expect(deps.db.deleteClip).toHaveBeenCalledWith('clip-1')
    })

    it('queues sync delete', async () => {
      const { deps } = createDeps('clip-1')
      const deleteClip = createDeleteClip(deps)

      await deleteClip('clip-1')

      expect(deps.syncQueue.queueChange).toHaveBeenCalledWith('clip', 'clip-1', 'delete')
    })

    it('cleans up clip audio file via slicer', async () => {
      const { deps } = createDeps('clip-1')
      const deleteClip = createDeleteClip(deps)

      await deleteClip('clip-1')

      expect(deps.slicer.cleanup).toHaveBeenCalledWith('file:///clips/clip-1.mp3')
    })

    it('does not attempt file cleanup if clip has no uri', async () => {
      const { deps } = createDeps('clip-1', null)
      const deleteClip = createDeleteClip(deps)

      await deleteClip('clip-1')

      expect(deps.slicer.cleanup).not.toHaveBeenCalled()
    })
  })

  describe('clip not found in state', () => {
    it('still calls db.deleteClip when clip is not in state', async () => {
      const state = createMockState({ clips: {} })
      const deps: DeleteClipDeps = {
        db: createMockDb(),
        slicer: createMockSlicer(),
        syncQueue: createMockSyncQueue(),
        set: createImmerSet(state),
        get: createMockGet(state),
      }
      const deleteClip = createDeleteClip(deps)

      await deleteClip('nonexistent')

      expect(deps.db.deleteClip).toHaveBeenCalledWith('nonexistent')
    })

    it('does not attempt file cleanup when clip is not in state', async () => {
      const state = createMockState({ clips: {} })
      const deps: DeleteClipDeps = {
        db: createMockDb(),
        slicer: createMockSlicer(),
        syncQueue: createMockSyncQueue(),
        set: createImmerSet(state),
        get: createMockGet(state),
      }
      const deleteClip = createDeleteClip(deps)

      await deleteClip('nonexistent')

      expect(deps.slicer.cleanup).not.toHaveBeenCalled()
    })
  })

  describe('file cleanup failure', () => {
    it('propagates slicer.cleanup errors', async () => {
      const { deps } = createDeps('clip-1', 'file:///clips/clip-1.mp3')
      deps.slicer.cleanup = jest.fn(async () => { throw new Error('cleanup failed') })
      const deleteClip = createDeleteClip(deps)

      await expect(deleteClip('clip-1')).rejects.toThrow('cleanup failed')
    })
  })

  describe('ordering', () => {
    it('cleans up file before deleting from db', async () => {
      const callOrder: string[] = []
      const { deps } = createDeps('clip-1')
      deps.slicer.cleanup = jest.fn(async () => { callOrder.push('cleanup') })
      deps.db.deleteClip = jest.fn(() => { callOrder.push('db') })
      const deleteClip = createDeleteClip(deps)

      await deleteClip('clip-1')

      expect(callOrder).toEqual(['cleanup', 'db'])
    })

    it('queues sync after db delete', async () => {
      const callOrder: string[] = []
      const { deps } = createDeps('clip-1')
      deps.db.deleteClip = jest.fn(() => { callOrder.push('db') })
      deps.syncQueue.queueChange = jest.fn(() => { callOrder.push('sync') })
      const deleteClip = createDeleteClip(deps)

      await deleteClip('clip-1')

      expect(callOrder).toEqual(expect.arrayContaining(['db', 'sync']))
      expect(callOrder.indexOf('db')).toBeLessThan(callOrder.indexOf('sync'))
    })
  })
})
