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
      updated_by: null,
    }
  }

  describe('processQueue error recovery', () => {
    it('resets processing flag after error in processClip', async () => {
      const deps = createMockDeps()
      const clip1 = createMockClip('clip-1')
      const clip2 = createMockClip('clip-2')

      deps.database.getClipsNeedingTranscription = jest.fn(async () => [clip1, clip2])

      // First clip throws, second should still be processed
      deps.slicer.slice = jest.fn()
        .mockRejectedValueOnce(new Error('Slice failed'))
        .mockResolvedValue({ uri: 'file:///temp.mp3', path: '/temp.mp3' })

      const completedClips: string[] = []

      const service = new TranscriptionQueueService(deps)
      service.on('finish', ({ clipId, transcription }) => {
        if (transcription !== undefined) completedClips.push(clipId)
      })

      await service.start()

      // Wait for processing to complete
      await new Promise(resolve => setTimeout(resolve, 100))

      // clip-1 failed but clip-2 should have been processed
      expect(completedClips).toEqual(['clip-2'])

      // Persistence is the store's job — the queue never writes the DB directly
      expect(deps.database.updateClip).not.toHaveBeenCalled()
    })

    it('continues processing remaining queue items after error', async () => {
      const deps = createMockDeps()
      const clip1 = createMockClip('clip-1')
      const clip2 = createMockClip('clip-2')
      const clip3 = createMockClip('clip-3')

      deps.database.getClipsNeedingTranscription = jest.fn(async () => [clip1, clip2, clip3])

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

      deps.database.getClipsNeedingTranscription = jest.fn(async () => [clip1, clip2])

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

  describe('transcription results', () => {
    it('emits finish with an empty transcription without writing the DB', async () => {
      const deps = createMockDeps()
      const clip = createMockClip('clip-1')

      deps.database.getClipsNeedingTranscription = jest.fn(async () => [clip])
      deps.whisper.transcribe = jest.fn(() => Promise.resolve(''))

      const finished: { clipId: string; transcription?: string; error?: Error }[] = []

      const service = new TranscriptionQueueService(deps)
      service.on('finish', (event) => finished.push(event))

      await service.start()

      await new Promise(resolve => setTimeout(resolve, 50))

      // '' is a valid result (silence/music) and must reach listeners;
      // persistence happens in the store, never in the queue
      expect(finished).toEqual([{ clipId: 'clip-1', transcription: '', start: 0, duration: 5000 }])
      expect(deps.database.updateClip).not.toHaveBeenCalled()
    })
  })

  describe('stale bounds detection', () => {
    it('carries the bounds captured at processing start, and processes a re-queued clip', async () => {
      const deps = createMockDeps()

      const oldClip = { ...createMockClip('clip-1'), start: 0, duration: 5000 }
      const newClip = { ...createMockClip('clip-1'), start: 2000, duration: 4000 }

      // The in-flight job reads the old bounds; the re-queued job reads the
      // new ones (written by updateClip before it re-queued)
      deps.database.getClipsNeedingTranscription = jest.fn()
        .mockResolvedValueOnce([])        // start() seeding
        .mockResolvedValueOnce([oldClip]) // in-flight job
        .mockResolvedValue([newClip])     // re-queued job

      // First job blocks on transcribe until released
      let releaseFirst!: (text: string) => void
      deps.whisper.transcribe = jest.fn()
        .mockImplementationOnce(() => new Promise<string>(resolve => { releaseFirst = resolve }))
        .mockResolvedValue('new text')

      const service = new TranscriptionQueueService(deps)

      // Record whether a newer job was still queued at each finish
      const finished: Record<string, unknown>[] = []
      service.on('finish', (event) => {
        finished.push({ ...event, queuedBehind: service.hasQueuedJob(event.clipId) })
      })

      await service.start()
      service.queueClip('clip-1')
      await new Promise(resolve => setTimeout(resolve, 10))

      // Bounds edit re-queues the clip while the first job is in flight
      service.queueClip('clip-1')
      expect(service.hasQueuedJob('clip-1')).toBe(true)

      releaseFirst('old text')
      await new Promise(resolve => setTimeout(resolve, 50))

      // Both jobs finished with the bounds they actually transcribed, letting
      // listeners discard the first (stale) result but keep its spinner alive
      expect(finished).toEqual([
        { clipId: 'clip-1', transcription: 'old text', start: 0, duration: 5000, queuedBehind: true },
        { clipId: 'clip-1', transcription: 'new text', start: 2000, duration: 4000, queuedBehind: false },
      ])
    })
  })

  describe('skipped clips', () => {
    it('emits finish when a queued clip no longer needs transcription', async () => {
      const deps = createMockDeps()
      // Queue an id whose clip was already transcribed (or deleted)
      deps.database.getClipsNeedingTranscription = jest.fn(async () => [])

      const finished: { clipId: string; transcription?: string; error?: Error }[] = []

      const service = new TranscriptionQueueService(deps)
      service.on('finish', (event) => finished.push(event))

      await service.start()
      service.queueClip('clip-1')

      await new Promise(resolve => setTimeout(resolve, 50))

      // Listeners still get a finish (to clear pending state), with no result
      expect(finished).toEqual([{ clipId: 'clip-1' }])
      expect(deps.whisper.transcribe).not.toHaveBeenCalled()
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

    it('fails queued clips when initialization exhausts retries', async () => {
      jest.useFakeTimers()

      const deps = createMockDeps()
      deps.whisper.initialize = jest.fn(() => Promise.reject(new Error('init failed')))
      deps.whisper.isReady = jest.fn(() => false)

      const service = new TranscriptionQueueService(deps)

      const finished: { clipId: string; transcription?: string; error?: Error }[] = []
      service.on('finish', (event) => finished.push(event))

      const startPromise = service.start()

      // Clip queued while the model is still initializing
      service.queueClip('clip-1')

      // Fast-forward through all retry delays
      for (let i = 0; i < 3; i++) {
        await Promise.resolve() // let the rejection propagate
        jest.runAllTimers()
      }

      await expect(startPromise).rejects.toThrow('init failed')

      // The queued clip was failed so listeners can clear pending state
      expect(finished).toEqual([{ clipId: 'clip-1', error: expect.any(Error) }])

      jest.useRealTimers()
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
