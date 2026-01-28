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

export type TranscriptionServiceStatus = 'idle' | 'downloading' | 'processing'

export type TranscriptionQueueEvents = {
  queued: { clipId: string }
  started: { clipId: string }
  finish: { clipId: string; error?: Error, transcription?: string }
  status: { status: TranscriptionServiceStatus }
}

// =============================================================================
// Constants
// =============================================================================

const MAX_TRANSCRIPTION_DURATION_MS = 10000  // First 10 seconds of clip

// =============================================================================
// Service
// =============================================================================

export class TranscriptionQueueService extends BaseService<TranscriptionQueueEvents> {
  private database: DatabaseService
  private whisper: WhisperService
  private slicer: AudioSlicerService

  private queue: string[] = []
  private processing = false
  private downloading = false

  constructor(deps: TranscriptionQueueDeps) {
    super()
    this.database = deps.database
    this.whisper = deps.whisper
    this.slicer = deps.slicer

    this.whisper.on('status', ({ status }) => {
      this.downloading = status === 'downloading'
      this.emitStatus()
    })
  }

  private emitStatus(): void {
    const status: TranscriptionServiceStatus =
      this.downloading ? 'downloading' :
      this.processing ? 'processing' :
      'idle'

    this.emit('status', { status })
  }

  async start(): Promise<void> {
    console.log('[Transcription] Starting service...')

    try {
      await this.whisper.initialize()
    } catch (error) {
      console.error('[Transcription] Failed to initialize Whisper:', error)
      return
    }

    const pendingClips = this.database.getClipsNeedingTranscription()
    console.log('[Transcription] Found', pendingClips.length, 'clips needing transcription')

    for (const clip of pendingClips) {
      this.queue.push(clip.id)
    }

    this.processQueue().catch(error => {
      console.error('[Transcription] Queue processing failed:', error)
    })
  }

  queueClip(clipId: string): void {
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

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return
    }

    if (!this.whisper.isReady()) {
      console.log('[Transcription] Whisper not ready, skipping queue processing')
      return
    }

    this.processing = true
    this.emitStatus()

    try {
      while (this.queue.length > 0) {
        const clipId = this.queue.shift()!
        await this.processClip(clipId)
      }
    } finally {
      this.processing = false
      this.emitStatus()
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
      outputFilename: `transcription_${clip.id}_${Date.now()}.mp3`,
    })

    return result.path
  }
}

