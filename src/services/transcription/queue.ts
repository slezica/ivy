/**
 * Transcription Queue Service
 *
 * Background job queue for automatic clip transcription.
 * Processes clips sequentially to avoid overloading the device.
 */

import { DatabaseService, databaseService } from '../storage/database'
import { WhisperService, whisperService } from './whisper'
import { AudioSlicerService, audioSlicerService } from '../audio/slicer'
import type { Clip } from '../storage/database'

// =============================================================================
// Public Interface
// =============================================================================

export type TranscriptionCallback = (clipId: number, transcription: string) => void

export interface TranscriptionQueueDeps {
  database: DatabaseService
  whisper: WhisperService
  slicer: AudioSlicerService
}

// =============================================================================
// Constants
// =============================================================================

const MAX_TRANSCRIPTION_DURATION_MS = 5000  // First 5 seconds of clip

// =============================================================================
// Service
// =============================================================================

export class TranscriptionQueueService {
  private database: DatabaseService
  private whisper: WhisperService
  private slicer: AudioSlicerService

  private queue: number[] = []
  private processing = false
  private onTranscriptionComplete: TranscriptionCallback | null = null

  constructor(deps: TranscriptionQueueDeps) {
    this.database = deps.database
    this.whisper = deps.whisper
    this.slicer = deps.slicer
  }

  setCallback(callback: TranscriptionCallback): void {
    this.onTranscriptionComplete = callback
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

    this.processQueue()
  }

  queueClip(clipId: number): void {
    console.log('[Transcription] Queueing clip:', clipId)
    this.queue.push(clipId)
    this.processQueue()
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

    while (this.queue.length > 0) {
      const clipId = this.queue.shift()!
      await this.processClip(clipId)
    }

    this.processing = false
  }

  private async processClip(clipId: number): Promise<void> {
    console.log('[Transcription] Processing clip:', clipId)

    const clips = this.database.getClipsNeedingTranscription()
    const clip = clips.find((c) => c.id === clipId)

    if (!clip) {
      console.log('[Transcription] Clip not found or already transcribed:', clipId)
      return
    }

    let audioPath: string | null = null

    try {
      audioPath = await this.extractClipAudio(clip)

      const transcription = await this.whisper.transcribe(audioPath)

      this.database.updateClipTranscription(clipId, transcription)

      if (this.onTranscriptionComplete) {
        this.onTranscriptionComplete(clipId, transcription)
      }

      console.log('[Transcription] Completed clip:', clipId, '| Result:', transcription)
    } catch (error) {
      console.error('[Transcription] Failed to process clip:', clipId, error)
      // Leave transcription as null, will retry on next app start
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
      startMs: clip.start,
      durationMs,
    })

    const result = await this.slicer.slice({
      sourceUri: clip.file_uri,
      startMs: clip.start,
      endMs: clip.start + durationMs,
      outputFilename: `transcription_${clip.id}_${Date.now()}.mp3`,
    })

    return result.path
  }
}

// =============================================================================
// Singleton
// =============================================================================

export const transcriptionService = new TranscriptionQueueService({
  database: databaseService,
  whisper: whisperService,
  slicer: audioSlicerService,
})
