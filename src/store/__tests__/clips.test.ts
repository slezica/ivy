import { createClipSlice, ClipSliceDeps } from '../clips'
import type { ClipWithFile } from '../../services'

/**
 * Tests for the clips store slice.
 *
 * Bug #1: Race condition where clip could be deleted between
 * the initial check and the set callback in updateClip.
 */

describe('createClipSlice', () => {
  // Mock dependencies
  function createMockDeps(): ClipSliceDeps {
    return {
      db: {
        getAllClips: jest.fn(() => []),
        updateClip: jest.fn(),
        createClip: jest.fn(),
        deleteClip: jest.fn(),
      } as any,
      slicer: {
        ensureDir: jest.fn(),
        slice: jest.fn(),
        cleanup: jest.fn(),
      } as any,
      queue: {
        queueChange: jest.fn(),
      } as any,
      transcription: {
        queueClip: jest.fn(),
      } as any,
      sharing: {
        shareClipFile: jest.fn(),
      } as any,
    }
  }

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
      file_uri: 'file:///books/book-1.mp3',
      file_name: 'Book 1',
      file_title: 'Book Title',
      file_artist: 'Artist',
      file_duration: 60000,
    }
  }

  describe('updateClip', () => {
    it('handles clip deleted between check and set callback', async () => {
      const deps = createMockDeps()

      let storeState: any = {
        clips: { 'clip-1': createMockClip('clip-1') },
        books: {},
      }

      const set = jest.fn((updater: any) => {
        if (typeof updater === 'function') {
          // Simulate clip being deleted before set callback runs
          delete storeState.clips['clip-1']
          updater(storeState)
        } else {
          Object.assign(storeState, updater)
        }
      })

      const get = jest.fn(() => storeState)

      const slice = createClipSlice(deps)(set, get)

      // This should not throw even though clip is deleted mid-operation
      await expect(
        slice.updateClip('clip-1', { note: 'updated note' })
      ).resolves.not.toThrow()

      // Verify set was called (the guard inside should have prevented the crash)
      expect(set).toHaveBeenCalled()
    })

    it('updates clip note when clip exists', async () => {
      const deps = createMockDeps()
      const clip = createMockClip('clip-1')

      let storeState: any = {
        clips: { 'clip-1': clip },
        books: {},
      }

      const set = jest.fn((updater: any) => {
        if (typeof updater === 'function') {
          updater(storeState)
        } else {
          Object.assign(storeState, updater)
        }
      })

      const get = jest.fn(() => storeState)

      const slice = createClipSlice(deps)(set, get)

      await slice.updateClip('clip-1', { note: 'updated note' })

      expect(deps.db.updateClip).toHaveBeenCalledWith('clip-1', { note: 'updated note', uri: undefined })
      expect(storeState.clips['clip-1'].note).toBe('updated note')
    })

    it('does nothing when clip does not exist initially', async () => {
      const deps = createMockDeps()

      const storeState: any = {
        clips: {},
        books: {},
      }

      const set = jest.fn()
      const get = jest.fn(() => storeState)

      const slice = createClipSlice(deps)(set, get)

      await slice.updateClip('nonexistent', { note: 'updated note' })

      // Should return early without calling db or set
      expect(deps.db.updateClip).not.toHaveBeenCalled()
      expect(set).not.toHaveBeenCalled()
    })
  })
})
