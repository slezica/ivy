/**
 * Transcription Queue Service
 *
 * Background job queue for automatic clip transcription.
 * Processes clips sequentially to avoid overloading the device.
 */

import { DatabaseService } from '../storage/database'
import { WhisperService } from './whisper'
import { AudioSlicerService } from '../audio/slicer'
import { BaseService } from '../base'
import type { Clip } from '../storage/database'

// =============================================================================
// Public Interface
// =============================================================================

export interface TranscriptionQueueDeps {
  database: DatabaseService
  whisper: WhisperService
  slicer: AudioSlicerService
}

export type TranscriptionQueueEvents = {
  queued: { clipId: string }
  started: { clipId: string }
  finish: { clipId: string; error?: Error, transcription?: string }
}

// =============================================================================
// Constants
// =============================================================================

const MAX_TRANSCRIPTION_DURATION_MS = 10000  // First 10 seconds of clip
const MAX_START_ATTEMPTS = 3
const RETRY_DELAYS = [5_000, 15_000, 30_000]

// =============================================================================
// Service
// =============================================================================

export class TranscriptionQueueService extends BaseService<TranscriptionQueueEvents> {
  private database: DatabaseService
  private whisper: WhisperService
  private slicer: AudioSlicerService

  private queue: string[] = []
  private processing = false
  private started = false
  private starting: Promise<void> | null = null

  constructor(deps: TranscriptionQueueDeps) {
    super()
    this.database = deps.database
    this.whisper = deps.whisper
    this.slicer = deps.slicer
  }

  async start(): Promise<void> {
    // Every call to start() re-asserts intent, even if initialization is
    // already in flight. This way stop() + start() during init is a no-op:
    // stop() clears the flag, start() sets it back, and doStart() continues.
    this.started = true

    if (this.starting) {
      return this.starting
    }

    this.starting = this.doStart()

    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  stop(): void {
    console.log('[Transcription] Stopping service...')
    this.started = false
    this.queue = []
  }

  queueClip(clipId: string): void {
    if (!this.started) {
      console.log('[Transcription] Service not started, ignoring clip:', clipId)
      return
    }

    console.log('[Transcription] Queueing clip:', clipId)
    this.queue.push(clipId)
    this.emit('queued', { clipId })
    this.processQueue().catch(error => {
      console.error('[Transcription] Queue processing failed:', error)
    })
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async doStart(): Promise<void> {
    console.log('[Transcription] Starting service...')

    let lastError: unknown

    for (let attempt = 0; attempt < MAX_START_ATTEMPTS; attempt++) {
      if (!this.started) return

      try {
        await this.whisper.initialize()
        break
      } catch (error) {
        lastError = error
        console.error(`[Transcription] Start attempt ${attempt + 1}/${MAX_START_ATTEMPTS} failed:`, error)

        if (attempt < MAX_START_ATTEMPTS - 1) {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempt]))
        }
      }
    }

    if (!this.whisper.isReady()) {
      this.started = false
      throw lastError
    }

    // Stopped while initializing
    if (!this.started) return

    const pendingClips = this.database.getClipsNeedingTranscription()
    console.log('[Transcription] Found', pendingClips.length, 'clips needing transcription')

    for (const clip of pendingClips) {
      this.queue.push(clip.id)
    }

    this.processQueue().catch(error => {
      console.error('[Transcription] Queue processing failed:', error)
    })
  }

  private async processQueue(): Promise<void> {
    if (!this.started || this.processing || this.queue.length === 0) {
      return
    }

    if (!this.whisper.isReady()) {
      console.log('[Transcription] Whisper not ready, skipping queue processing')
      return
    }

    this.processing = true

    try {
      while (this.queue.length > 0 && this.started) {
        const clipId = this.queue.shift()!
        await this.processClip(clipId)
      }
    } finally {
      this.processing = false
    }
  }

  private async processClip(clipId: string): Promise<void> {
    console.log('[Transcription] Processing clip:', clipId)

    const clips = this.database.getClipsNeedingTranscription()
    const clip = clips.find((c) => c.id === clipId)

    if (!clip) {
      console.log('[Transcription] Clip not found or already transcribed:', clipId)
      return
    }

    this.emit('started', { clipId })

    let audioPath: string | null = null

    try {
      audioPath = await this.extractClipAudio(clip)

      const transcription = await this.whisper.transcribe(audioPath)

      this.database.updateClip(clipId, { transcription })
      console.log('[Transcription] Completed clip:', clipId, '| Result:', transcription)

      this.emit('finish', { clipId, transcription })

    } catch (error) {
      console.error('[Transcription] Failed to process clip:', clipId, error)
      this.emit('finish', { clipId, error: error as Error })

    } finally {
      if (audioPath) {
        await this.slicer.cleanup(audioPath)
      }
    }
  }

  private async extractClipAudio(clip: Clip): Promise<string> {
    const durationMs = Math.min(clip.duration, MAX_TRANSCRIPTION_DURATION_MS)

    console.log('[Transcription] Extracting audio for transcription:', {
      clipId: clip.id,
      durationMs,
    })

    // Use clip's own audio file as source, extract first N seconds
    const result = await this.slicer.slice({
      sourceUri: clip.uri,
      startMs: 0,
      endMs: durationMs,
      outputPrefix: `transcription_${clip.id}_${Date.now()}`,
    })

    return result.path
  }
}

