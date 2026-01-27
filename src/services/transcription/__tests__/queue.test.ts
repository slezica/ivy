import { TranscriptionQueueService, TranscriptionQueueDeps } from '../queue'
import type { Clip } from '../../storage/database'

/**
 * Tests for the TranscriptionQueueService.
 *
 * Bug #5: Race condition where the processing flag could get stuck
 * as true if processClip threw an error, permanently stalling the queue.
 */

describe('TranscriptionQueueService', () => {
  // Helper to create mock dependencies
  function createMockDeps(): TranscriptionQueueDeps {
    return {
      database: {
        getClipsNeedingTranscription: jest.fn(() => []),
        updateClip: jest.fn(),
      } as any,
      whisper: {
        initialize: jest.fn(() => Promise.resolve()),
        isReady: jest.fn(() => true),
        transcribe: jest.fn(() => Promise.resolve('transcription result')),
      } as any,
      slicer: {
        slice: jest.fn(() => Promise.resolve({ uri: 'file:///temp.mp3', path: '/temp.mp3' })),
        cleanup: jest.fn(() => Promise.resolve()),
      } as any,
    }
  }

  // Helper to create a mock clip
  function createMockClip(id: string): Clip {
    return {
      id,
      source_id: 'book-1',
      uri: `file:///clips/${id}.mp3`,
      start: 0,
      duration: 5000,
      note: '',
      transcription: null,
      created_at: 1000,
      updated_at: 1000,
    }
  }

  describe('processQueue error recovery', () => {
    it('resets processing flag after error in processClip', async () => {
      const deps = createMockDeps()
      const clip1 = createMockClip('clip-1')
      const clip2 = createMockClip('clip-2')

      // First clip throws, second should still be processed
      let processCount = 0
      deps.database.getClipsNeedingTranscription = jest.fn(() => {
        processCount++
        if (processCount === 1) return [clip1]
        if (processCount === 2) return [clip2]
        return []
      })

      deps.slicer.slice = jest.fn()
        .mockRejectedValueOnce(new Error('Slice failed'))
        .mockResolvedValue({ uri: 'file:///temp.mp3', path: '/temp.mp3' })

      const service = new TranscriptionQueueService(deps)

      // Queue first clip (will fail)
      service.queueClip('clip-1')

      // Wait for processing to complete
      await new Promise(resolve => setTimeout(resolve, 50))

      // Queue second clip (should work because flag was reset)
      service.queueClip('clip-2')

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 50))

      // Both clips should have been attempted
      expect(deps.database.getClipsNeedingTranscription).toHaveBeenCalledTimes(2)
    })

    it('continues processing remaining queue items after error', async () => {
      const deps = createMockDeps()
      const clip1 = createMockClip('clip-1')
      const clip2 = createMockClip('clip-2')
      const clip3 = createMockClip('clip-3')

      // Return clips in sequence
      deps.database.getClipsNeedingTranscription = jest.fn()
        .mockReturnValueOnce([clip1])  // First call for clip-1
        .mockReturnValueOnce([clip2])  // Second call for clip-2
        .mockReturnValueOnce([clip3])  // Third call for clip-3
        .mockReturnValue([])

      // Second clip throws error
      let sliceCallCount = 0
      deps.slicer.slice = jest.fn().mockImplementation(async () => {
        sliceCallCount++
        if (sliceCallCount === 2) {
          throw new Error('Slice failed for clip-2')
        }
        return { uri: 'file:///temp.mp3', path: '/temp.mp3' }
      })

      const completedClips: string[] = []

      const service = new TranscriptionQueueService(deps)
      service.on('complete', ({ clipId }) => {
        completedClips.push(clipId)
      })

      // Queue all three clips
      service.queueClip('clip-1')
      service.queueClip('clip-2')
      service.queueClip('clip-3')

      // Wait for all processing
      await new Promise(resolve => setTimeout(resolve, 100))

      // clip-1 and clip-3 should have completed, clip-2 failed
      expect(completedClips).toContain('clip-1')
      expect(completedClips).toContain('clip-3')
      expect(completedClips).not.toContain('clip-2')
    })

    it('allows new queue processing after error recovery', async () => {
      const deps = createMockDeps()
      const clip1 = createMockClip('clip-1')
      const clip2 = createMockClip('clip-2')

      deps.database.getClipsNeedingTranscription = jest.fn()
        .mockReturnValueOnce([clip1])
        .mockReturnValueOnce([clip2])
        .mockReturnValue([])

      // First clip throws
      deps.slicer.slice = jest.fn()
        .mockRejectedValueOnce(new Error('First slice failed'))
        .mockResolvedValue({ uri: 'file:///temp.mp3', path: '/temp.mp3' })

      const service = new TranscriptionQueueService(deps)

      const completedClips: Array<{ clipId: string; transcription: string }> = []
      service.on('complete', (event) => {
        completedClips.push(event)
      })

      // Queue and process first clip (fails)
      service.queueClip('clip-1')
      await new Promise(resolve => setTimeout(resolve, 50))

      // Verify processing flag is reset by checking we can queue another
      service.queueClip('clip-2')
      await new Promise(resolve => setTimeout(resolve, 50))

      // The event should have been emitted for clip-2
      expect(completedClips).toContainEqual({ clipId: 'clip-2', transcription: 'transcription result' })
    })
  })

  describe('concurrent queue operations', () => {
    it('does not process concurrently when flag is set', async () => {
      const deps = createMockDeps()
      const clip1 = createMockClip('clip-1')

      deps.database.getClipsNeedingTranscription = jest.fn(() => [clip1])

      let concurrentCalls = 0
      let maxConcurrent = 0

      deps.slicer.slice = jest.fn().mockImplementation(async () => {
        concurrentCalls++
        maxConcurrent = Math.max(maxConcurrent, concurrentCalls)

        // Simulate slow processing
        await new Promise(resolve => setTimeout(resolve, 50))

        concurrentCalls--
        return { uri: 'file:///temp.mp3', path: '/temp.mp3' }
      })

      const service = new TranscriptionQueueService(deps)

      // Queue multiple clips rapidly
      service.queueClip('clip-1')
      service.queueClip('clip-1')
      service.queueClip('clip-1')

      await new Promise(resolve => setTimeout(resolve, 200))

      // Should never have more than 1 concurrent processing
      expect(maxConcurrent).toBe(1)
    })
  })
})
