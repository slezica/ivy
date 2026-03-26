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
        getClipsNeedingTranscription: jest.fn(async () => []),
        updateClip: jest.fn(async () => {}),
      } as any,
      whisper: {
        initialize: jest.fn(() => Promise.resolve()),
        isReady: jest.fn(() => true),
        transcribe: jest.fn(() => Promise.resolve('transcription result')),
        on: jest.fn(),
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

      // Track which clips are "pending" (not yet transcribed)
      const pendingClips = new Set([clip1.id, clip2.id])

      deps.database.getClipsNeedingTranscription = jest.fn(async () => {
        return [clip1, clip2].filter(c => pendingClips.has(c.id))
      })

      // First clip throws, second should still be processed
      deps.slicer.slice = jest.fn()
        .mockRejectedValueOnce(new Error('Slice failed'))
        .mockResolvedValue({ uri: 'file:///temp.mp3', path: '/temp.mp3' })

      // Mark clip as transcribed when updateClip is called
      deps.database.updateClip = jest.fn(async (id: string) => {
        pendingClips.delete(id)
      })

      const service = new TranscriptionQueueService(deps)
      await service.start()

      // Wait for processing to complete
      await new Promise(resolve => setTimeout(resolve, 100))

      // clip-1 failed but clip-2 should have been processed
      expect(deps.database.updateClip).toHaveBeenCalledWith('clip-2', { transcription: 'transcription result' })
    })

    it('continues processing remaining queue items after error', async () => {
      const deps = createMockDeps()
      const clip1 = createMockClip('clip-1')
      const clip2 = createMockClip('clip-2')
      const clip3 = createMockClip('clip-3')

      const pendingClips = new Set([clip1.id, clip2.id, clip3.id])

      deps.database.getClipsNeedingTranscription = jest.fn(async () => {
        return [clip1, clip2, clip3].filter(c => pendingClips.has(c.id))
      })

      deps.database.updateClip = jest.fn(async (id: string) => {
        pendingClips.delete(id)
      })

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
      service.on('finish', ({ clipId, transcription }) => {
        if (transcription) completedClips.push(clipId)
      })

      await service.start()

      // Wait for all processing
      await new Promise(resolve => setTimeout(resolve, 150))

      // clip-1 and clip-3 should have completed, clip-2 failed
      expect(completedClips).toContain('clip-1')
      expect(completedClips).toContain('clip-3')
      expect(completedClips).not.toContain('clip-2')
    })

    it('allows new queue processing after error recovery', async () => {
      const deps = createMockDeps()
      const clip1 = createMockClip('clip-1')
      const clip2 = createMockClip('clip-2')

      const pendingClips = new Set([clip1.id, clip2.id])

      deps.database.getClipsNeedingTranscription = jest.fn(async () => {
        return [clip1, clip2].filter(c => pendingClips.has(c.id))
      })

      deps.database.updateClip = jest.fn(async (id: string) => {
        pendingClips.delete(id)
      })

      // First clip throws
      deps.slicer.slice = jest.fn()
        .mockRejectedValueOnce(new Error('First slice failed'))
        .mockResolvedValue({ uri: 'file:///temp.mp3', path: '/temp.mp3' })

      const service = new TranscriptionQueueService(deps)

      const completedClips: { clipId: string; transcription: string }[] = []
      service.on('finish', ({ clipId, transcription }) => {
        if (transcription) completedClips.push({ clipId, transcription })
      })

      await service.start()

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 100))

      // The event should have been emitted for clip-2
      expect(completedClips).toContainEqual({ clipId: 'clip-2', transcription: 'transcription result' })
    })
  })

  describe('concurrent queue operations', () => {
    it('does not process concurrently when flag is set', async () => {
      const deps = createMockDeps()
      const clip1 = createMockClip('clip-1')

      deps.database.getClipsNeedingTranscription = jest.fn(async () => [clip1])

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
      await service.start()

      // Queue the same clip multiple times rapidly
      service.queueClip('clip-1')
      service.queueClip('clip-1')
      service.queueClip('clip-1')

      await new Promise(resolve => setTimeout(resolve, 300))

      // Should never have more than 1 concurrent processing
      expect(maxConcurrent).toBe(1)
    })
  })

  describe('start/stop lifecycle', () => {
    // Helper: create a deferred promise for controlling whisper.initialize() timing
    function createDeferred() {
      let resolve!: () => void
      let reject!: (error: Error) => void
      const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
      return { promise, resolve, reject }
    }

    it('returns the same promise on concurrent start() calls', async () => {
      const deps = createMockDeps()
      const deferred = createDeferred()
      deps.whisper.initialize = jest.fn(() => deferred.promise)

      const service = new TranscriptionQueueService(deps)

      const p1 = service.start()
      const p2 = service.start()

      deferred.resolve()
      await Promise.all([p1, p2])

      expect(deps.whisper.initialize).toHaveBeenCalledTimes(1)
    })

    it('bails without processing queue when stopped during initialization', async () => {
      const deps = createMockDeps()
      const clip = createMockClip('clip-1')
      deps.database.getClipsNeedingTranscription = jest.fn(async () => [clip])

      const deferred = createDeferred()
      deps.whisper.initialize = jest.fn(() => deferred.promise)

      const service = new TranscriptionQueueService(deps)
      const startPromise = service.start()

      service.stop()
      deferred.resolve()
      await startPromise

      // Queue should not have been processed
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(deps.slicer.slice).not.toHaveBeenCalled()
    })

    it('continues normally when stop() then start() called during initialization', async () => {
      const deps = createMockDeps()
      const clip = createMockClip('clip-1')
      deps.database.getClipsNeedingTranscription = jest.fn(async () => [clip])

      const deferred = createDeferred()
      deps.whisper.initialize = jest.fn(() => deferred.promise)

      const service = new TranscriptionQueueService(deps)
      const p1 = service.start()

      // Toggle off then on while initializing
      service.stop()
      const p2 = service.start() // re-asserts started, reuses promise

      deferred.resolve()
      await Promise.all([p1, p2])

      // Should have processed the queue since started was re-asserted
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(deps.slicer.slice).toHaveBeenCalled()
    })

    it('retries initialization on a fresh start() after failure', async () => {
      jest.useFakeTimers()

      const deps = createMockDeps()

      // First start: initialize fails all attempts
      deps.whisper.initialize = jest.fn(() => Promise.reject(new Error('init failed')))
      deps.whisper.isReady = jest.fn(() => false)

      const service = new TranscriptionQueueService(deps)
      const firstStart = service.start()

      // Fast-forward through all retry delays
      for (let i = 0; i < 3; i++) {
        await Promise.resolve() // let the rejection propagate
        jest.runAllTimers()
      }

      await expect(firstStart).rejects.toThrow('init failed')

      // Second start: initialize succeeds
      deps.whisper.initialize = jest.fn(() => Promise.resolve())
      deps.whisper.isReady = jest.fn(() => true)

      await service.start()

      // Should succeed — the old failed promise was cleared
      expect(deps.whisper.initialize).toHaveBeenCalled()

      jest.useRealTimers()
    })
  })
})
