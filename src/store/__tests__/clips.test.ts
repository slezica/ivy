import { createUpdateClip, UpdateClipDeps } from '../../actions/update_clip'
import type { ClipWithFile } from '../../services'

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
